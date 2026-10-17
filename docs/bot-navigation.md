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
  `replyWithVideoHtml`, `replyWithPhotoHtml`, `sendPhotoByIdHtml` (#318) and
  `editMessagePhotoByIdHtml` (#568) require `reply_markup`, and only an inline keyboard
  (`InlineKeyboard` or `InlineKeyboardMarkup`) is accepted. A reply keyboard, `ForceReply` or
  `ReplyKeyboardRemove` does not compile.
- A message without one goes only through `replyHtmlWithoutNextStep`,
  `editMessageTextHtmlWithoutNextStep`, `editMessageTextByIdHtmlWithoutNextStep`,
  `replyWithPhotoHtmlWithoutNextStep` or `editMessagePhotoByIdHtmlWithoutNextStep` (#568), which take a `NoNextStepReason` from `NO_NEXT_STEP_REASONS`
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

## The width (#506)

Telegram sizes a message bubble to its longest line, and an inline keyboard takes the bubble's
width, so a short text would leave narrow buttons and no room for two in a row. The Bot API has no
width setting. Every **text** message therefore ends with the width spacer `BOT_MESSAGE_SPACER`
(`packages/shared/src/bot-message-width.ts`): a line break, then `BOT_MESSAGE_SPACER_LENGTH` = 26
characters U+2800 BRAILLE PATTERN BLANK. The character is a symbol, not whitespace, so the Bot API's
trim keeps it; 26 of them with no break between make one line about 302 pt wide on an iPhone at the
default font size (0.684 em measured in the macOS system font), the full text width of the bubble
with one empty-looking line between the text and the keyboard; on Telegram Desktop it is about
230 px of 430. It goes on a line of its own after the text, so the chat preview and the
notification open with the text and the text's last word never wraps onto it.

- Where: the two seams append it when they unwrap `TelegramHtml` — the bot's `replyHtml`,
  `editMessageTextHtml`, `editMessageTextByIdHtml` and their `…WithoutNextStep` forms
  (`send.ts`), the backend's `send` (the link push, mailings, the deposit and Stars pushes, the
  summary), `sendSessionTrade`, `editSessionTrade` and `sendSessionWaiting` (`client-push.ts`).
  Nothing before the seams sees it: the catalog, the overrides, the texts' builders and the
  trackers' dedupe keys hold the text alone.
- Not on captions (a photo or a video, `editMessageMedia`, the inline share result), the Stars
  invoice, callback toasts or the staff bot: a picture sets a caption's width, and the others are
  not bubbles of the client chat.
- The limit: a text message holds `BOT_TEXT_LIMIT` = 4096 − 27 = 4069 characters after entities
  parsing (`botHtmlText`'s default, the text descriptions of `BOT_TEXT_MESSAGES`, the session
  cycle's `fits`, `telegramTextProblems`' default); captions keep 1024. An override longer than
  that after parsing is refused as `too_long` ([bot-texts.md](bot-texts.md#limits)).
- Tuning: the owner sets N by looking at the clients — two empty lines on a phone mean N is too
  large, a bubble narrower than the screen too small. Windows and Android glyph widths were not
  measured.
- Held by: `send.test.ts` (each function of the bot's seam), `client-push.test.ts` (each method of
  the backend's), `captureApi` (`apps/bot/src/testing.ts` → `refuseWidthSpacerMisuse`: in every
  scene of every bot test a `sendMessage` or `editMessageText` without the spacer at its end
  throws, and a caption, an inline answer or a toast with U+2800 throws; the call is recorded
  without the spacer), `pushedText` in the backend's suites (`apps/backend/src/admin/testing.ts`),
  `bot-message-width.test.ts` (the spacer, the limit, no text limit above it).

**Rows.** Two buttons share a row when both labels are at most 18 characters (the longest of the
pairs is «👥 Пригласить друга»); a longer label keeps a row of its own, and «🏠 В меню» is always
alone, last. The pairs: «👥 Пригласить друга | ⭐ Купить токены» on the status card, «⭐ Купить
токены | 💳 Пополнить» in the `insufficient_tokens` refusals (`withBuy`), «📊 Новый анализ | 📡 К
сигналам» at the end of a path (`appendEndOfPath`), «💳 Пополнить | 👥 Пригласить друга» at the end of
a session (`withInvite`, `appendSessionEnd`), «💳 Пополнить | 🌐 Язык / Language» last on the status
card (#508). Without an https cashier a pair shrinks to one button,
never an empty row. The order of the buttons and their callback data did not change. Screens whose
rows were already two or three wide, and /buy (a package label is 39 characters), keep theirs.

## Exceptions

| `NoNextStepReason` | Where | Why |
|---|---|---|
| `session_status` (#536) | the session message (`trading-session.ts`: `replyWithPhotoHtmlWithoutNextStep` at the start — the picture of the signal's direction with the text as its caption (#568) — or `replyHtmlWithoutNextStep` without a direction or after a refused photo; `session-tracker.ts` through `editMessagePhotoByIdHtmlWithoutNextStep` (`editMessageMedia`) or `editMessageTextByIdHtmlWithoutNextStep` at its edits) | the session's head — its mode, pair, stake, expiry and signal's direction — above its trades: the next step of a running session is «⏹ Остановить сессию» under the backend's waiting message, always the last message of the session, and of a stopped one the reply drawn in place of the waiting message (#587), the summary's and the card's; an edit without a keyboard also strips an old status message's buttons. A 404 while tracking draws «⚠️ Статус сессии недоступен.» under «🏠 В меню» ([bot-session.md](bot-session.md#the-session-message)) |
| `in_progress` | the analysis' «⏳ Анализирую…» (`demo.ts`: an edit of the pressed message, or a new message at once under a photo — the analysis card, the session's summary card, #482) | a text result replaces it with its keyboard within the signal's budget, and after a signal's card (#482) it is deleted; a keyboard on it would let «📊 Анализ» be pressed twice. Residual: when the result's edit fails in transport or is refused for an unlisted reason, when the card's photo fails in transport and «⏳»'s edit is refused, or when its delete is refused, the bot sends nothing more (#126: a second message after an unknown delivery is worse than none), and «⏳» stays without a keyboard; the screen above it and /menu remain |

The backend's push has one exception of its own, by its method's type rather than a reason:

| Exception | Where | Why |
|---|---|---|
| `session_trade` (#464, #551) | `sendSessionTrade` and `editSessionTrade` (`apps/backend/src/auth/client-push.ts`), from the session notices (`apps/backend/src/trading/session-notices.ts`); their types take only the text | a cycle of a running session, its settled trades listed in one message edited at each step, one of up to 60 trades in a row, without sound ([bot-session.md](bot-session.md#trade-messages-and-the-summary-464)): the waiting message right under the newest cycle (#536) carries «⏹ Остановить сессию», and the summary at the end «🏠 В меню»; a keyboard under every cycle would repeat them |

One more exception is not a `NoNextStepReason`, because it is not a message in the user's own
chat with the bot:

| Answer | Where | Why |
|---|---|---|
| the inline share result (#321, #538) | `answerInlineQueryPhotoHtml` and `answerInlineQueryEmpty` (`send.ts`), from `session-share.ts`; their types take no `reply_markup` | the promo card is posted, «via @bot», into a chat the user picked; the bot's buttons there would act for whoever presses them. The link in its caption (`t.me/<bot>?start=ref_<code>`, the sender's; `t.me/<bot>?start=share` for a sender without a code) is the way into the bot |
| the promo card's post to the storage channel (#538) | `sendPhotoToStorage` (`send.ts`), from `session-share.ts`; its type takes no caption and no `reply_markup` (`send.typecheck.ts`) | not a message to a user: the post in the owner's private channel `SHARE_STORAGE_CHAT_ID` exists for the photo's `file_id`, which the inline answer names |

## Shared buttons

- `packages/shared/src/bot-navigation.ts`: `DEMO_CALLBACK_DATA` (`demo`), `CONNECT_CALLBACK_DATA`
  (`connect`), `MENU_CALLBACK_DATA` (`menu`), `commandRetryCallbackData` (`cmd:account`,
  `cmd:settings`, `cmd:invite` since #115) and its pattern, `BUY_CALLBACK_DATA` (`buy`) and
  `buyPackageCallbackData` (`buy:<code>`, #117), `PAYSUPPORT_LIST_CALLBACK` (`ps:l`) and
  `paysupportRefundCallbackData` (`ps:r:<payment id>`, #118), `demoAnalysisCallbackData`
  (`demo:an:<assetId>:<sec>`, moved from `demo.ts` by #484 for the analysis reminder), `supportUrl()`, and since #27
  `CASHIER_PAGE_PATH` (`/cashier`, the page `web` serves) and `cashierUrlOf(origin)` (the page's
  URL on an https origin, none otherwise), and since #536 `sessionStopCallbackData`
  (`session:stop:<id>`, `:w` under the waiting message the backend sends) and
  `SESSION_STOP_PATTERN`. The bot and the backend's push build their buttons from it, so a pushed
  button lands on the bot's handler.
- `apps/bot/src/keyboards.ts`: `menuKeyboard`, `withMenu`, `demoKeyboard`, `supportKeyboard`,
  `retryKeyboard`, `backToAnalysisKeyboard`, `appendEndOfPath` (its «📡 К сигналам» carries the
  path's duration, `demo:sig:<sec>`, since #382; «📊 Новый анализ» and it share a row, #506; its
  `beforeMenu` rows go right above the menu);
  since #115 `inviteButton` (`invite`), `statusCardKeyboard`, `withInvite` (the deposit and the
  invite in one row, then the menu) and `inviteKeyboard`
  ([referrals.md](referrals.md)); since #117 `buyButton`, `withBuy` (the purchase and the deposit in
  one row over the caller's rows) and `buyPackagesKeyboard`
  ([stars.md](stars.md)); since #27 `depositButton` and `depositButtons` (#506, the button for a row
  shared with another; «💳 Пополнить», a `web_app`
  button with no callback data; no button without a URL; the only builders, `keyboards.test.ts`,
  [deposit.md](deposit.md)); since #508 `languageButton` (`lang`, «🌐 Язык / Language», the label in
  both languages so a user who cannot read the bot's language still finds it). The rows' shapes:
  `keyboards.test.ts` → «the rows (#506)».
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
screen, the picker's way back to /settings, the trade's refresh. A press that
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
| status card | 🎮 Демо-торговля \| 💼 Реальный режим (in real: 🚀 Торговать \| 🎮 Вернуться в демо, both opening the mode screen, #474) · 👥 Пригласить друга (#115) \| ⭐ Купить токены (#117) · 💳 Пополнить (#27, https only) \| 🌐 Язык / Language (#508) |
| the language screen (`lang`, #508) | 🇷🇺 Русский \| 🇬🇧 English (the current one with ✅) · 🏠 В меню |
| `languageNeedsStart`, `unavailable` after a language set (a write) | 🏠 В меню |
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
| the `insufficient_tokens` refusals of a trade and a session | ⭐ Купить токены \| 💳 Пополнить (#27, https only) · ↩️ Назад к анализу · 🏠 В меню |
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
| the session's stop failed under an old status message (#536) | 🏠 В меню; `sessionStatusUnavailable` (404) → 🏠 В меню; the pressed message stays, its «⏹» pressed again is safe |
| the session's stop failed under the waiting message (#587), drawn in place of it | a stop whose outcome is unknown: ⏹ Остановить сессию again (`waitingStopKeyboard`, `session:stop:<id>:w`; its next step is the stop itself); `sessionStatusUnavailable` (404) and a failed read after a 409 → 🏠 В меню; as a new message when the edit is refused as gone: 🏠 В меню — never a second «⏹» |
| trade status, live (planned, reserved, queued, submitting, unknown, reconciling, manual_review) | 🔄 Обновить статус while the tracker follows the message; its last edit at the deadline, and the message «🔄 Обновить статус» redraws (no tracker follows that one), add 🏠 В меню; a 404 while tracking leaves 🏠 В меню only |
| trade status, where the tracker stops (accepted, every terminal status) | 🔄 Обновить статус while it can still move (accepted), then 🚀 Сессия из 5 циклов (#360, on a duration the demo still offers) · 📊 Новый анализ \| 📡 К сигналам (📡 К сигналам alone on a duration the demo no longer offers) · 🏠 В меню |
| the session message (#536; the picture of its signal's direction with the text as its caption, #568, or the text) | none (`session_status`, Exceptions); a 404 while tracking leaves 🏠 В меню only |
| the waiting message (#536, sent by the backend) | ⏹ Остановить сессию (`session:stop:<id>:w`) |
| the reply to the stop under the waiting message (drawn in place of it, #587; a new message only when its edit is refused as gone), `/stop` (#122) with one session stopped, and an old status message under its old «⏹» (drawn in place) | the end of the path (`sessionCardKeyboard`): 🔁 Ещё сессия (#320) · 📊 Новый анализ \| 📡 К сигналам · 💳 Пополнить (#27, https only) \| 👥 Пригласить друга (#115) · 🏠 В меню; without `settings` only 💳 Пополнить \| 👥 Пригласить друга · 🏠 В меню, on a duration the demo no longer offers no «Ещё сессия» and no «Новый анализ»; stopped by `no_signal_timeout` (#509): 🔀 Выбрать другую пару · 💳 Пополнить \| 👥 Пригласить друга · 🏠 В меню |
| an old status message's «🔄 Обновить» (`session:<id>`, before #536) | its keyboard stripped, nothing sent |
| `/stop`: `sessionNoneActive`, `sessionsStopped`, `unavailable` | 🏠 В меню |
| `/stop`'s mode line (#473): `modeStopReset`, `modeNotReset` | 🏠 В меню |
| `/stop`'s mode line (#473): `modeOutcomeUnknown` | ⚙️ Режим (`mode`, a read, the screen as a new message) · 🏠 В меню — never a switch |
| the session's summary card (#318, a photo) | 📤 Поделиться (#321, by an edit right after the send; the card keeps the rest when the edit fails) · 🔁 Ещё сессия · 📊 Новый анализ \| 📡 К сигналам · 💳 Пополнить (#27, https only) \| 👥 Пригласить друга (#115) · 🏠 В меню — the end of the path; without `settings` only 💳 Пополнить \| 👥 Пригласить друга · 🏠 В меню, on a duration the demo no longer offers no «Ещё сессия» and no «Новый анализ»; by `no_signal_timeout` (#509) 🔀 Выбрать другую пару in place of «Ещё сессия», «Новый анализ» and «К сигналам». «📊 Новый анализ» and «📡 К сигналам» answer with a new message under the card: the photo's edit is refused as gone (`telegram-refusals.ts`) |
| `stakeInputInvalid` | the picker's way back |
| the analysis reminder `analysisUnusedReminder` (#484, the backend's mailing, [mailing.md](mailing.md)) | 📊 Новый анализ (`demo:an:<assetId>:<sec>` of the analysed pair and duration) — one button, as the chain's reminders |

«📊 Новый анализ» opens the analysis of the same pair and duration (`demo:an:<assetId>:<sec>`), never
a stake: the analysis is not skipped (Rule 20). «📡 К сигналам» opens the signals of the same
duration (`demo:sig:<sec>`, #382), or the main path's duration screen (`demo:sig`) on a duration the
demo no longer offers. «🔀 Выбрать другую пару» (#509) carries the same data: a session stopped or
refused for want of a signal is not offered its own pair again; the backend's summary of such a
stop draws it from `signalsCallbackDataFor` (`bot-navigation.ts`). The trackers' edits take what they draw and, for a last
edit that is not a status, why: `IntentTrackRequest.edit(text, view, end?)` with `end` a `TrackEnd`
(`not_found`, `deadline`), `SessionTrackRequest.edit(drawing, end?)` with `not_found` only. So
the last edit draws its next step too: the end of the path on a trade's stop status, the menu alone
on a 404, the refresh and the menu at the deadline of a live trade; the session message's edits
draw none (#536, `session_status`).

An old message sent before #350 keeps the keyboard it had: Telegram keeps old messages, and the rule
applies to what is sent after the deploy.

## The language screen (#508)

«🌐 Язык / Language» (`lang`) on the status card sends the screen as a new message, in the user's
language, «🇷🇺 Русский | 🇬🇧 English» with ✅ on the current one, then «🏠 В меню»
(`apps/bot/src/language-screen.ts`). A language pressed (`lang:ru`, `lang:en`, a write in
`WRITE_CALLBACK_PREFIXES`) saves it (`POST /users/language`), puts it into the bot's cache and
redraws the same screen in place in the new language — an edit refused as gone sends it anew. The
current language pressed is only answered. A user with no row yet (404 `user_not_found`) gets
`languageNeedsStart`; any other failure `unavailable` under «🏠 В меню», with the cache entry
dropped, so the next update reads the language again instead of inferring it from the failure
([bot-texts.md](bot-texts.md#languages)).

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
