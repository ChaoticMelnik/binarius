# Broker postbacks (#141)

The broker reports a trader's deposit by calling a URL we give it in its cabinet: a **postback**.
This part receives them, journals every delivery and keeps one deposit per payment. It credits
nothing: crediting is #386 (after the token ledger chain), the authenticity check is #142, the
admin's view of deposits is «Депозиты» ([admin-pages.md](admin-pages.md) → Deposits).

## Mechanism

- **The route** `GET /postbacks/binodex/<secret>` exists only while `POSTBACK_URL_SECRET` is set
  on `backend`. The secret is the whole gate until #142: a path segment of 32-100 characters of
  `[A-Za-z0-9_-]` (100 is Fastify's default `maxParamLength`: a longer segment never reaches the
  route), compared as sha256 digests in constant time (`secretMatches`,
  `apps/backend/src/auth/internal.ts`).
- **The writer** is `recordPostback` (`packages/db/src/postback-ops.ts`), one transaction per
  delivery. It writes two tables and nothing else: `postback_deliveries`, the journal, and
  `deposit_events`, one row per payment. No `token_ledger` row, no `users` write, no Telegram
  message, no broker call; every deposit it writes is `received`.
- **The query** is classified by `classifyPostback` (`packages/shared/src/postback.ts`), a pure
  function with a fixed order of refusals: `id` → `event` → `payment_id` → `a` → `amount`. An
  empty value counts as absent. `amount` must be a positive decimal that fits `numeric(20,8)`
  (at most 12 integer and 8 fraction digits, no exponent, no separator); it never becomes a JS
  number. `coin` is stored as delivered in `currency` (NULL when absent), even when it is not
  `USD`; `pay_currency`, `pay_amount` and every other macro stay in the journal's payload only.

The cabinet's macro table has no action variable, so a Deposit delivery and an FTD delivery are
told apart only by the `event` parameter each one's URL template carries (`event=deposit` /
`event=ftd`, see the cabinet setup below).

## The keys

| Key | Index | What it stops |
|---|---|---|
| one delivery per `(source, postback_id)` | `postback_deliveries_source_postback_idx`, partial `where outcome <> 'rejected'` | a re-delivery of the same postback writing a second row; a refused delivery takes no slot, so a corrected re-send with the same id is recorded |
| one deposit per `(source, payment_id)` | `deposit_events_source_payment_idx` | the Deposit and the FTD postback of one payment, or a re-send with a new id, making two deposits |
| one bonus per deposit | `token_ledger_deposit_event_idx` (existing) | #386 crediting one deposit twice |

So "a repeat creates no second credit" holds by construction before anything credits: a repeat is
either the same postback id (no second delivery row, no second deposit) or another id of the same
payment (a second delivery row, the same deposit row). Two concurrent deliveries are settled by
the indexes, not by the pre-check read (`postback-ops.db.test.ts` P3).

## Outcomes

| Delivery | Journal | Deposit | Answer |
|---|---|---|---|
| a new payment | `recorded` | inserted | 200 `{"outcome":"recorded"}` |
| another postback id of a known payment (FTD after Deposit, a re-send) | `repeated` | unchanged | 200 `{"outcome":"repeated"}` |
| a postback id already recorded | nothing | nothing | 200 `{"outcome":"duplicate"}` |
| a refused query | `rejected` + reason | nothing | 200 `{"outcome":"rejected","reason":"…"}` |

Reasons: `missing_postback_id`, `unknown_event`, `missing_payment_id`, `missing_trader_id`,
`invalid_amount`. A refused row keeps the query as received, so a misconfigured cabinet template
shows up in `deposit list`, not only in a log.

A `repeated` delivery whose amount (compared as decimals: `10.5` equals `10.50000000`) or trader
id differs from the stored deposit keeps the stored row as it is and logs one `warn`
`postback repeated with different fields` with the deposit id, the postback id and the names of the
fields (`mismatch: ["amount"]`) — never the values.

A postback id the journal already holds for **another** payment answers `duplicate` and writes
nothing; when two such deliveries race, the one that loses the journal's index rolls its deposit
back.

## The route and its answers

