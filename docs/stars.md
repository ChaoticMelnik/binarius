# Buying tokens for Telegram Stars (#117)

A user with an active Binodex account buys a package of automation tokens in the bot and pays in
Telegram Stars. A payment credits its tokens exactly once, whoever reports it: the bot's
`successful_payment`, its retry, or the reconciler. Refunds and `/paysupport` are #118.

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
   with a button per package (`buy:<code>`) and «🏠 В меню». #123's 80 % / 100 % nudges get the row
   when #123 merges (its PR #435 was open when this one was written; the requirement is on #123).
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

Every 4xx of the invoice comes before any side effect, so the package screen stays and a press is
the retry. The pre-checkout's budget is `STARS_PRECHECKOUT_BUDGET_MS` (2 s), its reads only.

## The credit (`packages/db/src/star-payment-ops.ts`)

`creditStarPayment(tx, payment)` is the only writer of `star_payments` and of the Stars rows of the
ledger, and the sixth writer of the balance cache (Rule 2). In one transaction:

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
   carries ids, the package, the amount and `via` (`bot` or `reconciler`).

A blocked user, or one whose account was revoked after the pre-checkout, is still credited: the
user paid (the owner's decision of 2026-10-08).

### The tables

- `star_payments`: `telegram_payment_charge_id` unique (`star_payments_charge_key`, 1-255
  characters), `provider_payment_charge_id` (NULL from the reconciler), `package_code`, `currency`,
  `total_amount > 0`, `tokens` (NULL or > 0), `status` (`paid` | `held` | `refunded`, CHECK from
  `StarPaymentStatus`), `paid_at` (Telegram's clock, no CHECK against `created_at`), `refunded_at`
  (set iff `refunded`), `created_at`; a `paid` row has tokens and currency `XTR`
  (`star_payments_paid_check`); `(id, user_id)` unique, the target of the ledger's FK.
- `token_ledger.star_payment_id` with `token_ledger_star_payment_owner_fk (star_payment_id,
  user_id)` (Rule 4); `token_ledger_reference_check`: a `purchase` names exactly one of a deposit
  and a Stars payment and nothing else, every other kind names no Stars payment;
  `token_ledger_star_payment_idx` unique `(star_payment_id, kind)` — one purchase per payment, the
  second slot is #118's refund.
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
- A payload that is not ours, or a payload naming no users row: one `error` line per charge id per
  process, the id and the amount only. Nothing is written.
- A credit made here is pushed: «⭐ Начислено N токенов. Баланс: M» with «🏠 В меню» through the
  client push (the bot's own answer never came). The notification level does not apply (a
  payment's result). A 403 marks the user unreachable (Rule 19); any failed send is logged and not
  repeated — the tokens are already there. `already_recorded` and `held` push nothing.

## Timing (Rule 10)

- Bot (`apps/bot/src/timing.ts`): `STARS_PRECHECKOUT_BUDGET_MS` (2 s) ≤
  `STARS_PRECHECKOUT_BACKEND_TIMEOUT_MS` (3 s) ≤ `BACKEND_REQUEST_TIMEOUT_MS`, and
  `STARS_PRECHECKOUT_BACKEND_TIMEOUT_MS + PRECHECKOUT_ANSWER_RESERVE_MS` (2 s) <
  `TELEGRAM_PRECHECKOUT_DEADLINE_MS` (10 s). `HANDLER_CALLS`: `buy` 1 / 1, `buyButton` 1 / 2,
  `buyPackage` 1 / 2, `preCheckout` 1 / 1, `paid` 1 / 1; none moves `HANDLER_BUDGET_MS`.
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
3. **No `/paysupport` until #118.** Telegram expects it from a bot that sells in Stars: the purchase
   entries go live together with #118, or the owner accepts the gap.
4. **A blocked user is credited** (the user paid).

## Owner checks (not run by the pipeline)

1. **A live purchase on the pilot**, by day after the deploy: `/buy` → the 100 ⭐ package → pay.
   Expect «⭐ Начислено 50 токенов», one ledger row and the card's balance +50:

   ```sql
   select kind, balance_delta, star_payment_id from token_ledger
     where star_payment_id is not null order by created_at desc limit 1;
   ```

   Within the next 5 minutes the reconciler adds no second row for the same charge. Then refund
   the Stars (the user's Telegram id and the charge id from `star_payments`):

   ```bash
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/refundStarPayment" \
     -d user_id=<telegram id> -d telegram_payment_charge_id=<charge id>
   ```

   and, if wanted, take the 50 tokens back by the admin adjustment. Observe the order once and note
   it here:

   ```bash
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getStarTransactions?limit=5"
   ```

2. **`/paysupport`**: deploy the entries with #118, or accept the gap.
3. **The lost update** (optional): stop `bot`, pay an invoice sent before the stop, start `bot` →
   within 5 minutes the push «⭐ Начислено …» and one ledger row.

## Boundaries

- **#118** — refunds (`refundStarPayment` by a staff member, the `refund` ledger kind on the second
  slot of `token_ledger_star_payment_idx`, `held` payments too) and `/paysupport`.
- **#123** — the buy row under the 80 % / 100 % nudges, when it merges.
- **#27** — «💳 Пополнить» next to the buy rows.
- **#13** — bonuses on purchases; its migration rewrites `token_ledger_reference_check` on top of
  this one's text.
