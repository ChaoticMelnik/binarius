# Broker postbacks (#141)

The broker reports a trader's deposit by calling a URL we give it in its cabinet: a **postback**.
This part receives them, journals every delivery and keeps one deposit per payment. It credits
nothing: crediting is #386 (after the token ledger chain), the URL secret is the authenticity
mechanism (#142, Authenticity below), the admin's view of deposits is «Депозиты»
([admin-pages.md](admin-pages.md) → Deposits).

## Mechanism

- **The route** `GET /postbacks/binodex/<secret>` exists only while `POSTBACK_URL_SECRET` is set
  on `backend`. The secret is the authenticity mechanism (Authenticity below): the current one,
  and the previous one while a rotation lasts. Each is a path segment of 32-100 characters of
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

## Authenticity (#142)

The owner's decision (2026-10-29): we do not wait for Binodex to confirm a signature or another
mechanism of theirs. A delivery is authentic when its path segment matches one of the configured
secrets — `POSTBACK_URL_SECRET`, or `POSTBACK_URL_SECRET_PREVIOUS` while a rotation lasts
(Rotation below); nothing else is checked. A broker signature, if Binodex adds one, is a separate
task.

What is recorded:

- `postback_deliveries.secret_key_id` — which secret admitted the delivery: the first 8 hex of its
  sha256 (`secretKeyId`, `apps/backend/src/auth/internal.ts`; CHECK
  `postback_deliveries_secret_key_id_check`). Written on every journal row (`recorded`, `repeated`,
  `rejected`); NULL on rows journaled before 0087. The key id names a secret without revealing it:
  `printf %s "$SECRET" | sha256sum | cut -c1-8` (macOS: `shasum -a 256`).
- `deposit_events.verification` — how the delivery that created the row was authenticated:
  `url_secret` on every row `recordPostback` creates (CHECK `deposit_events_verification_check`
  from `DepositVerification`). A `repeated` delivery does not change it. NULL means no
  authenticated receipt wrote the row (an insert by hand); nothing in the code writes NULL or
  updates the column.

Who reads it: the switch to real after a deposit (#686) lists only rows with `verification`
(`listDepositsAwaitingModeSwitch`). The contract for crediting (#386, not built yet): an automatic
credit happens only for a row `recordPostback` returned as `recorded`, and its compare-and-set is
`status = received and verification is not null` under the row lock; whether a staff member's
manual credit sets `verification` or goes around it is #386's decision.

What the mechanism does not cover: a leaked secret (Rotation below); a compromise of the broker's
cabinet itself, which is beyond our means; the broker's source IPs and the partner id `sub_id` are
not confirmed by Binodex, so neither is checked — refusing on them could lose real deposits, and
`sub_id` stays in the journal's payload for a later comparison.

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
| GET with the previous secret while `POSTBACK_URL_SECRET_PREVIOUS` is set | as with the current one; the journal row carries its key id | as above |
| a wrong secret (a retired previous one included) | 404 `{"error":"not_found"}`, one `warn` `postback refused` with `presentedKeyId`, the key id of the presented value; takes no slot of the window | no |
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

Logs: one `info` `postback received` per delivery with the outcome, the reason, the event, the
postback id and `secretKeyId`, the key id of the secret that admitted it; the start line
`postback route` carries `enabled` and `secretKeyIds` (the current secret's key id, then the
previous one's; `[]` with the route off). The secret never enters our lines; Fastify's own lines
(the request line, the not-found line, the proxy guard's line) carry the url through
`withoutSecrets` (`apps/backend/src/app.ts`). It splits the url at the first raw `?`, decodes the
path until it is stable (at most 4 passes) and replaces everything after the first `/postbacks`
(any case) with `/redacted`, a decoded `?` or `#` included: a logged url of this family reads
`/postbacks/redacted?…` for any spelling of the path, percent-encoding (`/p%6Fstbacks/…`, which the
router does route here), doubled slashes and `%2F` included. A path that cannot be decoded, or is
still changing after 4 passes, is logged as `/redacted`. A secret that lands in the query string
(a template typo) is not masked. A wrong-secret request writes one `warn` line (with the presented
value's key id) and no row; a flood of them is bounded only by Caddy and the host (accepted: at pilot traffic under 1 MB of log a day — if the
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

### The trading mode after a deposit (#686)

An attributed row is what switches its user from demo to real
([trading-mode.md](trading-mode.md#the-automatic-switch-after-a-deposit-686)): the backend's pass
lists the rows with `user_id`, `verification` (Authenticity above) and no `mode_switch`, whichever
way they got the owner (at ingest or at activation), and writes one outcome per row
(`mode_switch`, `mode_switch_at`; `deposit_events_mode_switch_check`,
`deposit_events_mode_switch_pair_check`). The writer of this page does not change: ingest still takes no `users` lock and writes neither the mode nor the
outcome. One row per payment, so the Deposit and the FTD postback of one payment switch at most
once. A deposit attributed to a `revoked` account is closed `account_inactive`. 0075 closed every row
already there as `predates`. Crediting (#386) reads `status`/`processed_at`, which the switch never
writes.

## Visibility

- Deposits: the admin page «Депозиты» and the user card's «Депозиты» section
  ([admin-pages.md](admin-pages.md)); the trader id column identifies an unowned deposit.
- Each delivery writes one `postback received` line to the backend's log (outcome, reason,
  event, postback id, secret key id): `docker compose logs backend | grep 'postback received'`.
- The journal, with every refusal and every payload, is read with `psql` — the newest deliveries,
  then every delivery that named one payment:

```bash
docker compose exec postgres psql -U binarius -d binarius -c "select created_at, event, postback_id, outcome, reject_reason, payload->>'payment_id' as payment_id, payload->>'a' as trader_id, payload->>'amount' as amount from postback_deliveries order by created_at desc limit 20"
docker compose exec postgres psql -U binarius -d binarius -c "select created_at, outcome, reject_reason, payload from postback_deliveries where payload->>'payment_id' = '<payment_id>' order by created_at"
```

Which secrets the cabinet uses (during a rotation: has the new key id arrived, does the old one
still come):

```bash
docker compose exec postgres psql -U binarius -d binarius -c "select secret_key_id, count(*), max(created_at) from postback_deliveries where created_at > now() - interval '30 days' group by 1"
```

A read-only CLI for the journal comes back with #443.

## Configuration

`POSTBACK_URL_SECRET` (`.env`, `backend` only — it is not in the shared broker anchor, so the
worker never receives it): unset, the route does not exist; empty or outside the pattern, the
backend refuses to start. Generate it with `openssl rand -hex 32`. The start log line
`postback route` carries `enabled` and `secretKeyIds`.

`POSTBACK_URL_SECRET_PREVIOUS` (`.env`, `backend` only, the same pattern): the previous secret,
accepted beside the current one while it is set. Equal to `POSTBACK_URL_SECRET`, or set without
it, the backend refuses to start.

A leaked secret lets anyone write journal rows at up to 600 a minute and `received` deposits
(nothing is credited); rotate it (below).

### Rotation

Both secrets are accepted while the cabinet's templates are rewritten, so no delivery is refused
on the way:

1. In `.env`: `POSTBACK_URL_SECRET_PREVIOUS=<the current value>`,
   `POSTBACK_URL_SECRET=<a new value>` (`openssl rand -hex 32`); `docker compose up -d backend`.
   The start line `postback route` shows `secretKeyIds: [<new>, <old>]`
   (`docker compose logs backend | grep 'postback route'`).
2. Rewrite both cabinet templates (The cabinet setup below) with the new secret.
3. Wait for a delivery with the new key id in the journal (the select in Visibility), or make a
   test deposit.
4. Remove `POSTBACK_URL_SECRET_PREVIOUS` from `.env`; `docker compose up -d backend`. From now on
   the old secret answers 404 and logs `postback refused` with its key id as `presentedKeyId`:
   seeing that key id means a template still carries it.

A key id is computed from a value with `printf %s "$VALUE" | sha256sum | cut -c1-8` (macOS:
`shasum -a 256`). Each restart cuts the deliveries in flight, as any restart of `backend` does.
There is no deadline on the previous secret: a forgotten one shows in every `postback route`
line.

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

The same block is in [`deploy/Caddyfile`](../deploy/Caddyfile), the example of the whole site
the live file repeats (docs/deploy.md -> HTTPS).

### The cabinet setup (owner's step)

In the broker's cabinet (`/admin/postbacks`), two postbacks, action **Deposit** and action
**FTD**, each with one line:

```
https://binarius.salescreativesads.com/postbacks/binodex/<SECRET>?event=deposit&id={id}&payment_id={payment_id}&a={a}&amount={amount}&coin={coin}&date_time={date_time}&sub_id={sub_id}&company_id={company_id}&pay_currency={pay_currency}&pay_amount={pay_amount}
```

and the same with `event=ftd`. Only `a`, `sub_id` and `company_id` are on by default: switch on
`id`, `payment_id`, `amount`, `coin` and `date_time`. If the form offers an HTTP method: GET.

## Migration

`0044_postbacks` reshapes `deposit_events` (new `NOT NULL` columns without defaults, `postback_id`
and `payload` dropped) and starts with a guard: it raises
`deposit_events must be empty before 0044_postbacks (#141)` when the table has rows, and nothing
of 0044 is applied. `pnpm db:migrate` then exits 1 with `migration failed: Error, cause error
P0001` — the runner prints an error's name and code, never its text (Rule 8); the count below is
how to tell. Before #141 nothing wrote the table, so only rows inserted by hand can be
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
`packages/db/src/postbacks-migration.db.test.ts` (G1: a row stops 0044 and leaves the schema as it
was; G2: an empty table migrates).

### 0087_postback_verification

Adds `deposit_events.verification` and `postback_deliveries.secret_key_id` with their CHECKs
(Authenticity above) and sets `verification = 'url_secret'` on every deposit already there: until
0087 the only writer of the table was `recordPostback` behind the secret. Journal rows before it
keep `secret_key_id` NULL. No precondition. After the deploy:

```bash
docker compose exec postgres psql -U binarius -d binarius -c "select count(*) filter (where verification is null), count(*) from deposit_events"
```

`0 | N` is expected. Pinned by `packages/db/src/postback-verification-migration.db.test.ts`
(PV1-PV4).

## Observed live

Pending the first live postback (owner's step after the cabinet setup): a small deposit on the
test account, then «Депозиты», the `postback received` lines and the selects of Visibility. To
record here: the outcome and reason of each delivery and the `secret_key_id` of the journal row,
whether the owner was filled (that `a` is the `broker_user_id` the OAuth exchange stores is an
assumption until then), which macros arrived, whether both actions fired for
one payment, and the HTTP method if the cabinet shows it.

## Boundaries

- Crediting — #386 (the rule params are recorded there; the rule stays inactive).
- Crediting reads `verification` too: #386 credits only a row with it (Authenticity).
- The switch to real after a deposit — #686 (above); it lists only rows with `verification`.
- Authenticity — the URL secret (Authenticity above); a broker signature, if Binodex adds one — a
  separate task.
- Reconciliation of deposits with the broker — #140; end-to-end duplicate scenarios — #106.
- The Caddyfile in the repository — [`deploy/Caddyfile`](../deploy/Caddyfile) (#146).
- A CLI for the journal — #443.
