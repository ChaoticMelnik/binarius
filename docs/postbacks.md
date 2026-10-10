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
shows up in the journal (`postback_deliveries`, see Visibility), not only in a log.

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
not-found line, the proxy guard's line) carry the url through `withoutSecrets`
(`apps/backend/src/app.ts`). It splits the url at the first raw `?`, decodes the path until it is
stable (at most 4 passes) and replaces everything after the first `/postbacks` (any case) with
`/redacted`, a decoded `?` or `#` included: a logged url of this family reads
`/postbacks/redacted?…` for any spelling of the path, percent-encoding (`/p%6Fstbacks/…`, which the
router does route here), doubled slashes and `%2F` included. A path that cannot be decoded, or is
still changing after 4 passes, is logged as `/redacted`. A secret that lands in the query string
(a template typo) is not masked. A wrong-secret request writes one `warn` line and no row; a flood of them is
bounded only by Caddy and the host (accepted: at pilot traffic under 1 MB of log a day — if the
log shows more, a refusal counter that logs once per window is the fix).

### The proxy guard

The backend answers a request that came through a reverse proxy only on the postback route.
`buildApp` registers a root `onRequest` hook ahead of every route plugin: a request carrying any of
`X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` or `Forwarded` gets the not-found answer
(404 `{"error":"not_found"}`, one `warn` `proxied request refused`) on every route except the one
marked `config: { publicThroughProxy: true }` — `GET /postbacks/binodex/:secret`, the only such
route. Why: Caddy's path matcher sees the decoded, cleaned path while the backend routes the raw
one, so a `/postbacks/*` matcher let `/admin/users/..%2F..%2F..%2Fpostbacks%2Fx` through to
`/admin/users/:id` (review round 2 of PR #442). Whatever a matcher lets through, only the
postback route answers. Caddy sets `X-Forwarded-For` on every request it forwards and replaces a
client's value (probed on 2.6.2, 2026-10-10); no internal caller (bot, web, worker, the compose
healthcheck) sends any of these headers. A future internal caller that forwards one would be
refused; the fix then is a decision about that header, not removing the guard.
`apps/backend/src/postbacks/routes.db.test.ts` → «the proxy guard» runs every registered route.

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
- Each delivery writes one `postback received` line to the backend's log (outcome, reason,
  event, postback id): `docker compose logs backend | grep 'postback received'`.
- The journal, with every refusal and every payload, is read with `psql` — the newest deliveries,
  then every delivery that named one payment:

```bash
docker compose exec postgres psql -U binarius -d binarius -c "select created_at, event, postback_id, outcome, reject_reason, payload->>'payment_id' as payment_id, payload->>'a' as trader_id, payload->>'amount' as amount from postback_deliveries order by created_at desc limit 20"
docker compose exec postgres psql -U binarius -d binarius -c "select created_at, outcome, reject_reason, payload from postback_deliveries where payload->>'payment_id' = '<payment_id>' order by created_at"
```

A read-only CLI for the journal comes back with #443.

## Configuration

`POSTBACK_URL_SECRET` (`.env`, `backend` only — it is not in the shared broker anchor, so the
worker never receives it): unset, the route does not exist; empty or outside the pattern, the
backend refuses to start. Generate it with `openssl rand -hex 32`. Rotating it means the value in
`.env` and both cabinet templates. The start log line `postback route` carries `enabled`.

A leaked secret lets anyone write journal rows at up to 600 a minute and `received` deposits
(nothing is credited); rotate it.

### The Caddy route (owner's step on the host)

The pilot's Caddy proxies the domain to `web` only; the backend listens on 127.0.0.1:3000. The
site block gains a named matcher on the **raw** request URI:

```
binarius.salescreativesads.com {
    @postback {
        method GET
        expression `{http.request.orig_uri}.matches("^/postbacks/binodex/[A-Za-z0-9_-]+([?].*)?$")`
    }
    handle @postback {
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        reverse_proxy 127.0.0.1:3001
    }
}
```

Why not `handle /postbacks/*`: `path` and `path_regexp` match Caddy's unescaped, cleaned path,
while `reverse_proxy` forwards the raw URI, so `/admin/users/..%2F..%2F..%2Fpostbacks%2Fx` matched
`/postbacks/*` and reached `/admin/users/:id`. `{http.request.orig_uri}` is the raw request target:
the expression admits only the exact prefix, one segment of the secret's alphabet and an optional
query, so `%`, `.`, `/` and another case never reach the backend; `method GET` keeps HEAD and every
other method on web. The length bound stays the backend's (32-100). Probed on a `caddy:2.6.2`
container against a Fastify 5.12.5 echo upstream (2026-10-10): the traversals through
`/admin/users/:id`, `/trading/intents/:id` and `POST /admin/sessions/:id/revoke`, `%2f` lower case,
`/p%6Fstbacks/…`, `//postbacks/…`, `/POSTBACKS/…`, `..` and `%2e%2e` forms, absolute-form targets,
HEAD and POST all went to web; `/postbacks/binodex/<secret>` with and without a query went to the
backend. The backend's proxy guard (above) holds even where a matcher would not.

Then `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl
reload caddy`, and the checks (each `curl` from anywhere):

```bash
curl -s https://binarius.salescreativesads.com/postbacks/binodex/wrong
# {"error":"not_found"} - the backend's JSON
curl -s --path-as-is 'https://binarius.salescreativesads.com/admin/users/..%2F..%2F..%2Fpostbacks%2Fx' | grep -c '"error"'
# 0 - web's page; a backend JSON {"error":...} means exposed: revert the Caddy edit and report
curl -s --path-as-is 'https://binarius.salescreativesads.com/p%6Fstbacks/binodex/wrong' | grep -c '"error"'
# 0
curl -s -o /dev/null -w '%{http_code}\n' https://binarius.salescreativesads.com/health
# web's 404
```

When `deploy/Caddyfile` exists (#146), the same block goes there.

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
test account, then «Депозиты», the `postback received` lines and the two selects of
Visibility. To record here: the outcome and
reason of each delivery, whether the owner was filled (that `a` is the `broker_user_id` the OAuth
exchange stores is an assumption until then), which macros arrived, whether both actions fired for
one payment, and the HTTP method if the cabinet shows it.

## Boundaries

- Crediting — #386 (the rule params are recorded there; the rule stays inactive).
- Authenticity of a postback (signature or another server mechanism) — #142; until then automatic
  crediting stays off.
- Reconciliation of deposits with the broker — #140; end-to-end duplicate scenarios — #106.
- A Caddyfile in the repository — #146.
- A CLI for the journal — #443.