| Request | Answer | Journaled |
|---|---|---|
| GET with the right secret, a flat query | 200 with the outcome above | yes, except `duplicate` |
| GET with the right secret, a repeated key (`a=1&a=2`), more than 64 keys, a key over 64 or a value over 256 characters, a NUL (`%00`) in a key or a value | 400 `{"error":"validation"}` | no |
| a wrong secret | 404 `{"error":"not_found"}`, one `warn` `postback refused`; takes no slot of the window | no |
| the route off (`POSTBACK_URL_SECRET` unset) | 404 `{"error":"not_found"}` from the not-found handler | no |
| a segment over 100 characters or with a malformed percent-encoding (`%ZZ`), route on or off | 404 `{"error":"not_found"}`: Fastify's router answers these itself (414 / 400, echoing the path), and `frameworkErrors` in `buildApp` turns both into the not-found answer | no |
| HEAD with the right secret | 404 from the not-found handler (`exposeHeadRoute: false`) | no |
| any other method | 404 | no |
| past the secret, over `POSTBACK_MAX_PER_MINUTE` (600 per process) | 429 `{"error":"too_many_requests"}` | no |
| a database failure | 500 `{"error":"internal"}` | rolled back |

Everything past the secret answers 200, so a broker that retries on a non-2xx has nothing to retry
but a `duplicate`. The broker's own reaction to 4xx, 429 and 500 is unknown. A wrong secret, a
segment of any length or spelling and a route that is off answer the same 404 body: a probe cannot
tell them apart. The window is taken only past the secret, so a flood without it cannot crowd out
the broker's deliveries; it bounds the writes of a holder of the secret.

Logs: one `info` `postback received` per delivery with the outcome, the reason, the event and the
postback id. The secret never enters our lines; Fastify's own lines (the request line, the
not-found line) carry the url through `withoutSecrets` (`apps/backend/src/app.ts`), which replaces
everything after the first `/postbacks` (any case) up to the query with `/redacted`: a logged url
of this family reads `/postbacks/redacted?…`, whatever the template's typo (a doubled slash, an
encoded `%2F`). A wrong-secret request writes one `warn` line and no row; a flood of them is
bounded only by Caddy and the host (accepted: at pilot traffic under 1 MB of log a day — if the
log shows more, a refusal counter that logs once per window is the fix).

## Attribution

A deposit belongs to the account whose `broker_user_id` equals the postback's trader id (`a`), and
`deposit_events_account_trader_fk` holds every attributed row to that account; with
`deposit_events_account_owner_fk` the owner is that account's user.

- **At ingest:** the writer reads the account by `broker_user_id` `FOR SHARE` and attributes the
  deposit when the account's status is not `pending` (`active` or `revoked`: it was confirmed
  once). A `pending` account is an unconfirmed claim and must not put someone's deposit on another
  user's card, and a trader with no account has no owner yet: both rows keep only
  `broker_user_id`.
- **At activation:** `attachDepositsToAccount` runs in the two activation transactions — the bot's
  confirm (`confirmBrokerAccount`) and the email login (`linkBrokerAccount` with `activate`) —
  and attaches every unowned deposit of that trader in one `UPDATE`. Nothing is credited at
  attachment either.

Lock order: ingest takes `broker_accounts` `FOR SHARE`, then `deposit_events`, then the journal;
activation takes `users` → `broker_accounts` (`FOR NO KEY UPDATE`) → `deposit_events`. The
`FOR SHARE` waits for a confirm in flight and then reads the status it committed
(`postback-ops.db.test.ts` P5), so a confirm cannot leave a deposit behind.

**Accepted window:** a postback for a trader who has **no account row at all** while the email
login inserts and activates that account in one transaction can commit after the attach `UPDATE`
ran; that deposit stays without an owner. At pilot volume (1-3k accounts, a few deposits a day)
the two overlapping is expected 0 times; such a row shows in «Депозиты» with «—» for the owner and
its trader id, and is attached by hand or by #386's tooling.

## Visibility

- Deposits: the admin page «Депозиты» and the user card's «Депозиты» section
  ([admin-pages.md](admin-pages.md)); the trader id column identifies an unowned deposit.
- The journal, with every refusal and every payload, is read with the CLI (read-only):

```bash
docker compose exec backend pnpm --filter @binarius/backend deposit list
docker compose exec backend pnpm --filter @binarius/backend deposit list --limit 100
docker compose exec backend pnpm --filter @binarius/backend deposit show <payment_id>
```

