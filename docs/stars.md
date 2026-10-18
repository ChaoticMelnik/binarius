# Buying tokens for Telegram Stars (#117), refunds and /paysupport (#118)

A user with an active Binodex account buys a package of automation tokens in the bot and pays in
Telegram Stars. A payment credits its tokens exactly once, whoever reports it: the bot's
`successful_payment`, its retry, or the reconciler. A staff member refunds a payment with
`stars refund`; the user asks for one from `/paysupport` ([Refunds](#refunds),
[/paysupport](#paysupport)).

## Packages

`STAR_PACKAGES` in `packages/shared/src/stars.ts`, changed by a deploy:

| Code | Tokens | Stars |
|---|---|---|
| `p50` | 50 | 100 |
| `p150` | 150 | 250 |
| `p500` | 500 | 750 |

Each payment row freezes the package code, the amount Telegram reported and the tokens it was
credited with, so a deploy that changes the table rewrites no past purchase. A package removed
between the invoice and the payment is held, not credited (below).

## The flow

1. **Entries.** `/buy` (the command menu, after `/account`), «⭐ Купить токены» under the status card
   in both modes, and under both `insufficient_tokens` refusals (the single trade, the session). The
   screen reads `/users/account` as `/account` does: no users row, or no `active` account →
   `buyNeedsAccount` with the connect button; a blocked user → `blocked`; otherwise `buyScreen`
   with a button per package (`buy:<code>`) and «🏠 В меню». The 80 % / 100 % low-token nudges
   (#123) carry it as their second row ([mailing.md](mailing.md) → The low-token nudge).
2. **Invoice.** A package press → `POST /payments/stars/invoice` → `sendInvoice` through
   `replyWithInvoiceStars` (`apps/bot/src/send.ts`): currency `XTR`, no provider token, one price,
   title and description from the catalog (plain, ≤ 32 / ≤ 255 characters), the payload
   `stars:<code>:<users.id>` (≤ 128 bytes, the Bot API's limit; parsed by
   `parseStarsInvoicePayload` only), the pay button first and «🏠 В меню» after it. No
   `start_parameter`: a forwarded invoice keeps its Pay button, which is why the credit checks the
   payer.
3. **Pre-checkout.** Telegram asks before it charges (`pre_checkout_query`, in `ALLOWED_UPDATES`
   since #117). The bot asks `POST /payments/stars/pre-checkout` and answers `ok: true` only on the
   backend's yes; a refusal and any failure of the call (timeout, 5xx, a body outside the contract)
   answer `ok: false` with `starsPreCheckoutRefused` / `starsPreCheckoutFailed`. A refused purchase
   is never charged.
4. **Payment.** `message:successful_payment` → `POST /payments/stars/paid` with the charge ids, the
   payload, the currency, the amount and the message's `date`. The answer:
   `credited` / `already_credited` → «⭐ Начислено N токенов. Баланс: M» with «🏠 В меню»; `held`,
   or a 409 `payload_unknown` → `starsHeld` with the support link; any other failure →
   `starsPending` («токены начислятся в течение нескольких минут»): the reconciler settles it, and
   the bot never re-reads to guess.

## Routes (`apps/backend/src/payments/routes.ts`)

Internal bearer, scoped by the Telegram id in the body. None reads `DEMO_ONLY` (Rule 33: a payment
the user confirms in Telegram is not a broker operation).

| Route | Answers | Writes |
|---|---|---|
| `POST /payments/stars/invoice` `{ telegramUserId, packageCode }` | 200 `{ payload, package }`; 404 `user_not_found`; 409 `user_blocked`, `no_active_account`, `package_unknown` | nothing |
| `POST /payments/stars/pre-checkout` `{ telegramUserId, invoicePayload, currency, totalAmount }` | 200 `{ ok: true }` or `{ ok: false, reason }`: `payload`, `package`, `currency`, `amount`, `user_not_found`, `payer` (the payload names another user), `user_blocked`, `no_active_account` | nothing |
| `POST /payments/stars/paid` `{ telegramUserId, telegramPaymentChargeId, providerPaymentChargeId, invoicePayload, currency, totalAmount, paidAt }` | 200 `{ outcome: credited \| already_credited, tokens, balance }` or `{ outcome: held }`; 409 `payload_unknown` (not ours, or no users row: no row can own it; logged by the charge id and the amount only) | the credit below |
| `POST /payments/stars/list` `{ telegramUserId }` (#118) | 200 `{ payments: [{ id, paidAt, packageCode, totalAmount, status, requested }] }`, at most 5, newest first, by `payer_telegram_user_id`; a Telegram id with no users row is allowed | nothing |
| `POST /payments/stars/refund-request` `{ telegramUserId, paymentId }` (#118) | 200 `{ outcome: requested \| already_requested }`; 404 `payment_not_found` (no such payment, or another payer's — not told apart, Rule 13); 409 `already_refunded` | one `star_refund_requests` row and its audit row, then the staff notice |

Every 4xx of the invoice comes before any side effect, so the package screen stays and a press is
the retry. The pre-checkout's budget is `STARS_PRECHECKOUT_BUDGET_MS` (2 s), its reads only.

## The credit (`packages/db/src/star-payment-ops.ts`)

`creditStarPayment(tx, payment)` is the only writer that inserts `star_payments` rows and of the
Stars purchase rows of the ledger, and the sixth writer of the balance cache (Rule 2); the refund is
`recordStarRefund`'s ([Refunds](#refunds)). It records the payer
(`payer_telegram_user_id`) on every row. In one transaction:

1. the payload's `users` row `FOR NO KEY UPDATE` (Rule 5's first link);
2. the checks, first failure wins: currency `XTR`, the package exists, the amount is the package's
   price, the payer's Telegram id is the payload user's. They decide the status of the row below;
3. `insert into star_payments … on conflict (telegram_payment_charge_id) do nothing`;
   no row inserted → `already_recorded` with the stored status (the route answers `paid` as
   `already_credited`, anything else as `held`), nothing else written;
4. a failed check: the row is `held` (no ledger row, `tokens` the package's or NULL) with one
   `audit_log` row `stars_payment_held` naming the reason; a staff member resolves it (#118);
5. otherwise: the row `paid`, a `token_ledger` row `purchase` naming `star_payment_id`,
   `users.token_balance += tokens`, and one `audit_log` row `stars_purchased`. The audit payload
   carries ids, the package, the amount and `via` (`bot` or `reconciler`). The audit row's actor
   is the payer.

A blocked user, or one whose account was revoked after the pre-checkout, is still credited: the
user paid (the owner's decision of 2026-10-08).

### The tables

- `star_payments`: `telegram_payment_charge_id` unique (`star_payments_charge_key`, 1-255
  characters), `provider_payment_charge_id` (NULL from the reconciler), `payer_telegram_user_id`
  (`> 0`, NOT NULL; #118's 0048 backfilled it from each row's `stars_purchased` /
  `stars_payment_held` audit row and fails on a row without one), `package_code`, `currency`,
  `total_amount > 0`, `tokens` (NULL or > 0), `status` (`paid` | `held` | `refunded`, CHECK from
  `StarPaymentStatus`), `paid_at` (Telegram's clock, no CHECK against `created_at`), `refunded_at`
  (set iff `refunded`), `created_at`; a `paid` row has tokens and currency `XTR`
  (`star_payments_paid_check`); `(id, user_id)` unique, the target of the ledger's FK.
- `token_ledger.star_payment_id` with `token_ledger_star_payment_owner_fk (star_payment_id,
  user_id)` (Rule 4); `token_ledger_reference_check`: a `purchase` names exactly one of a deposit
  and a Stars payment and nothing else, every other kind names no Stars payment;
  `token_ledger_star_payment_idx` unique `(star_payment_id, kind)` — one purchase and one refund
  per payment. A `refund` names exactly its Stars payment (`token_ledger_reference_check`) and has
  `balance_delta < 0`, `reserved_delta = 0` (`token_ledger_delta_shape_check`).
- `star_refund_requests` (#118): `star_payment_id` unique (`star_refund_requests_payment_key`), FK
  to `star_payments` on delete restrict, `requested_by_telegram_user_id > 0`, `requested_at`. No
  writer updates or deletes a row; no trigger enforces that. A request is a notice: its resolution
  is the payment's status.
- The admin ledger page prints the payment's id as the row's reference
  ([admin-pages.md](admin-pages.md)).

## Reconciliation (`apps/backend/src/payments/star-reconciler.ts`)

The bot polls, and grammY confirms an update's offset even when its handler failed: a
`successful_payment` whose report never reached the backend is never delivered again. The
reconciler is the only protection against that paid-but-not-credited case.

- Every `STARS_RECONCILE_TICK_MS` (5 min), started after `listen()`, stopped in phase 1.
- `getStarTransactions` on the public bot's token (`STARS_TELEGRAM_API_TIMEOUT_MS`, 3 s a call),
  from offset 0 in pages of 100 until a short page, at most `STARS_RECONCILE_MAX_PAGES` (50) a
  tick. The scan does not depend on the order Telegram lists them in (`@grammyjs/types` says
  chronological; not observed live — owner step 1 below). The 50th full page logs `error`
  «stars reconcile page ceiling».
- It keeps incoming transactions from a user of type `invoice_payment` dated within
  `STARS_RECONCILE_WINDOW_S` (48 h); one `star_payments` read per page; each unknown charge →
  `creditStarPayment` with currency `XTR`, the transaction's amount, payer and date.
- After a page's credits, its refunds (#118): every outgoing transaction to a user (`receiver.type
  = user`) dated within the window whose id is a charge `star_payments` holds as `paid` or `held` →
  `recordStarRefund` with the receiver, which must be the payer, and the receiver's
  `transaction_type`, kept in the audit row. Not narrowed to `invoice_payment`: the type of a live
  refund has not been seen (clarify В1); the id match is the filter. A refunded charge is skipped;
  an id we never recorded, or a receiver who is not the payer, is one `error` line per charge id
  per process. A refund recorded here logs `info` «stars refund recorded» and pushes nothing:
  Telegram tells the user itself.
- A payload that is not ours, or a payload naming no users row: one `error` line per charge id per
  process, the id and the amount only. Nothing is written.
- A credit made here is pushed: «⭐ Начислено N токенов. Баланс: M» with «🏠 В меню» through the
  client push (the bot's own answer never came). The notification level does not apply (a
  payment's result). A 403 marks the user unreachable (Rule 19); any failed send is logged and not
  repeated — the tokens are already there. `already_recorded` and `held` push nothing.

## Refunds

Every refund goes through a staff member, by the charge id (the owner's answer of 2026-10-08).
Telegram refunds the whole charge; nothing refunds automatically.

```bash
pnpm --filter @binarius/backend stars requests                          # /paysupport's open requests
pnpm --filter @binarius/backend stars refund <charge id> --reason "…"   # refund and record
```

`apps/backend/src/cli/stars.ts`; env `DATABASE_URL`, and `TELEGRAM_BOT_TOKEN` (the public bot,
which was paid) for `refund`. `--reason`: 1-200 characters without control characters, kept in the
audit row. Exit 0 done, 1 not carried out, 2 not understood.

`stars refund` reads the payment first: no row → «Оплата не найдена», exit 1; `refunded` → «Уже
возвращена …», exit 0, Telegram not called. Otherwise it calls `refundStarPayment(payer, charge id)`
with no transaction open, and acts on the answer:

| Telegram's answer | Means | Action | Exit |
|---|---|---|---|
| `true` | refunded | the record below; prints the tokens taken, not recovered, the balance | 0 |
| `GrammyError` 400 whose description contains `CHARGE_ALREADY_REFUNDED` (case-sensitive) | refunded before (an earlier run whose record failed, or by hand) | the record below; a row already `refunded` is `already_recorded`, nothing written | 0 |
| any other `GrammyError` | Telegram refused, nothing happened | nothing written; prints Telegram's `error_code` and `description` | 1 |
| a timeout, a dropped connection, anything else | unknown | nothing written; «Исход неизвестен … Повторите команду» | 1 |
| `true`, then the record fails | refunded, not recorded | «Возврат в Telegram выполнен, запись в БД не сделана — повторите команду (безопасно) или дождитесь сверки» | 1 |

The record is `recordStarRefund(tx, …)` (`packages/db/src/star-payment-ops.ts`): the only writer of
the refund state and of the `refund` ledger rows, and the seventh writer of the balance cache
(Rule 2). In one short transaction:

1. the payment's `users` row `FOR NO KEY UPDATE`, then the payment row `FOR NO KEY UPDATE`;
2. `refunded` already → `already_recorded`; a receiver given (the reconciler) that is not the
   payer → `receiver_mismatch`; nothing written in either;
3. taken = `min(tokens, token_balance − token_reserved)` for a `paid` payment, 0 for a `held` one
   (nothing was credited; crediting a held payment is #246's adjustment). A `refund` ledger row of
   −taken when it is above 0, and `users.token_balance −= taken`;
4. `status = refunded, refunded_at = now()` by CAS on `paid | held`;
5. one `audit_log` row `stars_refunded`, actor `system`: the user, the payer, the status it came
   from, the package, the amount, `tokensTaken`, `tokensNotRecovered`, `via` (`cli` or
   `reconciler`), Telegram's answer, the reason (CLI) or the transaction type (reconciler).

Exactly once: the status read under the payment's lock and the CAS are the barrier against a
repeated command, the command racing the reconciler and two ticks; `token_ledger_star_payment_idx`
is the second barrier on the ledger side. Tokens already spent are not recovered, and a reserve held
by a live intent is never touched; both are `tokensNotRecovered`.

**Assumption 1** (owner check 1): a refund shows in `getStarTransactions` as an outgoing transaction
whose `id` is the charge id and whose `receiver.type` is `user` (`@grammyjs/types` 5.0.0
`StarTransaction`: «Coincides with the identifier of the original transaction for refund
transactions»). Not observed live. If false, the reconciler records no refund, and the command's
two recording rows remain the record.

**Assumption 2** (owner check 1): Telegram answers a repeated `refundStarPayment` with a 400 whose
description contains `CHARGE_ALREADY_REFUNDED` (the MTProto error behind the method; the Bot API
documents none). Not observed live. If the text differs, a repeat lands in the «any other
GrammyError» row — nothing written, exit 1 — and the reconciler records the refund: a wrong guess
costs a printed error, never a second ledger row.

## /paysupport

Telegram expects a bot that sells in Stars to answer `/paysupport`. The command (in the menu after
`/support`) and «↩️ К списку оплат» (`ps:l`, a read) call `POST /payments/stars/list` and show the
payer's five newest payments, a line per state (paid, on hold, a request made, refunded), with
«↩️ Нужен возврат: <date>» (`ps:r:<payment id>`) under each one neither refunded nor requested, the
support chat and «🏠 В меню». No payment → `paysupportEmpty` with the support chat. A failed read →
`unavailable` with «🔄 Повторить» (`ps:l`).

«Нужен возврат» is a write (`ps:r:` in `WRITE_CALLBACK_PREFIXES`): `POST
/payments/stars/refund-request` inserts the request by `INSERT … SELECT` matching the payment id,
the presser as its payer and a status other than `refunded`, `on conflict do nothing`, with the
audit row `stars_refund_requested` (actor the user). The answers — `paysupportRequested`,
`paysupportAlreadyRequested`, `paysupportAlreadyRefunded` (409), `paysupportNotFound` (404), and
`unavailable` for anything else (the request may be recorded; the list shows it on the re-read) —
all carry «↩️ К списку оплат» and the menu, never the press again.

After the commit, and only when a row was inserted, the staff bot (`AdminBot.notifyStaff`, plain
text from `ADMIN_TEXTS.refundRequested`) tells every active staff member the charge id, the
package, the amount, the status, the payer's Telegram id and the command. The reply does not wait;
a failed send is a `warn` per recipient, not repeated, and a notice lost by a shutdown leaves the
request in `stars requests`.

## Timing (Rule 10)

- Bot (`apps/bot/src/timing.ts`): `STARS_PRECHECKOUT_BUDGET_MS` (2 s) ≤
  `STARS_PRECHECKOUT_BACKEND_TIMEOUT_MS` (3 s) ≤ `BACKEND_REQUEST_TIMEOUT_MS`, and
  `STARS_PRECHECKOUT_BACKEND_TIMEOUT_MS + PRECHECKOUT_ANSWER_RESERVE_MS` (2 s) <
  `TELEGRAM_PRECHECKOUT_DEADLINE_MS` (10 s). `HANDLER_CALLS`: `buy` 1 / 1, `buyButton` 1 / 2,
  `buyPackage` 1 / 2, `preCheckout` 1 / 1, `paid` 1 / 1, and #118's `paysupport` 1 / 1,
  `paysupportList` 1 / 2, `paysupportRequest` 1 / 2; none moves `HANDLER_BUDGET_MS`.
- Backend (`apps/backend/src/timing.ts`): the pre-checkout budget and a reconciler stop (one call
  and one push) inside phase 1; `MAX_PAGES × STARS_TELEGRAM_API_TIMEOUT_MS < STARS_RECONCILE_TICK_MS
  < STARS_RECONCILE_WINDOW_S`.
- Both chains throw at import.

## Accepted risks

1. **A queued pre-checkout.** The bot runs one update at a time (`POLLING_BATCH_LIMIT = 1`); a query
   that waits behind a handler longer than about 5 s may miss Telegram's 10 s. Falsifiable: at pilot
   volume the update queue stays under 5 s; a lost query costs the user a retry, never money.
2. **The scan ceiling.** A tick reads at most 5 000 transactions. Falsifiable: the bot has fewer
   than 5 000 Stars transactions in all; the ceiling's error line comes first, and a cursor is the
   follow-up.
3. **A blocked user is credited** (the user paid).
4. **Tokens already spent are not recovered by a refund** (the owner, 2026-10-08); the audit row says
   how many.
5. **Between a refund and its record**, when the command's record fails: at most one reconciler tick
   (5 min). Falsifiable: the reconciler runs (started after `listen()`) and assumption 1 holds.
6. **A staff notice lost by a shutdown**: the request stays listed by `stars requests`.
7. **The refund's audit actor is `system`**: the staff member who ran the command is not identified
   (#510 brings the admin button and the staff identity).

## Owner checks (not run by the pipeline)

1. **A live purchase on the pilot**, by day after the deploy: `/buy` → the 100 ⭐ package → pay.
   Expect «⭐ Начислено 50 токенов», one ledger row and the card's balance +50:

   ```sql
   select kind, balance_delta, star_payment_id from token_ledger
     where star_payment_id is not null order by created_at desc limit 1;
   ```

   Within the next 5 minutes the reconciler adds no second row for the same charge. Then
   `/paysupport` → «Нужен возврат»: each active staff member gets the staff bot's notice, and
   `stars requests` lists it. Refund it:

   ```bash
   pnpm --filter @binarius/backend stars refund <charge id> --reason "проверка"
   ```

   Expect «Возврат выполнен и записан», one `refund` row of −50 (less if spent). The same command
   again answers «Уже возвращена …» from the row, without Telegram. Observe the order of the
   transactions and the refund's shape once (assumption 1: `id` = the charge id, `receiver.type =
   user`, and its `transaction_type`) and note them here:

   ```bash
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getStarTransactions?limit=5"
   ```

   and Telegram's text for a repeat (assumption 2), once by hand:

   ```bash
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/refundStarPayment" \
     -d user_id=<payer telegram id> -d telegram_payment_charge_id=<charge id>
   ```

2. **The reconciler's record** (optional): refund a second test purchase by the curl above, not the
   command. Within 5 minutes `star_payments.status = refunded`, one `refund` row, and `via:
   reconciler` in the `stars_refunded` audit row.
3. **The lost update** (optional): stop `bot`, pay an invoice sent before the stop, start `bot` →
   within 5 minutes the push «⭐ Начислено …» and one ledger row.

## Boundaries

- **#510** — the refund button and the requests page in the admin, with the staff member's identity
  in the audit row.
- **#246** — crediting a `held` payment, by the manual adjustment.
- **#123** (done) — the buy row under the 80 % / 100 % nudges.
- **#27** (done) — «💳 Пополнить» under the buy row of the status card and beside «⭐ Купить
  токены» in the two `insufficient_tokens` refusals (#506; `docs/deposit.md` → The chain).
- **#13** — the bonus rule engine; its migration adds `token_ledger_bonus_rule_check` beside
  `token_ledger_reference_check` and leaves this one's text as it is.
