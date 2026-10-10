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
  push and for every mailing ([mailing.md](mailing.md)).
- `send.typecheck.ts` holds the rule: a call without `reply_markup`, with it `undefined`, with a
  reply keyboard, and a reason outside the list each fail `tsc` (an `@ts-expect-error` that starts
  compiling fails `pnpm check`).
- Not covered: `editMessageReplyMarkup` (it sets a keyboard, it cannot strip one by accident, and
  removing an old duration's keyboard is deliberate, docs/bot-demo.md), callback-query toasts
  (not messages), and the staff bot (`apps/backend/src/admin`, plain text by the owner's decision
  2026-10-02). A send method used outside the two seams is ESLint's to refuse (Rule 18).

## Exceptions

| `NoNextStepReason` | Where | Why |
|---|---|---|
| `in_progress` | the analysis' «⏳ Анализирую…» (`demo.ts`, an edit, or a new message when the summary is gone) | the result replaces it with its keyboard within the signal's budget; a keyboard on it would let «📊 Анализ» be pressed twice. Residual: when the result's edit fails in transport or is refused for an unlisted reason, the bot sends nothing more (#126: a second message after an unknown delivery is worse than none), and «⏳» stays without a keyboard; the summary above it and /menu remain |

## Shared buttons

- `packages/shared/src/bot-navigation.ts`: `DEMO_CALLBACK_DATA` (`demo`), `CONNECT_CALLBACK_DATA`
  (`connect`), `MENU_CALLBACK_DATA` (`menu`), `commandRetryCallbackData` (`cmd:account`,
  `cmd:settings`) and its pattern, and `supportUrl()`. The bot and the backend's push build their
  buttons from it, so a pushed button lands on the bot's handler.
- `apps/bot/src/keyboards.ts`: `menuKeyboard`, `withMenu`, `demoKeyboard`, `supportKeyboard`,
  `retryKeyboard`, `backToAnalysisKeyboard`, `appendEndOfPath` (its «📡 К сигналам» carries the
  path's duration, `demo:sig:<sec>`, since #382).
- The labels are catalog entries: `menuButton` «🏠 В меню», `newAnalysisButton` «📊 Новый анализ»,
  `toSignalsButton` «📡 К сигналам»; reused: `demoRetryButton` «🔄 Повторить»,
  `stakeBackAnalysisButton` «↩️ Назад к анализу», `supportButton`, `demoButton`.

**«🏠 В меню»** (`menu`) runs `/menu`'s path after answering the press: the status card for an
active account, the waiting link, the welcome. It does not unpin and pin the card: with the answer
that path is 2 backend and 5 Bot API calls, 50 s, the shutdown budget itself (`timing.ts`,
`HANDLER_CALLS.menuButton` = 2 / 3). The card pinned stays the last `/start` or `/menu`.

**«🔄 Повторить» of a command** (`cmd:account`, `cmd:settings`) runs the command again. `/start` and
`/menu` repeat as the menu (`menu`); a repeated `/start` does not carry its payload.

## The repeat

«🔄 Повторить» carries the pressed data again **only after a read**: a demo screen, the signals
screen, the picker's way back to /settings, the trade's and the session's refresh. A press that
writes — `demo:stake:`, `demo:sess:`, `session:stop:`, `confirm:`, `resend`, `stk:s:`, `stk:z:`,
`level:` — never gets it: its failure leads back to where it was pressed (the analysis, the
menu), so a lost answer never becomes a second trade or session. `testing.ts` → `captureApi` throws
on any message whose «🔄 Повторить» carries one of those prefixes, in every scene of every bot test
(`WRITE_CALLBACK_PREFIXES`, `testing.test.ts`). «➕ Ещё» (`demo:more:`, #360) is a read that sends
no message: it gets no «🔄 Повторить» of its own, and its failure leaves the analysis on screen.

## Message → buttons

| Message (where) | Buttons |
|---|---|
| welcome, `accountNone` | 🔗 Подключить (unchanged) |
| `confirmPrompt`, push `Pending` | ✅ Подтвердить (unchanged) |
| status card | 🎮 Демо-торговля (unchanged) |
| account card (`sendAccountCard`: the code, the confirm, the recheck) | 🎮 Демо-торговля |
| push `Active` | 🎮 Демо-торговля |
| push `Taken`, `ExchangeFailed`, `Mismatch` | 🔗 Подключить · 🏠 В меню |
| `blocked` (bot, push, a confirm or login refusal, a trade or session refusal) | the support URL; in the stake picker the picker's way back under it |
| `unavailable` after `/start`, `/menu`, «🏠 В меню» | 🔄 Повторить (`menu`) |
| `unavailable` after `/account`, `/settings` | 🔄 Повторить (`cmd:…`) · 🏠 В меню |
| `unavailable` after the picker's way back (`settings`) | 🔄 Повторить (`settings`) · 🏠 В меню |
| `unavailable` after a level set (a write) | 🏠 В меню |
| `/account` with an active link | 🎮 Демо-торговля · 🏠 В меню |
| `/support` | the support URL · 🏠 В меню |
| `/help` | 🏠 В меню |
| login: `emailPrompt`, `emailInvalid`, `codeRequestStale`, a refusal without the code buttons, `unavailable` | 🏠 В меню (the dialog is left as `/menu` leaves it) |
| login: `codeSent`, `codeSentUnknown`, `codeInvalid`, a refusal with them | 📨 / ✏️ (unchanged) |
| demo screens, the signals and launch screens (#320), the picker | their own keyboards (unchanged) |
| the analysis (#360) | 🚀 Сессия из 5 сделок on every `decided` answer · ➕ Ещё on a signal · 🔄 Повторить анализ · ↩️ Длительность ↩️ Типы; «➕ Ещё» expands it in place: the session, 🚀 Открыть сделку · 💵 Сумма, the repeat, the way back |
| the stake press refused or failed before or at the create (`unavailable`, `stakeOutcomeUnknown`, `statusAmbiguous`, `stakeBalanceMissing`, a refusal without its own button) | ↩️ Назад к анализу · 🏠 В меню |
| the session start refused or failed, `sessionJustEnded` | ↩️ Назад к анализу · 🏠 В меню |
| the trade's refresh failed | 🔄 Повторить (`intent:<id>`) · 🏠 В меню; `intentStatusUnavailable` (404) → 🏠 В меню |
| the session's refresh or stop failed | 🔄 Обновить (`session:<id>`) · 🏠 В меню; `sessionStatusUnavailable` (404) → 🏠 В меню |
| trade status, live (planned, reserved, queued, submitting, unknown, reconciling, manual_review) | 🔄 Обновить статус while the tracker follows the message; its last edit at the deadline, and the message «🔄 Обновить статус» redraws (no tracker follows that one), add 🏠 В меню; a 404 while tracking leaves 🏠 В меню only |
| trade status, where the tracker stops (accepted, every terminal status) | 🔄 Обновить статус while it can still move (accepted), then 🚀 Сессия из 5 сделок (#360, on a duration the demo still offers) · 📊 Новый анализ · 📡 К сигналам · 🏠 В меню |
| session status, live | 🔄 Обновить · ⏹ Остановить сессию; a 404 while tracking leaves 🏠 В меню only |
| session status, stopped | 🔄 Обновить · 🔁 Ещё сессия (#320) · 📊 Новый анализ · 📡 К сигналам · 🏠 В меню; without `settings` only 🔄 Обновить · 🏠 В меню, on a duration the demo no longer offers no «Ещё сессия» and no «Новый анализ» |
| the session's summary card (#318, a photo) | 🔁 Ещё сессия · 📊 Новый анализ · 📡 К сигналам · 🏠 В меню — the stopped status's without 🔄 Обновить, which edits a message's text; without `settings` only 🏠 В меню, on a duration the demo no longer offers no «Ещё сессия» and no «Новый анализ». «📊 Новый анализ» and «📡 К сигналам» answer with a new message under the card: the photo's edit is refused as gone (`screen.ts`) |
| `stakeInputInvalid` | the picker's way back |

«📊 Новый анализ» opens the analysis of the same pair and duration (`demo:an:<assetId>:<sec>`), never
a stake: the analysis is not skipped (Rule 20). «📡 К сигналам» opens the signals of the same
duration (`demo:sig:<sec>`, #382), or the main path's duration screen (`demo:sig`) on a duration the
demo no longer offers. The trackers' edits take the view and, for a last
edit that is not a status, why: `IntentTrackRequest.edit(text, view, end?)` with `end` a `TrackEnd`
(`not_found`, `deadline`), `SessionTrackRequest.edit(text, view, end?)` with `not_found` only. So
the last edit draws its next step too: the end of the path on a stop status, the menu alone on a
404, the refresh and the menu at the deadline of a live trade.

An old message sent before #350 keeps the keyboard it had: Telegram keeps old messages, and the rule
applies to what is sent after the deploy.

## Timing

`HANDLER_CALLS.menuButton` = 2 / 3 (34 s): the answer, `recordStart`, `readTradingAccess`, the photo
refused and the text card. `.commandRetry` = 1 / 2 (21 s): the answer, then `/account`'s or
`/settings`' one read and one message. Neither moves `HANDLER_BUDGET_MS`. No other handler gains a
call: the keyboards ride on the messages already sent.

## Boundaries

- **#202** — reminders to a user who connected and never started the demo: sent through
  `client-push.ts` with the demo button ([mailing.md](mailing.md)).
- **#121 / #326 / #327** — the real-mode screens: the seam types make them comply.
- **#321** — «📤 Поделиться» under the session's summary card (#318), added to
  `sessionCardKeyboard`'s rows: the card is sent with its keyboard, so it needs no exception.