`list` prints the newest deliveries (1-200, default 20): time, event, postback id, outcome and
reason, and the payment id, trader id and amount as delivered. On an empty journal it prints
«Доставок нет. Депозиты — на странице /admin/deposits.». `show` prints the payment's deposit
(trader, amount, currency, status, the owner's Telegram id, the account) and each of its deliveries
— refused ones that named the payment included — with every query key and value. A control
character in a value prints as `?`. An unknown payment exits 1; a usage error exits 2.

## Configuration

`POSTBACK_URL_SECRET` (`.env`, `backend` only — it is not in the shared broker anchor, so the
worker never receives it): unset, the route does not exist; empty or outside the pattern, the
backend refuses to start. Generate it with `openssl rand -hex 32`. Rotating it means the value in
`.env` and both cabinet templates. The start log line `postback route` carries `enabled`.

A leaked secret lets anyone write journal rows at up to 600 a minute and `received` deposits
(nothing is credited); rotate it.

### The Caddy route (owner's step on the host)

The pilot's Caddy proxies the domain to `web` only; the backend listens on 127.0.0.1:3000. The
site block gains a `handle` for `/postbacks/*` (validated with `caddy validate` on the host's
version, 2.6.2):

```
binarius.salescreativesads.com {
    handle /postbacks/* {
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        reverse_proxy 127.0.0.1:3001
    }
}
```

then `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl
reload caddy`. The backend becomes public for `/postbacks/*` only:
`curl -s https://binarius.salescreativesads.com/postbacks/binodex/wrong` prints
`{"error":"not_found"}` (the backend's JSON; web's 404 is an HTML page), and
`curl -s -o /dev/null -w '%{http_code}\n' https://binarius.salescreativesads.com/health` stays
web's 404. When `deploy/Caddyfile` exists (#146), the same `handle` block goes there.

### The cabinet setup (owner's step)

In the broker's cabinet (`/admin/postbacks`), two postbacks, action **Deposit** and action
**FTD**, each with one line:

```
https://binarius.salescreativesads.com/postbacks/binodex/<SECRET>?event=deposit&id={id}&payment_id={payment_id}&a={a}&amount={amount}&coin={coin}&date_time={date_time}&sub_id={sub_id}&company_id={company_id}&pay_currency={pay_currency}&pay_amount={pay_amount}
```

and the same with `event=ftd`. Only `a`, `sub_id` and `company_id` are on by default: switch on
`id`, `payment_id`, `amount`, `coin` and `date_time`. If the form offers an HTTP method: GET.

## Migration

`0041_postbacks` reshapes `deposit_events` (new `NOT NULL` columns without defaults, `postback_id`
and `payload` dropped) and starts with a guard: it raises
`deposit_events must be empty before 0041_postbacks (#141)` when the table has rows, and nothing
of 0041 is applied. `pnpm db:migrate` then exits 1 without printing that text (drizzle-kit 0.31
swallows it, checked 2026-10-10); the count below is how to tell. Before #141 nothing wrote the table, so only rows inserted by hand can be
there — the old local check of «Депозиты» inserted `postback_id` `pb-local` and `pb-local-2`.
Before deploying, on the pilot and on any local volume where that check ran:

```bash
docker compose exec postgres psql -U binarius -d binarius -c "select count(*), count(*) filter (where postback_id like 'pb-local%') from deposit_events"
```

Both 0: deploy. Equal and not 0: delete them (no ledger row references them — nothing credits
before #386), then deploy:

```bash
docker compose exec postgres psql -U binarius -d binarius -c "delete from deposit_events where postback_id like 'pb-local%'"
```

Any other row: stop and report — the guard will refuse the migration. The guard is pinned by
`packages/db/src/postbacks-migration.db.test.ts` (G1: a row stops 0041 and leaves the schema as it
was; G2: an empty table migrates).

## Observed live

Pending the first live postback (owner's step after the cabinet setup): a small deposit on the
test account, then `deposit list` and `deposit show <payment_id>`. To record here: the outcome and
reason of each delivery, whether the owner was filled (that `a` is the `broker_user_id` the OAuth
exchange stores is an assumption until then), which macros arrived, whether both actions fired for
one payment, and the HTTP method if the cabinet shows it.

## Boundaries

- Crediting — #386 (the rule params are recorded there; the rule stays inactive).
- Authenticity of a postback (signature or another server mechanism) — #142; until then automatic
  crediting stays off.
- Reconciliation of deposits with the broker — #140; end-to-end duplicate scenarios — #106.
- A Caddyfile in the repository — #146.
