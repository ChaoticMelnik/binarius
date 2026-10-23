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
  `replyWithVideoHtml`, `replyWithPhotoHtml`, `sendPhotoByIdHtml` (#318), `sendHtmlById` (#537, the
  session's summary as a text) and
  `editMessagePhotoByIdHtml` (#568) require `reply_markup`, and only a `BotKeyboard` built by role
  (#475, [Roles, colours and rows](#roles-colours-and-rows-475)) is accepted. A grammY
  `InlineKeyboard`, a bare `{ inline_keyboard }`, a reply keyboard, `ForceReply` or
  `ReplyKeyboardRemove` does not compile.
- A message without one goes only through `replyHtmlWithoutNextStep`,
  `editMessageTextHtmlWithoutNextStep`, `editMessageTextByIdHtmlWithoutNextStep`,
  `replyWithPhotoHtmlWithoutNextStep` or `editMessagePhotoByIdHtmlWithoutNextStep` (#568), which take a `NoNextStepReason` from `NO_NEXT_STEP_REASONS`
  (the exception list below). The reason is not sent; its type makes every such call name an entry.
- `apps/backend/src/auth/client-push.ts`: `ClientPushMessage.reply_markup` is required and a
  `BotKeyboard` (#475), for the link
  push, every mailing ([mailing.md](mailing.md)) and the session's fallback text summary (#464,
  #537: the summary is the bot's message, the backend's text only when the bot cannot); its one message
  without a keyboard is the session's cycle message without an open trade's block, sent by
  `sendSessionTrade` and edited by `editSessionTrade` (#551), whose keyboard is optional: the open
  block's «⏹» only (#722, exception `session_trade` below).
- `send.typecheck.ts` holds the rule: a call without `reply_markup`, with it `undefined`, with a
  reply keyboard, with a grammY or a bare inline keyboard (#475), and a reason outside the list each
  fail `tsc` (an `@ts-expect-error` that starts compiling fails `pnpm check`).
- Not covered: `editMessageReplyMarkup` (it sets a keyboard, it cannot strip one by accident, and
  removing an old picker button's keyboard is deliberate, docs/bot-demo.md, as is stripping the launch
  screen's after a refused delete, #418, docs/bot-session.md), callback-query toasts
  (not messages), and the staff bot (`apps/backend/src/admin`, plain text by the owner's decision
  2026-10-02; its keyboards are built by role too, #475). A send method used outside the two seams
  is ESLint's to refuse (Rule 18).

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
  `editMessageTextHtml`, `editMessageTextByIdHtml`, `sendHtmlById` (#537) and their
  `…WithoutNextStep` forms (`send.ts`), the backend's `send` (the link push, mailings, the deposit
  and Stars pushes, the fallback summary), `sendSessionTrade`, `editSessionTrade` and `sendSessionWaiting` (`client-push.ts`).
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

## Roles, colours and rows (#475)

Every inline button of the client bot, of the backend's pushes and of the staff bot has a **role**
(`ButtonRole`, `packages/shared/src/bot-keyboard.ts`). The role alone gives its colour — the Bot
API's `style`; old clients ignore it and draw a plain button — and whether it takes a row of its
own (owner's decisions 1 and 3, 2026-10-14):

| Role | Meaning | `style` | Row |
|---|---|---|---|
| `forward` | the step forward of the funnel: an entry into demo or trading, a connection, a confirmation, a start of a session or a cycle, «💼 Включить реальный режим», a payment and a deposit, a package, «📊 Анализ» of a pair's summary, «📡 Показать сигналы», «🔀 Выбрать другую пару», «📤 Поделиться», a refund request, the staff bot's «Войти в админку» and «Подтвердить вход» | `success` (green) | its own |
| `forward_down` | the single trade's button on a ⬇️ signal | `danger` (red) | its own |
| `danger` | a stop of a session, the staff bot's «Это не я» | `danger` | shared |
| `stake` / `stake_risk` | a stake preset below / from `STAKE_RISK_THRESHOLD` ($10, inclusive), the latter labelled «· риск» (`stakeRiskButton`) | `success` / `danger` | a list |
| `up` / `down` | a pair of the signals list or of the wait, by its signal's direction | `success` / `danger` | a list |
| `secondary` | refresh, repeat, «➕ Ещё», «💵 Ставка»/«💵 Сумма», «✏️ Ввести», «🔁 Минимум», «🔄 Новый код», «✏️ Изменить адрес», «⭐ Купить», «🎮 В демо», «💵 Демо»/«💼 Реал» of /settings, «👥 Пригласить ещё», «📊 Анализ» at the end of a path | `primary` (blue) | shared |
| `nav` | the menu, a way back, the types, the pairs, a page, support, «🧭 Вручную», «📡 Сигналы», «⚙️ Режим», «⚙️ Режим торговли» of /settings and of the real-mode message (#686), «👥 Позвать», a choice among options (a level of /settings, a language, a type, a pair of the manual path) with its current ✅ | none | shared |

`BUTTON_ROLE_STYLES` and `FULL_WIDTH_ROLES` are the one place of the colour and the row: a new
button gets them by its role, never by a field of its own.

**The rows.** `keyboardOf(...groups)` lays out the groups a screen's author gives it, in order, a
group never sharing a row with the next:

- a group of actions (an array): every `forward`/`forward_down` button takes a row of its own; the
  others go two a row, and an odd run of three or more ends in a row of three, so none is left
  alone unless it is alone in its run;
- a list (`{ buttons, perRow }`: the signals, the pairs, the types, the presets): rows of `perRow`
  (2 or 3), the remainder as it falls.

`stackKeyboards(above, below)` puts one keyboard over another: the invoice's pay row over its next
step (#117), «📤 Поделиться» over the summary card's (#321). The menu joins the screen's last row of
actions (`withMenu`, `joinLast` in `apps/bot/src/keyboards.ts`), so «🏠 В меню» stands alone only when
it is the one such button — the rule of #506 that kept it alone, last, is gone.

**The widths.** A label in a row of two shows at most 14 characters, in a row of three 9
(`BUTTON_LABEL_WIDTHS`, owner's decision 4), counted by `buttonLabelWidth`: code points without
emoji, flags and their joiners, spaces collapsed. A row of its own keeps the catalog's limit of 64.
The long labels were shortened in the catalog, not moved to rows of their own
([bot-texts.md](bot-texts.md#abbreviations-475)).

**Held by:**

- the types: `BotKeyboard` is nominal — only `keyboardOf` and `stackKeyboards` construct one — and
  the seams take nothing else (`send.typecheck.ts`, `ClientPushMessage`); `BUTTON_ROLE_STYLES` is a
  `Record<ButtonRole, …>`;
- `bot-keyboard.test.ts` (K1–K14: the styles, the rows, the wire without `rows`, the widths);
- the gate `botKeyboardProblems` (`@binarius/shared/testing`) in `captureApi` of both apps: in every
  scene of every bot, push and staff-bot test a keyboard built outside `keyboardOf`, a non-forward
  action alone in its row while there is another such button, or a label wider than its row of two
  or three throws; lists are out of the width check (their labels are data, held by the formatters'
  tests in `texts.test.ts`);
- the catalog: `BUTTON_LABEL_ROWS` in `bot-texts.test.ts` gives every label of the buttons group (and
  the levels, the languages, «↩️ К списку оплат») the narrowest row it stands in, and checks its
  width there in Russian and in English;
- the scans: no grammY `InlineKeyboard` in `apps/bot/src` (`keyboards.test.ts`) and in
  `apps/backend/src` (`client-push.test.ts`) outside the tests;
- the tables of each builder: `keyboards.test.ts` (R1–R12), `stake-rows.test.ts` (the presets, $9.99
  green and $10.00 red), `client-push.test.ts` (C1–C6).

Not held: a label of data — a pair with a symbol longer than 8 characters in a row of two, an own
amount of $1 000 or more with «· риск», an email in «✅ Подтвердить: …» — and a staff override
longer than its row: Telegram cuts them with an ellipsis; the loader still takes any label up to
64 ([bot-texts.md](bot-texts.md#limits)).

**Button → role → colour → row**, by catalog key:

| Key | Label (ru) | Role | Colour | Row |
|---|---|---|---|---|
| `demoButton`, `tradeButton` | 🎮 Демо-торговля, 🚀 Торговать | forward | green | own |
| `settingsModeButton` | ⚙️ Режим торговли (/settings, the real-mode message, #686) | nav | — | 2 |
| `modeEnableButton` | 💼 Включить реальный режим (mode screen) | forward | green | own |
| `modeScreenButton` | ⚙️ Режим | nav | — | 2 |
| `modeBackDemoButton` | 🎮 В демо (mode screen) | secondary | blue | 2 |
| `modeConfirmButton`, `modeCancelButton` | ✅ Подтверждаю, ↩️ Отмена | forward, nav | green, — | own, own |
| `inviteButton` | 👥 Позвать | nav | — | 3 |
| `inviteShareButton`, `sessionShareButton` | 📤 Поделиться | forward | green | own |
| `buyButton` | ⭐ Купить | secondary | blue | 3 |
| `depositButton` | 💳 Пополнить | forward | green | own |
| `connectButton`, `confirmButton` | 🔗 Подключить аккаунт Binodex, ✅ Подтвердить: … | forward | green | own |
| `resendButton`, `changeEmailButton` | 🔄 Новый код, ✏️ Изменить адрес | secondary | blue | 2 |
| `menuButton` | 🏠 В меню | nav | — | 3 |
| `supportButton` | 💬 Поддержка | nav | — | 2 |
| `demoRetryButton`, `demoSignalsRefreshButton` | 🔄 Повторить, 🔄 Обновить | secondary | blue | 3 |
| `demoManualButton` | 🧭 Вручную | nav | — | 3 |
| `showSignalsButton` | 📡 Показать сигналы | forward | green | own |
| `launchCycleButton`, `sessionAgainButton` | 🚀 Запустить цикл, 🔁 Ещё сессия | forward | green | own |
| `stakeChangeButton`, `stakeMenuButton` | 💵 Ставка, 💵 Сумма | secondary | blue | 2 |
| `backToListButton` | ↩️ К списку | nav | — | 2 |
| `stakeCustomButton`, `stakeResetButton` | ✏️ Ввести, 🔁 Минимум | secondary | blue | 3 |
| `stakeBackAnalysisButton`, `stakeBackSettingsButton`, `stakeBackLaunchButton` | ↩️ К анализу, ↩️ Настройки, ↩️ К запуску | nav | — | 3 |
| `stakeBackButton` | ↩️ Назад | nav | — | alone |
| `demoAnalysisButton` | 📊 Анализ (a pair's summary) | forward | green | own |
| `newAnalysisButton` | 📊 Анализ (the end of a path) | secondary | blue | 3 |
| `toSignalsButton` | 📡 Сигналы | nav | — | 3 |
| `otherPairButton` | 🔀 Выбрать другую пару | forward | green | own |
| `analysisMoreButton`, `repeatAnalysisButton` | ➕ Ещё, 🔄 Заново | secondary | blue | 2, 3 |
| `demoBackPairButton`, `demoBackGroupsButton`, `demoBackPairsButton` | ↩️ К паре, ↩️ Типы, ↩️ Активы | nav | — | 3, 3, 2 |
| `demoPrevButton`, `demoNextButton` | ◀️, ▶️ | nav | — | 3 |
| `refreshIntentButton` | 🔄 Обновить | secondary | blue | 2 |
| `sessionStopButton` | ⏹ Остановить сессию | danger | red | alone |
| `settingsStakeDemoButton`, `settingsStakeRealButton` | 💵 Демо, 💼 Реал | secondary | blue | 2 |
| `levelAll`, `levelReduced`, `levelOff`; `languageRuButton`, `languageEnButton` | 🔔 Все, 🔕 Реже, ❌ Выключить; 🇷🇺 Русский, 🇬🇧 English (✅ on the current) | nav | — | 3 |
| `starsPayButton` | ⭐ Оплатить N | forward (the pay button) | green | own, first |
| `paysupportListButton`, `paysupportRefundButton` | ↩️ К списку оплат, ↩️ Нужен возврат: … | nav, forward | —, green | 2, own |
| `inviteMoreButton` (push) | 👥 Пригласить ещё | secondary | blue | alone |
| data: `signalButtonLabel` | EUR/USD ⬆️ 85% | up / down | green / red | list of 2 |
| data: `pairButtonLabel`, `groupButtonLabel` | EUR/USD 85%, 💱 Валюты · 12 | nav | — | list of 2 |
| data: `cycleStakeLabel` | $1.00 ✅, $10.00 · риск | stake / stake_risk | green / red | list of 3 / 2 |
| data: `buyPackageLabel` | 🪙 100 токенов — 50 ⭐ | forward | green | own |
| data: `stakeButtonLabel` | 🚀 Открыть сделку: ⬆️ Вверх · $1.00 | forward / forward_down | green / red | own |
| staff bot: `linkButton`, `confirmButton`, `denyButton` | Войти в админку, Подтвердить вход, Это не я | forward, forward, danger | green, green, red | own, own, alone |

## Exceptions

| `NoNextStepReason` | Where | Why |
|---|---|---|
| `session_status` (#536) | the session message (`trading-session.ts`: `replyWithPhotoHtmlWithoutNextStep` at the start — the picture of the signal's direction with the text as its caption (#568) — or `replyHtmlWithoutNextStep` without a direction or after a refused photo; `session-tracker.ts` through `editMessagePhotoByIdHtmlWithoutNextStep` (`editMessageMedia`) or `editMessageTextByIdHtmlWithoutNextStep` at its edits) | the session's head — its mode, pair, stake, expiry and signal's direction — above its trades: the next step of a running session is «⏹ Остановить сессию» under the backend's waiting message while the session waits for a signal, or under its open trade's block (#722), and of a stopped one the reply drawn in place of the waiting message (#587) and the summary's (#537); an edit without a keyboard also strips an old status message's buttons. A 404 while tracking draws «⚠️ Статус сессии недоступен.» under «🏠 В меню» ([bot-session.md](bot-session.md#the-session-message)). Not an active H1 session's message (#745): it has no waiting message and no open block, so it carries its «⏹» (`replyWithPhotoHtml` / `replyHtml`, `editMessagePhotoByIdHtml` / `editMessageTextByIdHtml`), dropped by the stop's edit |
| `in_progress` | the analysis' «⏳ Анализирую…» (`demo.ts`: an edit of the pressed message, or a new message at once under a photo — the analysis card, the session's summary card, #482) | a text result replaces it with its keyboard within the signal's budget, and after a signal's card (#482) it is deleted; a keyboard on it would let «📊 Анализ» be pressed twice. Residual: when the result's edit fails in transport or is refused for an unlisted reason, when the card's photo fails in transport and «⏳»'s edit is refused, or when its delete is refused, the bot sends nothing more (#126: a second message after an unknown delivery is worse than none), and «⏳» stays without a keyboard; the screen above it and /menu remain |

The backend's push has one exception of its own, by its method's type rather than a reason:

| Exception | Where | Why |
|---|---|---|
| `session_trade` (#464, #551; narrowed by #722) | `sendSessionTrade` and `editSessionTrade` (`apps/backend/src/auth/client-push.ts`), from the session notices (`apps/backend/src/trading/session-notices.ts`); their `reply_markup` is optional, and only the open block passes one | a cycle of a running session **without an open trade's block**, its settled trades listed in one message edited at each step, one of up to 60 trades in a row, without sound ([bot-session.md](bot-session.md#trade-messages-and-the-summary-464)): the waiting message right under the newest cycle (#536) carries «⏹ Остановить сессию» while the session waits for a signal, the open trade's block carries it while a trade is open (`session:stop:<id>:c`, #722; the result's edit takes it off), and the bot's summary at the end the end of the path (#537; the backend's fallback text «🏠 В меню»); a keyboard under every settled cycle would repeat them |

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
  (`session:stop:<id>`, `:w` under the waiting message the backend sends, `:c` under its open
  trade's block since #722) and
  `SESSION_STOP_PATTERN`. The bot and the backend's push build their buttons from it, so a pushed
  button lands on the bot's handler.
- `packages/shared/src/bot-keyboard.ts` (#475): the roles, `callbackButton`, `urlButton`,
  `webAppButton`, `payButton`, `switchInlineButton`, `keyboardOf`, `stackKeyboards`,
  `buttonLabelWidth` ([Roles, colours and rows](#roles-colours-and-rows-475)).
- `apps/bot/src/keyboards.ts`: `menuButton`/`menuKeyboard`, `withMenu` (the menu in the last row of
  actions), `joinLast`, `demoButton`/`demoKeyboard`, `supportButton`/`supportKeyboard`,
  `retryButton`/`retryKeyboard`, `backToAnalysisButton`/`backToAnalysisKeyboard`, `appendEndOfPath`
  (its «📡 Сигналы» carries `demo:sig`, the one list, since #685; «📊 Анализ» at 5 s, «📡 Сигналы» and
  the menu join the caller's last row of actions; its `beforeMenu` buttons go with the menu in a group
  of their own), `waitingStopKeyboard`;
  since #115 `inviteButton` (`invite`), `statusCardKeyboard`, `withInvite` (the deposit on its own
  row, then the invite and the menu) and `inviteKeyboard`
  ([referrals.md](referrals.md)); since #117 `buyButton`, `withBuy` (the deposit on its own row, then
  the purchase in one row with the caller's actions) and `buyPackagesKeyboard`
  ([stars.md](stars.md)); since #27 `depositButton` and `depositButtons` («💳 Пополнить», a `web_app`
  button with no callback data; no button without a URL; the only builders, `keyboards.test.ts`,
  [deposit.md](deposit.md)); `languageButton` (#508, `lang`, «🌐 Язык/Language») left the status
  card with #708: the entry is the `/language` command. The rows' shapes:
  `keyboards.test.ts` → «the rows and colours of the shared keyboards (#475)».
- The labels are catalog entries: `menuButton` «🏠 В меню», `newAnalysisButton` «📊 Анализ»,
  `toSignalsButton` «📡 Сигналы»; reused: `demoRetryButton` «🔄 Повторить»,
  `stakeBackAnalysisButton` «↩️ К анализу», `supportButton`, `demoButton`.

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

`//` separates rows, `|` the buttons of one row; green, red and blue are the roles'
([Roles, colours and rows](#roles-colours-and-rows-475)).

| Message (where) | Buttons |
|---|---|
| welcome, `accountNone` | 🔗 Подключить аккаунт Binodex |
| `confirmPrompt`, push `Pending` | ✅ Подтвердить: … (one per waiting link) |
| status card | 🎮 Демо-торговля // 👥 Позвать (#115) \| ⭐ Купить (#117) // 💳 Пополнить (#27, https only); in real: 🚀 Торговать // the same; no language button since #708, no mode button since #686 (the mode screen is under /settings) |
| the language screen (#508: `/language` since #708, `lang` of a status card sent before #708) | 🇷🇺 Русский \| 🇬🇧 English \| 🏠 В меню (the current one with ✅) |
| `languageNeedsStart`, `unavailable` after a language set (a write) | 🏠 В меню |
| account card (`sendAccountCard`: the code, the confirm, the recheck) | 🎮 Демо-торговля |
| push `Active` | 🎮 Демо-торговля |
| push `Taken`, `ExchangeFailed`, `Mismatch` | 🔗 Подключить аккаунт Binodex // 🏠 В меню |
| `blocked` (bot, push, a confirm or login refusal, a trade or session refusal) | 💬 Поддержка (a URL); in the stake picker and the amount screen 💬 Поддержка \| the way back |
| `unavailable` after `/start`, `/menu`, «🏠 В меню» | 🔄 Повторить (`menu`) |
| `unavailable` after `/account`, `/settings`, `/invite` | 🔄 Повторить (`cmd:…`) \| 🏠 В меню |
| `unavailable` after the picker's way back (`settings`) | 🔄 Повторить (`settings`) \| 🏠 В меню |
| `unavailable` after a level set (a write) | 🏠 В меню |
| `/settings` | 🔔 Все \| 🔕 Реже \| ❌ Выключить (✅ on the current) // 💵 Демо \| 💼 Реал // ⚙️ Режим торговли (`mode`, the mode screen as a new message, #686) \| 🏠 В меню |
| `/account` with an active link | 🎮 Демо-торговля // 🏠 В меню |
| `/account` with a waiting link or none active | ✅ Подтвердить: … // 🔗 Подключить аккаунт Binodex, each on its own row |
| `/support` | 💬 Поддержка \| 🏠 В меню |
| `/help` | 🏠 В меню |
| `/invite`, «👥 Позвать» (#115) | 📤 Поделиться (a URL) // 🏠 В меню |
| `inviteNeedsStart` (`/invite` before the first `/start`) | 🏠 В меню |
| `/buy`, «⭐ Купить» (#117, [stars.md](stars.md)) | a package per row (`buy:<code>`) // 🏠 В меню |
| `buyNeedsAccount` | 🔗 Подключить аккаунт Binodex |
| `buyPackageGone` | the packages // 🏠 В меню |
| `unavailable` after `/buy` or a package (reads) | 🔄 Повторить (`buy`, `buy:<code>`) \| 🏠 В меню |
| the Stars invoice (`replyWithInvoiceStars`, `send.ts`) | ⭐ Оплатить N (Telegram's pay button, first by the Bot API's rule) // 🏠 В меню |
| `starsCredited`, `starsPending`; the reconciler's push `starsCredited` | 🏠 В меню |
| `starsHeld` | 💬 Поддержка \| 🏠 В меню |
| `/paysupport`, «↩️ К списку оплат» (`ps:l`, #118, [stars.md](stars.md#paysupport)) | ↩️ Нужен возврат: <date> per open payment (`ps:r:<id>`), each on its own row // 💬 Поддержка \| 🏠 В меню |
| `paysupportEmpty` | 💬 Поддержка \| 🏠 В меню |
| `unavailable` after `/paysupport` (a read) | 🔄 Повторить (`ps:l`) \| 🏠 В меню |
| every answer to «Нужен возврат» (a write), `unavailable` included | ↩️ К списку оплат (`ps:l`) \| 🏠 В меню |
| the `insufficient_tokens` refusals of a trade and a session | 💳 Пополнить (#27, https only) // ⭐ Купить \| ↩️ К анализу \| 🏠 В меню |
| login: `emailPrompt`, `emailInvalid`, `codeRequestStale`, a refusal without the code buttons, `unavailable` | 🏠 В меню (the dialog is left as `/menu` leaves it) |
| login: `codeSent`, `codeSentUnknown`, `codeInvalid`, a refusal with them | 🔄 Новый код \| ✏️ Изменить адрес |
| the launch screen (#320, real mode) | 🚀 Запустить цикл · REAL // 💵 Ставка \| ↩️ К списку; deleted once the session's status is sent (#418) |
| the amount screen (#476) | the presets three a row (green, ✅ on the one in effect) // from $10 two a row (red, «· риск») // ✏️ Ввести \| ↩️ К списку (or ↩️ К анализу); without presets the way back alone |
| the stake picker (#297, #326) | the presets as on the amount screen // ✏️ Ввести \| 🔁 Минимум (with a saved stake) \| ↩️ Настройки (or ↩️ К анализу, ↩️ К запуску); its retry 💵 Сумма \| the way back; its prompt ↩️ Назад |
| the signals list (#320, #685) | the pairs two a row, green ⬆️ / red ⬇️ // 🔄 Обновить \| 🧭 Вручную \| 🏠 В меню |
| its empty screen, the wait for the signals (#664) | 🧭 Вручную \| 🏠 В меню |
| its refusals | 🔄 Повторить \| 🧭 Вручную \| 🏠 В меню |
| the types (#685) | the types two a row; a catalog without one: 🔄 Повторить |
| a type's page | its pairs two a row // ◀️ \| ↩️ Типы \| ▶️ (where pages exist) |
| a pair's summary (#685) | 📊 Анализ // ↩️ Активы \| ↩️ Типы |
| a pair the catalog refuses | ↩️ Активы \| ↩️ Типы, or ↩️ Типы alone |
| the analysis (#360), demo with the amounts (#482) | the presets // ✏️ Ввести \| ➕ Ещё // 🔄 Заново \| ↩️ К паре \| ↩️ Типы |
| the analysis, real or without the amounts | 🚀 Сессия из 5 циклов on a signal // ➕ Ещё \| 🔄 Заново // ↩️ К паре \| ↩️ Типы; without a signal (#509) 🔄 Заново \| ↩️ К паре \| ↩️ Типы, or the wait (🧭 Вручную \| 🏠 В меню, #664) |
| «➕ Ещё» expanded in place | [the presets, or 🚀 Сессия из 5 циклов] // 🚀 Открыть сделку: ⬆️/⬇️ … (green on ⬆️, red on ⬇️) // [✏️ Ввести \|] 💵 Сумма \| 🔄 Заново … ↩️ К паре \| ↩️ Типы, two or three a row |
| the stake press refused or failed before or at the create (`unavailable`, `stakeOutcomeUnknown`, `statusAmbiguous`, `stakeBalanceMissing`, a refusal without its own button) | ↩️ К анализу \| 🏠 В меню |
| the session start refused or failed, `sessionJustEnded` | ↩️ К анализу \| 🏠 В меню; `no_signal` (#509) → the wait for the signal (#664): 🧭 Вручную \| 🏠 В меню, in place of the pressed screen or as a new message |
| a cycle door's press (`demo:l`, #664): the pair not in the signals list, or the list not read | the wait for the signal: the other pairs with a signal now (`demo:l:<id>:5`, two a row, for 30 s) // 🧭 Вручную \| 🏠 В меню |
| the signals list after 30 s, a wait past its bound or at the bot's stop (#664) | 📡 Показать сигналы (`demo:sig`) // 🧭 Вручную \| 🏠 В меню |
| the mode screen (`mode`, `mode:x`; #474, [trading-mode.md](trading-mode.md#the-bot)) | in demo 💼 Включить реальный режим (`mode:r`) // 🏠 В меню; in real 🎮 В демо (`mode:d`) \| 🏠 В меню |
| its confirm (`mode:r`) | ✅ Подтверждаю (`mode:r:ok`) // ↩️ Отмена (`mode:x`, the step back, so no menu of its own) |
| a switch's result (`modeEnabled`, `modeDisabled`) | 🏠 В меню |
| every refusal or failure of the mode screen and its switches (`modeBelowMinimum`, `stakeBalanceMissing`, `tradingDemoOnly`, `unavailable`, `modeOutcomeUnknown`) | ⚙️ Режим (`mode:x`, a read) \| 🏠 В меню — never a switch |
| the mode screen's access refusals in demo (`accountNone`, `statusAmbiguous`, `stakeBalanceMissing`) | 🔗 Подключить аккаунт Binodex // 🏠 В меню; 🏠 В меню |
| the trade's refresh failed | 🔄 Повторить (`intent:<id>`) \| 🏠 В меню; `intentStatusUnavailable` (404) → 🏠 В меню |
| the session's stop failed under an old status message (#536) | 🏠 В меню; `sessionStatusUnavailable` (404) → 🏠 В меню; the pressed message stays, its «⏹» pressed again is safe |
| the session's stop failed under the waiting message (#587), drawn in place of it | a stop whose outcome is unknown: ⏹ Остановить сессию again (`waitingStopKeyboard`, `session:stop:<id>:w`; its next step is the stop itself); `sessionStatusUnavailable` (404) and a failed read after a 409 → 🏠 В меню; as a new message when the edit is refused as gone: 🏠 В меню — never a second «⏹» |
| trade status, live (planned, reserved, queued, submitting, unknown, reconciling, manual_review) | 🔄 Обновить while the tracker follows the message; its last edit at the deadline, and the message «🔄 Обновить» redraws (no tracker follows that one): 🔄 Обновить \| 🏠 В меню; a 404 while tracking leaves 🏠 В меню only |
| trade status, where the tracker stops (accepted, every terminal status) | 🚀 Сессия из 5 циклов (#360; at 5 s for a trade of any duration, #685) // accepted: 🔄 Обновить \| 📊 Анализ // 📡 Сигналы \| 🏠 В меню; terminal: 📊 Анализ \| 📡 Сигналы \| 🏠 В меню |
| the session message (#536; the picture of its signal's direction with the text as its caption, #568, or the text) | none (`session_status`, Exceptions); a 404 while tracking leaves 🏠 В меню only |
| the waiting message (#536, sent by the backend while the session waits for a signal, #722) | ⏹ Остановить сессию (`session:stop:<id>:w`, red) |
| the cycle message with an open trade's block (#722, sent or edited by the backend; a session the sender read stopped gets none) | ⏹ Остановить сессию (`session:stop:<id>:c`, red); the result's edit takes it off |
| the reply to the stop under the open trade's block (#722, a new message) | the end of the path (`sessionCardKeyboard`), as `/stop`'s for one session; a failure: 🏠 В меню, the block's «⏹» stays |
| the reply to the stop under the waiting message (drawn in place of it, #587; a new message only when its edit is refused as gone), `/stop` (#122) with one session stopped, and an old status message under its old «⏹» (drawn in place) | the end of the path (`sessionCardKeyboard`): 🔁 Ещё сессия (#320) // 📊 Анализ \| 📡 Сигналы // 💳 Пополнить (#27, https only) // 👥 Позвать (#115) \| 🏠 В меню; without `settings` 💳 Пополнить // 👥 Позвать \| 🏠 В меню; a session of an older duration (15 s) gets them at 5 s (#685); stopped by `no_signal_timeout` (#509): 🔀 Выбрать другую пару // 💳 Пополнить // 👥 Позвать \| 🏠 В меню |
| an old status message's «🔄 Обновить» (`session:<id>`, before #536) | its keyboard stripped, nothing sent |
| `/stop`: `sessionNoneActive`, `sessionsStopped`, `unavailable` | 🏠 В меню |
| `/stop`'s mode line (#473): `modeStopReset`, `modeNotReset` | 🏠 В меню |
| `/stop`'s mode line (#473): `modeOutcomeUnknown` | ⚙️ Режим (`mode`, a read, the screen as a new message) \| 🏠 В меню — never a switch |
| the session's summary (#318, #537: the card's photo with the whole summary as its caption, with sound; a text when there is no trade or the photo is refused) | 📤 Поделиться (not on a session without a trade) (#321, by an edit right after the send, `stackKeyboards`; the card keeps the rest when the edit fails) // the end of the path as above. «📊 Анализ» and «📡 Сигналы» answer with a new message under the card: the photo's edit is refused as gone (`telegram-refusals.ts`) |
| the backend's fallback summary (#537) | 🏠 В меню; by `no_signal_timeout` 🔀 Выбрать другую пару // 🏠 В меню |
| `stakeInputInvalid` | the picker's way back |
| the first-session reminders (#202) | 🎮 Демо-торговля |
| the analysis reminder `analysisUnusedReminder` (#484, the backend's mailing, [mailing.md](mailing.md)) | 📊 Анализ (`demo:an:<assetId>:<sec>` of the analysed pair and duration, green) — one button, as the chain's reminders |
| the low-token nudges (#123) | 50 %: 🎮 Демо-торговля (🚀 Торговать in real); 80 % and 100 %: 💳 Пополнить (the entry without https) // ⭐ Купить |
| the inviter's reward notification `referralRewarded` (#576, the backend's mailing, [mailing.md](mailing.md)) | 👥 Пригласить ещё (`cmd:invite`, the /invite screen as a new message) — one button, as the reminders |
| the real-mode message after a deposit `realModeByDeposit` (#686, the backend's mailing, [mailing.md](mailing.md#the-real-mode-notification-686)) | ⚙️ Режим торговли (`mode`, the mode screen) \| 🏠 В меню, in the user's language |
| the staff bot (`apps/backend/src/admin/telegram.ts`) | `/start`: Войти в админку; the login prompt: Подтвердить вход // Это не я (red) |

«📊 Анализ» opens the analysis of the same pair at 5 s (`demo:an:<assetId>:5`), never
a stake: the analysis is not skipped (Rule 20). «📡 Сигналы» opens the signals list
(`demo:sig`, the list at 5 s since #685; `demo:sig:<sec>` of older buttons leads there too).
«🔀 Выбрать другую пару» (#509) carries the same data: a session stopped for want of a signal
is not offered its own pair again (a start refused for want of one waits for it since #664); the summary of such a
stop — the bot's (#537), and the backend's fallback text — draws `DEMO_SIGNALS_CALLBACK_DATA` (`bot-navigation.ts`). The trackers' edits take what they draw and, for a last
edit that is not a status, why: `IntentTrackRequest.edit(text, view, end?)` with `end` a `TrackEnd`
(`not_found`, `deadline`), `SessionTrackRequest.edit(drawing, end?)` with `not_found` only. So
the last edit draws its next step too: the end of the path on a trade's stop status, the menu alone
on a 404, the refresh and the menu at the deadline of a live trade; the session message's edits
draw none (#536, `session_status`; an H1 session's too since #775).

An old message sent before #350 keeps the keyboard it had: Telegram keeps old messages, and the rule
applies to what is sent after the deploy.

## The language screen (#508)

The `/language` command (#708, in the command menu and in `/help`,
[bot-start.md](bot-start.md#command-menu)) sends the screen as a new message, in the user's
language, «🇷🇺 Русский | 🇬🇧 English | 🏠 В меню» in one row (#475) with ✅ on the current one
(`apps/bot/src/language-screen.ts`). A language pressed (`lang:ru`, `lang:en`, a write in
`WRITE_CALLBACK_PREFIXES`) saves it (`POST /users/language`), puts it into the bot's cache and
redraws the same screen in place in the new language — an edit refused as gone sends it anew. The
current language pressed is only answered. A user with no row yet (404 `user_not_found`) gets
`languageNeedsStart`; any other failure `unavailable` under «🏠 В меню», with the cache entry
dropped, so the next update reads the language again instead of inferring it from the failure
([bot-texts.md](bot-texts.md#languages)).

Before #708 the entry was «🌐 Язык/Language» (`lang`) on the status card. A card sent before the
deploy, a pinned one included, keeps that button until the next `/start`, `/menu` or «🏠 В меню»,
and `lang` still opens the screen the same way. `/language` before the first `/start` opens the
screen in the client's language (the language read answers 404, `botLanguageOf` of the update's
`language_code`), and a choice there gets `languageNeedsStart` (`language-screen.test.ts` LS10).
`HANDLER_CALLS.languageCommand` = 0 / 1, as `/help`; the language read is the middleware's.

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
