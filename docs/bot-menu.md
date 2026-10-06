# /menu and the status card

A user with an active Binodex account gets the **status card** (#24) as the bot's home: on
`/start` (in place of the old «👋 С возвращением!») and on `/menu`. The card is the account card's
picture with a caption of the trading mode, the real balance, the demo balance, the tokens, a
status or age line when the broker balance is missing or old, a hint, and one button
«🎮 Запустить демо». It is pinned in place of whatever was pinned before.

## Components

- `packages/shared/src/trading-access.ts` and `broker-balance.ts` — the contract of
  `POST /trading/access` ([trading-access.md](trading-access.md)), used as it is.
- `apps/bot/src/backend-client.ts` — `readTradingAccess(telegramUserId)`: the route, parsed by
  `safeParseTradingAccessResponse`; a body the parser refuses (`available ≠ balance − reserved`,
  `broker` and `brokerUnavailable` both set or both null, `fresh` disagreeing with the ages) is a
  contract violation.
- `apps/bot/src/format.ts` — `formatUsd`, `formatCount`, `formatAge` ([Formatting](#formatting)).
- `apps/bot/src/texts.ts` — the `status*` entries, `MODE_LABELS`, `modeHeader`,
  `StatusCardInput`, `statusCard`, `LABELS.menuCommand`, `LABELS.demoButton`.
- `apps/bot/src/bot.ts` — `/start` and `/menu` on one path (`answerHome`), `sendStatusCard`, the
  `demo` button's keyboard (`DEMO_CALLBACK_DATA` from `demo.ts`), `pinCard`.
- `apps/bot/src/commands.ts` — `/menu` «Главное меню», right after `/start`.
- `apps/bot/src/timing.ts` — `HANDLER_CALLS.start`, `.menu`, `.demo`, and the conjunct
  `TRADING_ACCESS_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS`.

## Sequence

```text
/start [payload] | /menu [anything]
  bot  → POST /users/start { telegramUserId, displayName, languageCode?, startPayload? }
         (/menu sends no payload, so it never spends the acquisition slot)
  bot  → blocked                → "🔒 Доступ ограничен"
         pendingBrokerAccounts  → the confirm prompt and its buttons
         no active account      → the welcome and its two buttons
         an active account      → POST /trading/access { telegramUserId }
                                  → the outcome below
```

The request carries no `brokerAccountId`: the card is about the user's only active account. The
bot caches nothing; every `/start` and `/menu` reads the route again.

## The card

```text
🎮 Режим: DEMO

💵 Реальный баланс: $0.00
🧪 Демобаланс: $10 000.00
🪙 Токены: 5 (в резерве: 1)
🕒 Баланс Binodex обновлён 3 мин назад.        ← a snapshot with fresh: false
⏳ Баланс Binodex ещё не получен — попробуй /menu через минуту.   ← no snapshot
⚠️ Подключено несколько аккаунтов Binodex, баланс не выбран — напиши в поддержку: /support   ← ambiguous_account

💡 Демо без риска — деньги не нужны.
```

At most one of the three status lines is printed.

- **Mode.** `modeHeader(mode)` prints `MODE_LABELS[mode]`. The bot passes `TradeMode.Demo`: no
  user trades on real yet, and `realTradingAllowed` is the backend's switch, not the user's mode,
  so it is not read. The issue that brings real mode passes the user's mode and changes nothing
  in `texts.ts`.
- **Balances.** `broker.real.available` and `broker.demo.available` — what can be staked now;
  money held by an open trade is not in it (owner, 2026-10-06). With `broker: null` both print
  `$0.00` and the status line says why: `statusAmbiguous` for `ambiguous_account`,
  `statusNoSnapshot` for every other reason that reaches the card (`refreshing`,
  `broker_unavailable`, `account_pending`, `account_revoked`, `user_blocked`).
- **Age.** With a snapshot and `fresh: false`, `statusStale` prints the smaller of
  `restSnapshotAgeSec` and `balanceEventAgeSec` (the age `isBalanceFresh` judged). The bot does not
  recompute `fresh`: the parser has already refused a body whose flag disagrees with the ages. A
  fresh snapshot gets no age line.
- **Tokens.** `tokens.available`, with «(в резерве: R)» when `reserved` has a non-zero digit.
- **Freshness.** The numbers are read from the backend when the command arrives, so the card is
  at most `BROKER_BALANCE_SLA_SEC` old at that moment or carries the age line. Nothing is promised
  about a card read later; `/menu` sends a new one.

Every fragment is a `TEXTS` entry and every hole goes through `telegramHtml`. The caption of every
variant, with every hole at its widest, is valid Telegram HTML inside the 1 024-unit caption limit
(`texts.test.ts`).

## Formatting

`format.ts` turns the backend's strings into text without `Number`, so a `numeric(20,8)` or a
`bigint` keeps its digits:

- `formatUsd` keeps the sign, cuts the fraction to two digits (truncated, not rounded: the card
  never shows more than the broker reported) or pads it, and groups the integer digits by three
  with a no-break space (U+00A0). `'10000.00000000'` → `$10 000.00`, `'0'` → `$0.00`,
  `'9998.5'` → `$9 998.50`, `'1.999'` → `$1.99`, `'123456789012.12345678'` →
  `$123 456 789 012.12`, `'-1.5'` → `-$1.50`. A zero keeps no sign.
- `formatCount` groups an integer string the same way: `'1000'` → `1 000`.
- `formatAge` prints «N с» under a minute and whole minutes (floor) from one: `59` → «59 с»,
  `60` → «1 мин», `3599` → «59 мин».

## Outcomes of `POST /trading/access`

| Answer | Bot |
| --- | --- |
| 200 `status: 'active'`, a snapshot or a reason other than `no_account` | the card |
| 200 `status: 'blocked'` (blocked between the two calls) | `TEXTS.blocked`, no card |
| 200 `brokerUnavailable: 'no_account'` (revoked between the two calls) | `TEXTS.accountNone` + the two connect buttons, as `/account` shows |
| 404 `user_not_found` | `TEXTS.unavailable` + warn: `/users/start` has just upserted the row, so this is not «not connected» |
| 404 `broker_account_not_found`, 404 `not_found`, 401, 400, any other 4xx | `TEXTS.unavailable` + warn |
| 5xx, unreachable, timeout, a body the parser refuses | `TEXTS.unavailable` + warn; the route writes only `last_requested_at`, so `/menu` again is a free retry |

The warn line is `trading access not read` with `errorLogFields` and `backendErrorFields` (the
status and the bare reason) — no Telegram id and nothing of the answer (`logging.test.ts`).

## Delivery and the pin

The card goes the account card's way ([bot-start.md → The account card](bot-start.md#the-account-card)),
through `sendWithTextFallback` with `account-card.jpg`. The photo refused → the same caption as a
text message with the same button, and that message is pinned. A transport failure of the photo
or of the text → nothing more is sent and nothing is pinned, logged at `error` with the method.
Then `pinCard`: `unpinAllChatMessages`, then `pinChatMessage` without a notification; each
failure is one `warn` (`the old pins were not cleared`, `the status card was not pinned`) and
nothing else changes.

So the pinned message is the latest card with the balance. The account card stays in the chat
history but loses its pin; a lost or unpinned account card is replaced by `/start` or `/menu`.

## The demo button

`DEMO_CALLBACK_DATA = 'demo'`, label «🎮 Запустить демо». The button opens the asset picker as a
new message (the card is a photo whose caption cannot be edited into another screen): the asset
type, the pair, the duration, the summary, each checked on a catalog read at the press
([bot-demo.md](bot-demo.md)). The bot keeps no state for it, so a button on an old card leads to
the same place.

## /menu

`/menu` («Главное меню», after `/start` in the command menu, so `/help` lists it) runs `/start`'s
path with the request `/settings` sends: no payload, trailing text ignored. It is ignored outside a
private chat, and on the code step of the email dialog it answers without touching the dialog:
the command handlers are registered before the text handler and do not call `next()`.

## Timing

`HANDLER_CALLS.start` and `.menu` are two backend calls (`recordStart`, `readTradingAccess`) and up
to four Bot API calls (the photo refused, the text, the unpin, the pin): 2 × 5 000 + 4 × 8 000 =
42 s, under `confirm`'s 45 s, so `HANDLER_BUDGET_MS` and the shutdown budget do not move.
`HANDLER_CALLS.demo` is one backend call and two Bot API calls ([bot-demo.md](bot-demo.md)).
`timing.test.ts` runs every branch of the three through the real handlers.

`TRADING_ACCESS_BUDGET_MS` (4 000, the backend's upper estimate of the route) is at most
`BACKEND_REQUEST_TIMEOUT_MS` (5 000): the bot waits at least as long as the backend budgets the
route, so a broker GET inside its 3 s budget does not read as an outage. The conjunct is in the
import-time chain of `apps/bot/src/timing.ts` and restated by `timing.test.ts`. The number is an
estimate: a starved database can still push the route past the bot's wait, and the user then
gets «⚠️ Сервис временно недоступен» with nothing lost.

The bot's suites need no database or Redis:

```bash
pnpm test --project unit apps/bot/src
```

## Boundaries

- **#125** — the asset picker behind the button: [bot-demo.md](bot-demo.md).
- **#126** — the analysis behind «📊 Анализ»: [bot-demo.md](bot-demo.md#the-analysis).
- **#127 / #130** — the demo trade and the session of five; the callback data stays.
- **#201** — levels and their progress on this card.
- Real mode — the header reads REAL once a user can trade on real; #134's `realTradingAllowed` is
  the backend's switch, not a user's mode.
- A «🔄 Обновить» button that edits the caption in place, and a menu button on the account card —
  not asked; `/menu` sends a new card.
- The picture is uploaded on every `/start` and `/menu` (no `file_id` cache), as for the account
  card.
