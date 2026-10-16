# The next step under every message (issue #350)

The client bot leads the user by the hand: `/start` → connect Binodex → demo. **Every message the
bot or the backend's push sends to the user carries an inline keyboard with the next step**, so the
user never has to type `/menu` or `/start` to go on. A success leads further, a temporary failure
offers the same read again and the menu, a refusal leads where it can be fixed.

```bash
pnpm test --project unit apps/bot/src apps/backend/src/auth/client-push.test.ts   # no database or Redis
```

## The rule, by type

- `apps/bot/src/send.ts`: `replyHtml`, `editMessageTextHtml`, `editMessageTextByIdHtml`,
  `replyWithVideoHtml`, `replyWithPhotoHtml` and `sendPhotoByIdHtml` (#318) require `reply_markup`, and only an inline keyboard
  (`InlineKeyboard` or `InlineKeyboardMarkup`) is accepted. A reply keyboard, `ForceReply` or
  `ReplyKeyboardRemove` does not compile.
- A message without one goes only through `replyHtmlWithoutNextStep` or
  `editMessageTextHtmlWithoutNextStep`, which take a `NoNextStepReason` from `NO_NEXT_STEP_REASONS`
  (the exception list below). The reason is not sent; its type makes every such call name an entry.
- `apps/backend/src/auth/client-push.ts`: `ClientPushMessage.reply_markup` is required, for the link
  push, every mailing ([mailing.md](mailing.md)) and the session's summary (#464); its one message
  without a keyboard is the session's cycle message, sent by `sendSessionTrade` and edited by
  `editSessionTrade` (#551), which take the text alone (exception `session_trade` below).
- `send.typecheck.ts` holds the rule: a call without `reply_markup`, with it `undefined`, with a
  reply keyboard, and a reason outside the list each fail `tsc` (an `@ts-expect-error` that starts
  compiling fails `pnpm check`).
- Not covered: `editMessageReplyMarkup` (it sets a keyboard, it cannot strip one by accident, and
  removing an old duration's keyboard is deliberate, docs/bot-demo.md, as is stripping the launch
  screen's after a refused delete, #418, docs/bot-session.md), callback-query toasts
  (not messages), and the staff bot (`apps/backend/src/admin`, plain text by the owner's decision
  2026-10-02). A send method used outside the two seams is ESLint's to refuse (Rule 18).

## Exceptions

| `NoNextStepReason` | Where | Why |
|---|---|---|
| `in_progress` | the analysis' «⏳ Анализирую…» (`demo.ts`: an edit of the pressed message, or a new message at once under a photo — the analysis card, the session's summary card, #482) | a text result replaces it with its keyboard within the signal's budget, and after a signal's card (#482) it is deleted; a keyboard on it would let «📊 Анализ» be pressed twice. Residual: when the result's edit fails in transport or is refused for an unlisted reason, when the card's photo fails in transport and «⏳»'s edit is refused, or when its delete is refused, the bot sends nothing more (#126: a second message after an unknown delivery is worse than none), and «⏳» stays without a keyboard; the screen above it and /menu remain |

The backend's push has one exception of its own, by its method's type rather than a reason:

| Exception | Where | Why |
|---|---|---|
| `session_trade` (#464, #551) | `sendSessionTrade` and `editSessionTrade` (`apps/backend/src/auth/client-push.ts`), from the session notices (`apps/backend/src/trading/session-notices.ts`); their types take only the text | a cycle of a running session, its settled trades listed in one message edited at each step, one of up to 60 trades in a row, without sound ([bot-session.md](bot-session.md#trade-messages-and-the-summary-464)): the session's status message right above carries «🔄 Обновить» and «⏹ Остановить сессию», and the summary at the end «🏠 В меню»; a keyboard under every cycle would repeat them |

One more exception is not a `NoNextStepReason`, because it is not a message in the user's own
chat with the bot:

| Answer | Where | Why |
|---|---|---|
| the inline share result (#321) | `answerInlineQueryPhotoHtml` and `answerInlineQueryEmpty` (`send.ts`), from `session-share.ts`; their types take no `reply_markup` | the card is posted, «via @bot», into a chat the user picked; the bot's buttons there would act for whoever presses them. The link in its caption (`t.me/<bot>?start=share`) is the way into the bot |

## Shared buttons

- `packages/shared/src/bot-navigation.ts`: `DEMO_CALLBACK_DATA` (`demo`), `CONNECT_CALLBACK_DATA`
  (`connect`), `MENU_CALLBACK_DATA` (`menu`), `commandRetryCallbackData` (`cmd:account`,
  `cmd:settings`, `cmd:invite` since #115) and its pattern, `BUY_CALLBACK_DATA` (`buy`) and
  `buyPackageCallbackData` (`buy:<code>`, #117), `PAYSUPPORT_LIST_CALLBACK` (`ps:l`) and
  `paysupportRefundCallbackData` (`ps:r:<payment id>`, #118), `demoAnalysisCallbackData`
  (`demo:an:<assetId>:<sec>`, moved from `demo.ts` by #484 for the analysis reminder), `supportUrl()`, and since #27
  `CASHIER_PAGE_PATH` (`/cashier`, the page `web` serves) and `cashierUrlOf(origin)` (the page's
  URL on an https origin, none otherwise). The bot and the backend's push build their
  buttons from it, so a pushed button lands on the bot's handler.
- `apps/bot/src/keyboards.ts`: `menuKeyboard`, `withMenu`, `demoKeyboard`, `supportKeyboard`,
  `retryKeyboard`, `backToAnalysisKeyboard`, `appendEndOfPath` (its «📡 К сигналам» carries the
  path's duration, `demo:sig:<sec>`, since #382; its `beforeMenu` rows go right above the menu);
  since #115 `inviteButton` (`invite`), `statusCardKeyboard`, `withInvite` and `inviteKeyboard`
  ([referrals.md](referrals.md)); since #117 `buyButton`, `withBuy` and `buyPackagesKeyboard`
  ([stars.md](stars.md)); since #27 `depositButton` and `depositRows` («💳 Пополнить», a `web_app`
  button with no callback data; no row without a URL; the only builders, `keyboards.test.ts`,
  [deposit.md](deposit.md)).
- The labels are catalog entries: `menuButton` «🏠 В меню», `newAnalysisButton` «📊 Новый анализ»,
  `toSignalsButton` «📡 К сигналам»; reused: `demoRetryButton` «🔄 Повторить»,
  `stakeBackAnalysisButton` «↩️ Назад к анализу», `supportButton`, `demoButton`.

**«🏠 В меню»** (`menu`) runs `/menu`'s path after answering the press: the status card for an
active account, the waiting link, the welcome. It does not unpin and pin the card: with the answer
that path is 2 backend and 5 Bot API calls, 50 s, the shutdown budget itself (`timing.ts`,
`HANDLER_CALLS.menuButton` = 2 / 3). The card pinned stays the last `/start` or `/menu`.

**«🔄 Повторить» of a command** (`cmd:account`, `cmd:settings`, `cmd:invite`) runs the command
again. `/invite`'s read creates the user's code on first use and is idempotent, so it repeats as a
read (#115). `/start` and
`/menu` repeat as the menu (`menu`); a repeated `/start` does not carry its payload.

## The repeat

«🔄 Повторить» carries the pressed data again **only after a read**: a demo screen, the signals
screen, the picker's way back to /settings, the trade's and the session's refresh. A press that
writes — `demo:stake:`, `demo:sess:`, `real:sess:` (#327), `session:stop:`, `confirm:`, `resend`, `stk:s:`, `stk:z:`,
`level:`, `ps:r:` (#118), the mode switches `mode:r:ok` and `mode:d` (#474) — never gets it: its failure leads back to where it was pressed (the analysis, the
menu), so a lost answer never becomes a second trade or session. `testing.ts` → `captureApi` throws
on any message whose «🔄 Повторить» carries one of those prefixes, in every scene of every bot test
(`WRITE_CALLBACK_PREFIXES`, `testing.test.ts`). «➕ Ещё» (`demo:more:`, #360) is a read that sends
no message: it gets no «🔄 Повторить» of its own, and its failure leaves the analysis on screen.
The command `/stop` (#122) is a write too: its failure answers `unavailable` with «🏠 В меню» and
no repeat.

## Message → buttons

| Message (where) | Buttons |
|---|---|
| welcome, `accountNone` | 🔗 Подключить (unchanged) |
| `confirmPrompt`, push `Pending` | ✅ Подтвердить (unchanged) |
| status card | 🎮 Демо-торговля and 💼 Реальный режим in one row (in real: 🚀 Торговать and 🎮 Вернуться в демо, both opening the mode screen, #474) · 👥 Пригласить друга (#115) · ⭐ Купить токены (#117) · 💳 Пополнить (#27, https only) |
| account card (`sendAccountCard`: the code, the confirm, the recheck) | 🎮 Демо-торговля |
| push `Active` | 🎮 Демо-торговля |
| push `Taken`, `ExchangeFailed`, `Mismatch` | 🔗 Подключить · 🏠 В меню |
| `blocked` (bot, push, a confirm or login refusal, a trade or session refusal) | the support URL; in the stake picker the picker's way back under it |
| `unavailable` after `/start`, `/menu`, «🏠 В меню» | 🔄 Повторить (`menu`) |
| `unavailable` after `/account`, `/settings`, `/invite` | 🔄 Повторить (`cmd:…`) · 🏠 В меню |
| `unavailable` after the picker's way back (`settings`) | 🔄 Повторить (`settings`) · 🏠 В меню |
| `unavailable` after a level set (a write) | 🏠 В меню |
| `/account` with an active link | 🎮 Демо-торговля · 🏠 В меню |
| `/support` | the support URL · 🏠 В меню |
| `/help` | 🏠 В меню |
| `/invite`, «👥 Пригласить друга» (#115) | 📤 Поделиться (a URL) · 🏠 В меню |
| `inviteNeedsStart` (`/invite` before the first `/start`) | 🏠 В меню |
| `/buy`, «⭐ Купить токены» (#117, [stars.md](stars.md)) | a package per row (`buy:<code>`) · 🏠 В меню |
| `buyNeedsAccount` | 🔗 Подключить |
| `buyPackageGone` | the packages · 🏠 В меню |
| `unavailable` after `/buy` or a package (reads) | 🔄 Повторить (`buy`, `buy:<code>`) · 🏠 В меню |
| the Stars invoice (`replyWithInvoiceStars`, `send.ts`) | ⭐ Оплатить N (Telegram's pay button, first by the Bot API's rule) · 🏠 В меню |
| `starsCredited`, `starsPending`; the reconciler's push `starsCredited` | 🏠 В меню |
| `starsHeld` | the support URL · 🏠 В меню |
| `/paysupport`, «↩️ К списку оплат» (`ps:l`, #118, [stars.md](stars.md#paysupport)) | ↩️ Нужен возврат: <date> per open payment (`ps:r:<id>`) · the support URL · 🏠 В меню |
| `paysupportEmpty` | the support URL · 🏠 В меню |
| `unavailable` after `/paysupport` (a read) | 🔄 Повторить (`ps:l`) · 🏠 В меню |
| every answer to «Нужен возврат» (a write), `unavailable` included | ↩️ К списку оплат (`ps:l`) · 🏠 В меню |
| the `insufficient_tokens` refusals of a trade and a session | ⭐ Купить токены · 💳 Пополнить (#27, https only) · ↩️ Назад к анализу · 🏠 В меню |
| login: `emailPrompt`, `emailInvalid`, `codeRequestStale`, a refusal without the code buttons, `unavailable` | 🏠 В меню (the dialog is left as `/menu` leaves it) |
| login: `codeSent`, `codeSentUnknown`, `codeInvalid`, a refusal with them | 📨 / ✏️ (unchanged) |
| demo screens, the signals and launch screens (#320), the amount screen (#476), the picker | their own keyboards (unchanged); the launch screen and the amount screen are deleted once the session's status is sent (#418) |
| the analysis (#360) | 🚀 Сессия из 5 циклов on a signal (#509: none on «сигнала нет») · ➕ Ещё on a signal · 🔄 Повторить анализ · ↩️ Длительность ↩️ Типы; «➕ Ещё» expands it in place: the session, 🚀 Открыть сделку · 💵 Сумма, the repeat, the way back |
| the stake press refused or failed before or at the create (`unavailable`, `stakeOutcomeUnknown`, `statusAmbiguous`, `stakeBalanceMissing`, a refusal without its own button) | ↩️ Назад к анализу · 🏠 В меню |
| the session start refused or failed, `sessionJustEnded` | ↩️ Назад к анализу · 🏠 В меню; `no_signal` (#509) → 🔀 Выбрать другую пару (`demo:sig:<sec>`) · 🏠 В меню |
| a cycle door's press (`demo:l`, #509): «сигнала нет» / the signal unread | 🔀 Выбрать другую пару · 🏠 В меню / 🔄 Повторить (the pressed data) · 🏠 В меню |
| the mode screen (`mode`, `mode:x`; #474, [trading-mode.md](trading-mode.md#the-bot)) | 💼 Включить реальный режим (`mode:r`) in demo or 🎮 Вернуться в демо (`mode:d`) in real · 🏠 В меню |
| its confirm (`mode:r`) | ✅ Подтверждаю (`mode:r:ok`) · ↩️ Отмена (`mode:x`, the step back, so no menu of its own) |
| a switch's result (`modeEnabled`, `modeDisabled`) | 🏠 В меню |
| every refusal or failure of the mode screen and its switches (`modeBelowMinimum`, `stakeBalanceMissing`, `tradingDemoOnly`, `unavailable`, `modeOutcomeUnknown`) | ⚙️ Режим (`mode:x`, a read) · 🏠 В меню — never a switch |
| the mode screen's access refusals in demo (`accountNone`, `statusAmbiguous`, `stakeBalanceMissing`) | 🔗 Подключить · 🏠 В меню; 🏠 В меню |
| the trade's refresh failed | 🔄 Повторить (`intent:<id>`) · 🏠 В меню; `intentStatusUnavailable` (404) → 🏠 В меню |
| the session's refresh or stop failed | 🔄 Обновить (`session:<id>`) · 🏠 В меню; `sessionStatusUnavailable` (404) → 🏠 В меню |
| trade status, live (planned, reserved, queued, submitting, unknown, reconciling, manual_review) | 🔄 Обновить статус while the tracker follows the message; its last edit at the deadline, and the message «🔄 Обновить статус» redraws (no tracker follows that one), add 🏠 В меню; a 404 while tracking leaves 🏠 В меню only |
| trade status, where the tracker stops (accepted, every terminal status) | 🔄 Обновить статус while it can still move (accepted), then 🚀 Сессия из 5 циклов (#360, on a duration the demo still offers) · 📊 Новый анализ · 📡 К сигналам · 🏠 В меню |
| session status, live | 🔄 Обновить · ⏹ Остановить сессию; a 404 while tracking leaves 🏠 В меню only |
| session status, stopped | 🔄 Обновить · 🔁 Ещё сессия (#320) · 📊 Новый анализ · 📡 К сигналам · 💳 Пополнить (#27, https only) · 👥 Пригласить друга (#115) · 🏠 В меню; without `settings` only 🔄 Обновить · 💳 Пополнить · 👥 Пригласить друга · 🏠 В меню, on a duration the demo no longer offers no «Ещё сессия» and no «Новый анализ»; stopped by `no_signal_timeout` (#509): 🔄 Обновить · 🔀 Выбрать другую пару · 💳 Пополнить · 👥 Пригласить друга · 🏠 В меню |
| `/stop` (#122), one session stopped | the session's status keyboard (the two rows above) |
| `/stop`: `sessionNoneActive`, `sessionsStopped`, `unavailable` | 🏠 В меню |
| `/stop`'s mode line (#473): `modeStopReset`, `modeNotReset` | 🏠 В меню |
| `/stop`'s mode line (#473): `modeOutcomeUnknown` | ⚙️ Режим (`mode`, a read, the screen as a new message) · 🏠 В меню — never a switch |
| the session's summary card (#318, a photo) | 📤 Поделиться (#321, by an edit right after the send; the card keeps the rest when the edit fails) · 🔁 Ещё сессия · 📊 Новый анализ · 📡 К сигналам · 💳 Пополнить (#27, https only) · 👥 Пригласить друга (#115) · 🏠 В меню — the stopped status's without 🔄 Обновить, which edits a message's text; without `settings` only 💳 Пополнить · 👥 Пригласить друга · 🏠 В меню, on a duration the demo no longer offers no «Ещё сессия» and no «Новый анализ»; by `no_signal_timeout` (#509) 🔀 Выбрать другую пару in place of «Ещё сессия», «Новый анализ» and «К сигналам». «📊 Новый анализ» and «📡 К сигналам» answer with a new message under the card: the photo's edit is refused as gone (`telegram-refusals.ts`) |
| `stakeInputInvalid` | the picker's way back |
| the analysis reminder `analysisUnusedReminder` (#484, the backend's mailing, [mailing.md](mailing.md)) | 📊 Новый анализ (`demo:an:<assetId>:<sec>` of the analysed pair and duration) — one button, as the chain's reminders |

«📊 Новый анализ» opens the analysis of the same pair and duration (`demo:an:<assetId>:<sec>`), never
a stake: the analysis is not skipped (Rule 20). «📡 К сигналам» opens the signals of the same
duration (`demo:sig:<sec>`, #382), or the main path's duration screen (`demo:sig`) on a duration the
demo no longer offers. «🔀 Выбрать другую пару» (#509) carries the same data: a session stopped or
refused for want of a signal is not offered its own pair again; the backend's summary of such a
stop draws it from `signalsCallbackDataFor` (`bot-navigation.ts`). The trackers' edits take the view and, for a last
edit that is not a status, why: `IntentTrackRequest.edit(text, view, end?)` with `end` a `TrackEnd`
(`not_found`, `deadline`), `SessionTrackRequest.edit(text, view, end?)` with `not_found` only. So
the last edit draws its next step too: the end of the path on a stop status, the menu alone on a
404, the refresh and the menu at the deadline of a live trade.

An old message sent before #350 keeps the keyboard it had: Telegram keeps old messages, and the rule
applies to what is sent after the deploy.

## Timing

`HANDLER_CALLS.menuButton` = 2 / 3 (34 s): the answer, `recordStart`, `readTradingAccess`, the photo
refused and the text card. `.commandRetry` = 1 / 2 (21 s): the answer, then `/account`'s,
`/settings`' or `/invite`'s one read and one message. Neither moves `HANDLER_BUDGET_MS`. No other handler gains a
call: the keyboards ride on the messages already sent.

## Boundaries

- **#202** — reminders to a user who connected and never started the demo: sent through
  `client-push.ts` with the demo button ([mailing.md](mailing.md)).
- **#474 / #326 / #327** — the mode screen, the real stake and real sessions: the seam types make
  them comply ([trading-mode.md](trading-mode.md)); the mode screen leaves a next step under every
  message (the rows above, `trading-mode.test.ts` MR1).
- **#321** — «📤 Поделиться» under the session's summary card (#318), on top of
  `sessionCardKeyboard`'s rows; the inline result it posts is the exception above
  ([bot-session.md](bot-session.md#sharing-the-card-321)).
