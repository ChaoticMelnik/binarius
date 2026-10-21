# The demo: the signals, an asset and the analysis on a fresh catalog (issues #125, #126, #320, #382, #476, #664, #685)

The status card's «🎮 Демо-торговля» button (#24, [bot-menu.md](bot-menu.md)) opens «Сигналы
сейчас» at once (#320, #685, [The entry](#the-entry-685), [The signals screen](#the-signals-screen-320)):
the pairs with a signal on the last closed candle of the backend's `5s` scanner, each leading to
the amount of a cycle of trades (#476, [The amount screen](#the-amount-screen-476)), whose press
starts the cycle. Every trade is 5 s (`DEMO_DURATIONS_SEC`, owner 2026-10-20, #685; 5 and 15 s from
#313 to #685): there is no choice of a duration. The list has «🧭 Выбрать пару вручную», which
leads to four more screens in one message: the asset types, one type's pairs by page, the summary
of a pair with «📊 Анализ», and the analysis. Every screen reads the broker's pairs again through
`GET /trading/pairs` ([pairs-catalog.md](pairs-catalog.md)) and draws nothing from an earlier
read. «📊 Анализ» shows the analysis of the pair's candles by Signal module v1 (#126,
[The analysis](#the-analysis)). Its first row is the session of five cycles (`DEFAULT_SESSION_CYCLES`, #552) on a signal (#360;
since #509 never without one, [bot-session.md](bot-session.md#the-button)); on a signal, «➕ Ещё» draws the single
trade's stake button in place, whose press is #127 ([bot-demo-trade.md](bot-demo-trade.md)).
After the user chose a pair the bot never says «сигнала нет» (#664, owner 2026-10-21): the pair
without a signal, the analysis without one and the empty list wait for it, and the bot edits the
same message once it comes ([The wait for a signal](#the-wait-for-a-signal-664)).

```bash
pnpm test --project unit apps/bot/src packages/broker-rest packages/shared/src/catalog.test.ts apps/backend/src/trading/pairs-routes.test.ts   # needs no database or Redis
```

## Components

- `apps/bot/src/demo-catalog.ts` — the check, with no Telegram and no texts:
  `DEMO_DURATIONS_SEC`, `DEMO_DURATION_SEC`, `LEGACY_DEMO_DURATIONS_SEC` (#685), `DEMO_PAGE_SIZE`, `isOpen`, `pairsOf`,
  `openPairsOf`, `pageOf`, `pageIndexOf`, `durationOptions`, `checkDemoPair`, `checkDemoTrade`,
  `readDemoCatalog`, `readDemoTrade` (#631 removed #379's `checkDemoCycle` and `readDemoCycle`).
- `apps/bot/src/signal-wait.ts` — `createSignalWaiter` (#664): the wait for a signal, its one
  poll for every waiting user and its edits outside any update
  ([The wait for a signal](#the-wait-for-a-signal-664)); `demo.ts`'s `createSignalWaitScreens` draws
  its screens.
- `apps/bot/src/demo.ts` — `createDemoComposer({ backend, logger, now, connectKeyboard, setupCardPhotos, signalWaiter })`:
  the handlers, the callback data builders (`DEMO_CALLBACK_DATA`, `DEMO_SIGNALS_CALLBACK_DATA`,
  `demoLaunchCallbackData` with its origin (#476),
  `cycleStakeCallbackData`, `cycleCustomCallbackData` and their patterns (#476),
  `launchStakeCallbackData`, `DEMO_GROUPS_CALLBACK_DATA`,
  `demoPageCallbackData`, `demoAssetCallbackData`,
  `analysisMoreCallbackData` (#360), `stakeCallbackData`; `demoAnalysisCallbackData` lives in
  `packages/shared/src/bot-navigation.ts` since #484, the backend's reminder draws it too),
  `ANALYSIS_MORE_PATTERN` and `analysisMoreDataOf` (#360), `STAKE_CALLBACK_PATTERN`, `stakeDataOf`
  and `newStakeNonce` (#127), `LEGACY_DURATION_PATTERNS` (#313, #685), `signalsScreen`,
  `appendSignalsFooter` (#685) and `launchScreen` (#320,
  in real mode), `cycleStakeAmounts`, `cycleStakeScreen` and `demoCycleScreen` (#476; the last two
  drawn by the stake picker too), the keyboards, `editOrReply`, which returns its
  outcome, and `editKeyboard` («➕ Ещё»'s edit of the keyboard alone, #360). `bot.ts`
  mounts it once under its private-chat filter, after `/help` and before the text handler, and
  mounts #127's `createDemoTradeComposer` (the stake press) right after it.
- `apps/bot/src/cycle-stake.ts` — `createCycleStakeComposer({ backend, logger, dialog,
  startSession })` (#476): an amount's press, «✏️ Своя сумма» and `onText`, the typed amount
  `bot.ts`'s text handler routes on the `cycleStake` step; the start is trading-session.ts's
  `startSession`. `bot.ts` mounts it before the session composer.
- `apps/bot/src/stake-access.ts` — `stakeAccess` (#476): the access read's refusals before any
  amount, shared by the picker and the amount screen.
- `apps/bot/src/analysis.ts` — the analysis screen as a pure function (#126): `analysisScreen`,
  `analysisUnavailableScreen`, `analysisSubject`, `TREND_WORDS`,
  `MOMENTUM_WORDS`, `VOLATILITY_WORDS` (maps to catalog keys, [bot-texts.md](bot-texts.md)),
  `formatRsi`, `formatAtrPct`; prices print through `formatPrice` of
  `packages/shared/src/bot-text-format.ts` (moved there by #464 for the session's trade messages).
- `packages/shared/src/telegram-refusals.ts` (moved from `apps/bot/src/screen.ts` by #551) —
  `editRefusal`, the classification of a refused edit, shared with `/settings` and the backend's
  session cycle message.
- `apps/bot/src/backend-client.ts` — `readPairs()`: a `GET trading/pairs` under the bearer with
  no body, parsed by `safeParsePairsCatalogResponse`, the whole answer returned; `readSignals()`
  (#320): a `GET trading/signals` the same way, parsed by `safeParseTradingSignalsResponse`;
  `evaluateSignal(assetId, interval, analysis?)`: a `POST trading/signal` with
  `{ assetId, interval }` and, from the analysis card only, `analysis: { telegramUserId,
  durationSec }` (#484, [The reminder](#the-reminder-484)), parsed by
  `safeParseTradingSignalResponse`, the whole answer returned (a `fetch_failed` is an answer, not
  an error).
- `apps/bot/src/texts.ts` — the `demo*` entries of `TEXTS`, `demoPairsScreen`, `demoSummary`, `DEMO_GROUP_LABELS`, `DEMO_DURATION_LABELS`,
  `groupButtonLabel`, `pairButtonLabel`, and the `demo*Button` labels; the `analysis*`,
  `analyzing` entries, `ACTION_LABELS`, `stakeButtonLabel` and
  `LABELS.repeatAnalysisButton` (#126); `signalButtonLabel` and `launchText` (#320);
  `cycleStakeText` and `cycleStakeLabel` (#476); the texts
  are catalog entries
  ([bot-texts.md](bot-texts.md)).
- `apps/bot/src/timing.ts` — `HANDLER_CALLS.demo` (2/2, #685), `.demoSignals`, `.demoLaunch`,
  `.demoGroups`, `.demoPage`, `.demoAsset`, `.legacyDuration` (2/2, #685), `.legacyKeyboard`,
  `.demoAnalysis`, `.analysisMore` (#360), `.cycleStakePreset`, `.cycleStakeCustom`,
  `.cycleStakeText` (#476); the link
  `TRADING_SIGNAL_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS`; the wait's bounds `SIGNAL_WAIT_*` and
  `SIGNALS_LIST_TTL_MS` (#664).
- `packages/broker-rest/src/pairs-catalog.ts` and `packages/shared/src/catalog.ts` — the `fresh`
  flag of the catalog ([Fresh](#fresh)).

## Sequence

```text
demo                      (the card's button)
  bot  → answerCallbackQuery ∥ GET /trading/signals ∥ GET /trading/pairs
  bot  → sendMessage: «Сигналы сейчас · ⏱ 5 с», the pairs with a signal two a row, «🔄 Обновить» «🧭 Выбрать пару вручную» in one row, «🏠 В меню»; no pair: «🔎 Анализирую сигналы…» with «🧭» / «🏠» (#664)
  bot  → the wait registered on that message (#664): the list after 30 s, or its first pair
demo:sig[:<sec>]          («🔄 Обновить», «↩️ К списку», «📡 К сигналам», «📡 Показать сигналы», «🔀 Выбрать другую пару»; `demo:sig:<sec>` of buttons from #382 to #685)
  bot  → the same reads → editMessageText: the same list, in place, and the wait
demo:l:<assetId>:<sec>[:a|:n]  (a pair of the list; in demo since #476 also the analysis's session row :a, the row under a finished trade and «🔁 Ещё сессия» :n; «↩️ К запуску», «↩️ Назад» of the typed amount; an alternative under a wait, #664)
  bot  → answerCallbackQuery ∥ GET /trading/pairs → readDemoTrade(<sec>) ∥ POST /trading/access
         ∥ GET /trading/signals (#664; #509 to #664 read POST /trading/signal)
  bot  → editMessageText (sendMessage for :n): the pair in the list → the amount screen in demo,
         the launch screen in real; not in it → «⏳ Проверяю сигнал по {пара}…» with the other
         pairs that have a signal now, «🧭» / «🏠», and the wait (#664)
demo:sa:<assetId>:<sec>:<amount>:<l|a>  (an amount of the amount screen, #476)
  bot  → answerCallbackQuery ∥ POST /trading/stake (demo, <amount>) ∥ GET /trading/pairs
  bot  → on a save: POST /trading/sessions, one attempt → the session's status; the amount screen deleted
demo:sc:<assetId>:<sec>:<l|a>  («✏️ Своя сумма», #476) → the prompt in place; the typed amount saves and starts the same way
demo:g                    («🧭 Выбрать пару вручную», «↩️ Типы»)
  bot  → answerCallbackQuery ∥ GET /trading/pairs
  bot  → editMessageText: the types present, each «💱 Валюты · 46» with its count of open pairs
demo:t:<group>:<page>     (a type, «◀️», «▶️») → the type's open pairs, page <page>
demo:a:<assetId>          (a pair, «↩️ К паре»)  → readDemoTrade(5), then the summary with «📊 Анализ»
demo:d:<assetId>:5        (the summary's data before #685) → the same summary
demo:an:<assetId>:<sec>   («📊 Анализ», «🔄 Повторить анализ», the reminder's «📊 Новый анализ»)
  bot  → answerCallbackQuery ∥ GET /trading/pairs → readDemoTrade ∥ POST /trading/access (the mode)
  bot  → editMessageText: «⏳ Анализирую EUR/USD · ⏱ 5 с…», no keyboard (under a photo —
         the analysis card, the session's summary card — sendMessage at once, #482)
  bot  → POST /trading/signal { assetId, interval: intervalForDuration(sec),
                               analysis: { telegramUserId, durationSec: sec } } (#484)
  bot  → on a signal: sendPhoto, the card (#482) — the bull or the bear, the caption with its
         block, in demo the amounts under it — then deleteMessage of «⏳»
  bot  → a fetch_failed or a failed call: editMessageText of «⏳» into the analysis screen with its
         keyboard; no signal: «⏳» into the wait for one, «🧭» / «🏠», and the wait (#664)
demo:more:<assetId>:<sec>:<up|down>:<d|r>     («➕ Ещё», #360; the mode's token, #121)
  bot  → answerCallbackQuery ∥ POST /trading/access
  bot  → editMessageReplyMarkup: the keyboard expanded in place: the stake button and «💵 Сумма»
         (in demo under the card's amounts, which stay, #482)
demo:stake:<assetId>:<sec>:<up|down>:<nonce>  (the stake button) → the trade, bot-demo-trade.md
<mode>:sess:<assetId>:<sec>[:l]              (the session button: in real the analysis's row, «🚀 Запустить цикл · REAL» with :l (#418), «🔁 Ещё сессия», the row under a finished trade, #327; in demo the buttons sent before #476) → the session, bot-session.md
stk:o:<d|r>:p:<assetId>:<sec>                 («💵 Изменить ставку» of the real launch screen, and of demo launch screens sent before #476) → the picker, bot-demo-trade.md
demo:d|an|l|sa|sc|more|stake, <mode>:sess with a <sec> the demo no longer offers (15 s, the set before #313), and demo:l:<assetId> from before #382
  bot  → answerCallbackQuery ∥ GET /trading/signals ∥ GET /trading/pairs → sendMessage: the list, a new message; the pressed keyboard untouched
stk:… without a mode (#326), stk:…:p:<assetId> from before #382 → the keyboard removed, nothing sent
```

Each press answers the query and reads the catalog at the same time, then edits the message the
button is under. `demo` is the exception: the card is a photo, whose caption cannot be turned into
another screen, so it sends a new message; so does an old duration button (below). The duration is
one, 5 s, and it still rides in the data (`:5`), not in the bot's state (owner, #382). The bot keeps no state for the
demo but the wait for a signal (#664, in memory): what the user chose travels in the callback data,
so a restart, an old message and a second device lead to the same screen.

The callback data is at most 48 bytes (`demo:stake:2147483647:5:down:0123456789ab:0a1b2c`), inside
the Bot API 64.
`demo:sig` is 8 bytes, `demo:l:2147483647:5` 19, `demo:l:2147483647:5:n` 21,
`demo:sc:2147483647:5:a` 22, `demo:sa:2147483647:5:999999999999.99999999:a` 44 (#476) and
`demo:more:2147483647:5:down:r` 29 (#360, #121, #631).
`<group>` is one of `PAIR_TYPE_GROUPS`, never the broker's own string; `<page>` is up to four
digits; `<assetId>` is up to ten digits, parsed by `createTradeIntentRequestSchema.shape.assetId`
(a positive int4, what #127 sends); `<sec>` is one of `DEMO_DURATIONS_SEC` (5), written into the
pattern, so `demo:an:101:120`, `demo:more:101:120:up` and `demo:stake:101:120:up:0123456789ab`
match nothing; `<up|down>` is a `TradeAction`; `<nonce>` is 12 lowercase hex characters. Data that
matches a pattern but fails its check (`demo:a:0`, `demo:l:0:5`, `demo:t:bond:0`,
`demo:more:0:5:up`) stops the spinner and sends nothing; data that matches no pattern
(`demo:sig:120`, `demo:l:101:120`) is not answered at all.
A `demo:more` button drawn between
#379 and #631 carries the payout floor's token `:<s|n>` before the mode's; the pattern admits it
and nobody reads it (below).

**Old duration buttons (#313, #685).** The durations the demo offered before —
60/300/900/1800/3600 s until #313, 15 s until #685 — are `LEGACY_DEMO_DURATIONS_SEC`. Every shape
that carries a duration — `demo:d`, `demo:an`, `demo:l` with its origin, `demo:sa`, `demo:sc`,
`demo:more`, `demo:stake` with or without its fingerprint, `<mode>:sess` with or without `:l` — has
a legacy pattern built from the same builder over that list (`LEGACY_DURATION_PATTERNS`), and so
has `demo:l:<assetId>` from before #382, which carried no duration. Pressing one logs `info`
`legacy duration button` with the pressed `callbackData`, answers the query and sends the signals
list as a new message, with the same reads and refusals as `demo:sig`; the pressed message keeps
its keyboard, so a session's or a trade's summary under it is not overwritten (#685, owner
2026-10-21). A legacy datum can be a write (`demo:stake`, `demo:sa`, `<mode>:sess`): the list's
«🔄 Повторить» under a failed read carries `demo:sig`, never the pressed data (Rule 31). A refused
answer is logged at `warn`. Any other duration still matches no pattern. The legacy patterns are
registered before the current ones, so the two sets must stay disjoint (`demo-catalog.test.ts`): a
duration in both would lead to the list instead of its screen. The stake picker's origin with an
older duration (`a|p:<assetId>:15`) reads as the same pair's screen at 5 s ([bot-demo-trade.md](bot-demo-trade.md)).

**Old picker buttons (#326, #382).** A picker datum without the mode segment (before #326) and a
launch screen's picker origin without a duration (`stk:o|s|z|c:…:p:<assetId>`, before #382) answer
the query and lose the message's keyboard (`editMessageReplyMarkup` with no markup); no text is
sent. A refused removal is logged at `info` `the keyboard of an old button was not removed` with
`telegramErrorFields` and the pressed `callbackData` (#329: the picker and the old oauth button
share the line).

## The entry (#685)

`demo` (the card's «🎮 Демо-торговля» or «🚀 Торговать») answers with the signals list as a new
message: one press from the menu to the pairs. `demo:sig` and every older `demo:sig:<sec>` (the
lists and the duration screen of #382 to #685) draw the same list in place of the pressed message.
Its refusals retry with the pressed data, the card's with `demo` (a read; a new message again).
Until #685 `demo` opened a duration screen («⏱ 15 с» «⏱ 5 с», `demoChooseDurationMain`).

## The signals screen (#320)

`demo` and `demo:sig` read `GET /trading/signals` ([signal.md → The scanner](signal.md#the-scanner-343)) and the
catalog together, and `signalsScreen` takes the list of the demo duration's interval
(`intervalForDuration(5)` = `5s`; a list of another interval in the body, an older backend's `15s`,
is not read) and joins it with the catalog: the route carries
no symbol or payout (#343), so the catalog gives both. A signal gets a button only if
`checkDemoTrade(catalog, assetId, 5, now)` is `ok` — the pair is listed, open on the bot's clock
and takes 5 s — so the launch would not refuse it (a `min_timeframe` 15 pair has no
button). The payout refuses nothing (#631; #379 left a pair below 80 % out): it orders the
list. `signalsShown` takes the pairs paying at least `MIN_CYCLE_PAYOUT_PCT` (80) first (#460) and
keeps at most `SIGNALS_LIST_SIZE` = 12 of them (2 × the six groups): first up to
`SIGNALS_PER_GROUP` (2) of every group of `PAIR_TYPE_GROUPS`, the best by `comparePairsByPayout`
(payout desc, then id), then the free places filled from the rest of all groups together by the
same order. That part is grouped by type in `PAIR_TYPE_GROUPS` order (💱 currencies first), a fill
pair sits in its own type's group, and inside a group the best payout comes first. With fewer than
`SIGNALS_MIN_SIZE` (5) of them the pairs paying less follow as a tail after the groups, by
`comparePairsByPayout` and with no quota by type, until the list holds five (#631, owner
2026-10-17): the list holds at least `min(5, the pairs with a signal that pass checkDemoTrade)`.
Five is a floor, not a ceiling: five to twelve pairs at or above 80 % take no tail. Neither the
route's order nor the catalog's matters (`demo.test.ts` → the choice of pairs, L1–L9). A pair that
would be refused takes no place: its place goes to the next pair of its type, or of the tail. The
scanner decides every open pair that takes the candle's duration on its interval, whatever it
pays, from the data socket's candles (#405, #631, [signal.md → The scanner](signal.md#the-scanner-343)),
so the list is bounded here, by `SIGNALS_LIST_SIZE`; while the source is down the lists are empty. Each button is «EUR/USD ⬆️ 85%» (`demo:l:<assetId>:5`):
the symbol, the scanner's direction as an arrow (a data mark like the payout, not a catalog text)
and the payout; two per row in the list's order, across the types, the last alone when their
number is odd (#419); then the footer (`appendSignalsFooter`, #685): «🔄 Обновить» (`demo:sig`) and
«🧭 Выбрать пару вручную» (`demo:g`) in one row, «🏠 В меню» (`menu`) in its own.

The list is a snapshot of the 5 s candle that closed last: «Сигнал держится одну свечу
(⏱ 5 с); перед каждой сделкой бот проверяет его заново». The press reads the list once more
(#664, [The amount screen](#the-amount-screen-476)): a pick whose signal is gone waits for it,
never a session without one; the session's orchestrator still asks for the signal before every
trade (#287). The button's arrow is the scanner's at `asOf`; the amount screen shows no
direction, since the session decides it per trade. A list with pairs lives `SIGNALS_LIST_TTL_MS`
(30 s, owner 2026-10-21): then the same message becomes «🚀 Начать торговлю» (`signalsExpired`)
with «📡 Показать сигналы» (`demo:sig`) · «🧭 Выбрать пару вручную» and «🏠 В меню»
([The wait for a signal](#the-wait-for-a-signal-664)). The manual pages are not a list and do not
expire.

| Outcome | What the bot shows |
|---|---|
| one or more pairs left after the join | `demoSignalsHeader` with the duration's label + up to 12 pairs two a row (`signalsShown`; at least five when five have a signal, the tail below 80 % included) + [refresh · manual] + [menu] |
| none left (no signal, every one closed or delisted, the scanner's first candle after a start) | the wait (#664): `signalsWaiting` («🔎 Анализирую сигналы · ⏱ 5 с / Проверяю пары на каждой свече. Как только появится сигнал, список откроется здесь.») + [manual] + [menu], no refresh; the list comes into the same message |
| the catalog's three failures ([The check](#the-check)) | that row's text + [«🔄 Повторить» (the pressed data; `demo:sig` under a legacy datum) · manual] + [menu]; a stale catalog draws no list |
| `readSignals` threw (unreachable, a non-2xx, a broken body) | «⚠️ Сервис временно недоступен…» + [«🔄 Повторить» · manual] + [menu]; `warn` `trading signals not read` |
| the body has no list for the duration (a backend scanning other intervals: a deploy mismatch) | the same unavailable screen, never an empty list; `warn` `trading signals list missing` with `interval` |

The catalog's failure is shown first when both fail. `readSignals` logs `trading signals not read`;
the catalog logs as in [The check](#the-check): only `backend_failed`, since the backend logs a
missing or stale snapshot itself.

## The amount screen (#476)

`demo:l:<assetId>:5[:a|:n]` reads the catalog and access together: `readDemoTrade(backend,
assetId, 5, now)` on the catalog read at this press (at any payout since #631), and the user's mode, the demo stake and the
broker snapshot. In demo it draws the amount screen (`cycleStakeScreen`), in real the launch screen
([below](#the-launch-screen-in-real-mode-327)). Four doors open it in demo: a pair of the signals
list (no token, edited in place), the analysis's session row (`:a`, edited in place, #360), the
row under a finished demo trade and «🔁 Ещё сессия» of a stopped demo session (`:n`, sent as a new
message, so the trade's or the session's message stays). The way back is «↩️ К списку»
(`demo:sig`) from the list and «↩️ Назад к анализу» (`demo:an:<assetId>:5`) otherwise;
a screen drawn by `:n` carries `a` in its own buttons, since its presses edit it. Old `demo:sess:…`
buttons in messages sent before #476 still start a session at once.

**The pair's signal at the press (#509, #664).** Beside the catalog and access the press reads
`GET /trading/signals` in either mode, since three of the doors — «🔁 Ещё сессия», the row under a
finished trade, an old message — were drawn without a signal. The pair has a signal now when it
is in the fresh `5s` list (the check above passed: `checkDemoTrade` ok), the one definition of the
list, the doors and the wait (#664; #509 to #664 asked `POST /trading/signal` for the pair). After
the check's refusal (the table below), in order:

| The list | What the press shows |
|---|---|
| the pair in it | the amount screen in demo, the launch screen in real, as above (W-door3) |
| the pair not in it | «⏳ Проверяю сигнал по {symbol} / Смотрю на каждой свече (⏱ 5 с)…» (`pairWaiting`) and, while other pairs have a signal, «Сигнал уже есть по другим парам — можно не ждать и выбрать одну из них 👇» (`pairWaitingAlternatives`) over their buttons two a row (`signalsShown` without the chosen pair) + «🧭 Выбрать пару вручную» + «🏠 В меню»; the wait registered (W-door1) |
| not read (`readSignals` threw, or no `5s` list) | the same wait without the alternatives; `warn` `trading signals not read` or `trading signals list missing` (W-door2) |

`:n` answers with a new message, as for every screen of this node (W-door4); no screen of the door
says «нет сигнала» (W-door5). The start route checks the signal again (`no_signal`,
[trading-session.md](trading-session.md#post-tradingsessions) step 4c): a signal gone between this
press and an amount's press waits there too ([bot-session.md](bot-session.md)). While the candle
source is down the lists are empty and the door waits (accepted risk 2 of the plan): it no longer
reads the pair's signal through the REST fallback, the start does.

Text: «🎯 {symbol} · ⏱ 5 с», «🤖 Бот проведёт 5 циклов подряд…», then «Выбери сумму сделки 👇»
(`cycleStakeChoose`). Keyboard:

- the amounts (`cycleStakeAmounts`): the picker's presets (`stakePresets`: the broker's minimum
  × 1, 2, 5, 10 within the demo balance), plus the saved demo stake when it is within the bounds
  (`checkStake`) and not a preset, ascending; ✅ on the amount in effect (the saved demo stake, or
  the broker's minimum without one); a saved stake above the balance now has no button and no ✅;
- amounts from `STAKE_RISK_THRESHOLD` ($10, inclusive, `stakeIsRisky`) are labelled
  «$10.00 · риск» (`stakeRiskButton`); the others go three a row, the risky ones two a row below
  them (#475 colours them);
- «✏️ Своя сумма» (`demo:sc:<assetId>:5:<l|a>`) and the way back in the last row.

No «🚀 Запустить цикл», «💵 Изменить ставку» or «🔁 Минимальная брокера»: an amount starts the
cycle, and «✏️ Своя сумма» covers any other. With no amount (the demo balance below the broker's
minimum) the text ends with `stakePickerNoPresets` and the keyboard is the way back only. Access's
refusals are the picker's (`stake-access.ts`): blocked, no account, an ambiguous account, no balance
snapshot, each with its keyboard and the way back. A failed access read says «⚠️ Сервис временно
недоступен…» with «🔄 Повторить» (`demo:l:…`, a read; `:n` becomes `:a`, so the retry edits the
refusal in place) and the way back, and logs `warn` `trading access not read for the amount
screen`. Any button press or command ends a typed amount's step left open
([bot-demo-trade.md → The stake](bot-demo-trade.md#the-stake-297-326), the custom input, #319). A pair refused by the check is
the table below, as on the manual path. A pair paying less than 80 % opens its amount screen like
any other (#631; #379 refused it with `demoPayoutTooLow`, removed).

**An amount** (`demo:sa:<assetId>:5:<amount>:<l|a>`, `cycle-stake.ts`) is a write
(`WRITE_CALLBACK_PREFIXES`). The press saves the amount as the demo stake (`POST /trading/stake`,
beside the catalog read), and only on `{ saved }` starts the cycle (`POST /trading/sessions`, mode
demo, `cycles: DEFAULT_SESSION_CYCLES`, #552), which reads the saved stake itself (Rule 29). The two requests are
not atomic: a stake saved from another device in between is the cycle's, and a refused start leaves
the amount saved. The amount in the data is the one saved, as the picker's preset: the backend
bounds it. A refused save («💵 Сумма» opens the amount screen anew as a new message, then the way
back), `balance_unavailable`, an unknown outcome (`warn` `stake save outcome unknown`, nothing
starts) and the other failures (`stake not saved`) are replies, so the screen stays. The start is
the session button's path ([bot-session.md](bot-session.md#the-button)) with one attempt: an
unknown outcome says `sessionOutcomeUnknown` and keeps the screen, and pressing again is safe (the
save is idempotent, the start answers 409 with the session if the first committed). Once the
session's status is sent the screen is deleted as the launch screen is
([bot-session.md](bot-session.md#the-launch-screen-after-the-start-418)). A second press while the
cycle runs saves its amount and shows the running session: the session keeps the amount it started
with (`trading_sessions.settings`, Rule 28).

**«✏️ Своя сумма»** puts the user on the `cycleStake` dialog step (login-dialog.ts, replacing a
login or a picker step) and edits the screen into `stakeInputPrompt` with «↩️ Назад» to the screen.
The typed amount is parsed as the picker's (`parseStakeInput`), saved and started the same way, with
the start's one retry on an unknown outcome, as a new reply: the bot keeps no id of the prompt, so
nothing is deleted. A text that is no amount, a bounds refusal, `balance_unavailable` and an unknown
save keep the step; a save and a refusal the bot cannot act on end it. The step lives up to
`LOGIN_DIALOG_TTL_MS` (10 min) or until the next inline button press or command, whichever comes
first (#319): a number typed after «↩️ К списку», «↩️ К анализу», `/menu` or any other button
starts nothing and saves nothing.

### The launch screen in real mode (#327)

In real mode `demo:l` draws the launch screen with the real stake in force (`effectiveStake`):
three lines — «🎯 {symbol} · ⏱ 5 с», «💵 Ставка: $X», «🤖 Бот проведёт 5 циклов подряд…» — and
three rows: «🚀 Запустить цикл · REAL» (`real:sess:<assetId>:5:l`, the session button's data
with the launch token: the start, its refusals and the 409 are the same, and once the session's
status is sent the start deletes this screen,
[bot-session.md](bot-session.md#the-launch-screen-after-the-start-418)), «💵 Изменить ставку»
(`stk:o:r:p:<assetId>:5`, the real picker whose way back is this screen,
[bot-demo-trade.md](bot-demo-trade.md#the-stake-297-326)), «↩️ К списку» (`demo:sig`). The
screen writes nothing: the stake is read where it is shown and the start reads it again (Rule 29).

## The check

`readDemoTrade(backend, assetId, durationSec, now)` reads the catalog, then checks the pair on the
clock taken after the read. #126 calls it before it shows the analysis (and so «➕ Ещё», whose
expansion reads no catalog, #360), #127 before it creates the intent; neither re-implements a
check. A cycle's entries — the signals list, the launch and the analysis's session button — check
the same since #631, at any payout (#379 refused a pair paying less than `MIN_CYCLE_PAYOUT_PCT`
there with `payout_too_low`; `demo-catalog.test.ts` pins `checkDemoTrade` at 79 %).

| Outcome | Source | What the bot shows |
|---|---|---|
| `catalog_unavailable` | `503 catalog_unavailable`, told by the reason: the route has no snapshot (not warmed yet, or the broker failing for longer than `BROKER_PAIRS_MAX_STALE_MS`) | «⚠️ Каталог активов сейчас недоступен…» + «🔄 Повторить»; no log line, the backend logs each failed refresh |
| `catalog_stale` | `200` with `fresh: false` | «⏳ Каталог активов обновляется…» + «🔄 Повторить»; no log line |
| `backend_failed` | any other refusal (401, 404, 400, …), a 5xx, no answer, a timeout, a broken body | «⚠️ Сервис временно недоступен…» + «🔄 Повторить»; `warn` `demo catalog not read` |
| `pair_missing` | the id is not in the catalog (delisted, or forged data) | «❌ Этот актив больше не доступен…» + «↩️ Типы» |
| `pair_closed` | `scheduledUntil > now` on the bot's clock | «🔒 {symbol} сейчас закрыт по расписанию…» + «↩️ Активы» + «↩️ Типы» |
| `duration_unsupported` | the duration is not one of `DEMO_DURATIONS_SEC` (#125 review m5: it arrives from callback data), or the pair does not take 5 s (`[minTimeframe, maxTimeframe]`) | «❌ {symbol} не принимает сделки на ⏱ 5 с. Выбери другой актив.» (`demoDurationUnsupported`, #685) + «↩️ Активы» (the pair's page) + «↩️ Типы»; under the stake press «↩️ Типы» only |

«🔄 Повторить» carries the pressed data again, so a retry after `demo:a:…` lands on the summary
once the catalog is back. A retry is safe: the screens that retry with the pressed data write
nothing, and the list's retry under a legacy write datum carries `demo:sig` (#685).

A pair is open when `scheduledUntil` is 0 or not after now (`isOpen`): the broker sends
milliseconds since the epoch, read as "not tradable until" — the mock broker's reading, which
refuses an order only while `scheduled_until > now`. The durations a pair admits are
`DEMO_DURATIONS_SEC` within `[minTimeframe, maxTimeframe]`, both ends included (`durationOptions`).
`DEMO_DURATIONS_SEC` is 5 s (owner, 2026-10-20, #685; 5 and 15 s from #313 to #685), so a pair
whose `min_timeframe` is above 5 (15, 60) accepts none.

**Pairs are filtered in advance (#313).** `pairsOf` keeps only the pairs that accept 5 s, and
every screen reads through it: a type whose pairs all refuse 5 s has no button, a page lists only
the pairs that accept it, and a type's count counts only them.

`demo:a` checks the pair too (`readDemoTrade`), since it can close between the page and the
press. An old pair button of a pair the pages no longer list falls to `duration_unsupported`
with the way back to page 0. An empty catalog reads as
`catalog_unavailable` on the types screen: there is nothing to choose from. A catalog with pairs
but none that accepts 5 s says «Сейчас нет активов для коротких сделок.» (`demoNoShortPairs`)
with «🔄 Повторить» on the types. A type's page agrees (#329): page 0 reached from such a pair, or
an old «💱 …» button of a type whose pairs all refuse 5 s, says `demoNoShortPairs` with
«↩️ Типы», and an empty catalog there reads as `catalog_unavailable` too; a type with listed pairs
none of which is open still says it is closed by the schedule.

## Fresh

`createPairsCatalog().read()` gives `fresh = ageMs <= ttlMs + BROKER_REST_TIMEOUT_MS` — the oldest a
snapshot gets while every tick succeeds — and the route sends it as it is. The bot holds no copy
of the bound and compares no ages: a catalog that is not fresh is not shown at all, so a stale
payout is never shown as current. One failed refresh is enough: the screens say the catalog is
updating until the next tick succeeds (up to one TTL). `MAX_BROKER_PAIRS_TTL_MS +
BROKER_REST_TIMEOUT_MS < BROKER_PAIRS_MAX_STALE_MS` is a conjunct of `PAIRS_CATALOG_CHAIN_HOLDS`.
`fresh` is a required field: a backend older than #125 makes `readPairs` a contract violation,
not a fresh catalog.

## Keyboards

- **Types.** One button per type the catalog holds, two per row, in the order of
  `PAIR_TYPE_GROUPS` (`packages/shared/src/catalog.ts`, shared with the scanner, #460): 💱 Валюты, 🛢 Сырьё, 📈 Акции, 💠 Криптовалюты, 📊 Индексы, 📁 Другие (any
  broker type outside the five). A type with no pair that accepts a demo duration has no button; a
  type with such pairs but none open shows «· 0» and its press says «🔒 {type}: сейчас всё закрыто
  по расписанию».
- **Pairs.** `DEMO_PAGE_SIZE` = 12 open pairs, two per row, sorted by label in code-unit order
  (ties by id), each «EUR/USD 85%» — the pair's label (the broker's symbol without « OTC», #631,
  [pairs-catalog.md → The pair's label](pairs-catalog.md#the-pairs-label-428-631)) and its
  payout as it arrives. A regular pair and its OTC twin of the same symbol share the label and
  stand side by side by id; their payouts tell them apart. Then one row: «◀️» when a page before exists, «↩️ Типы», «▶️» when a page
  after exists. A page beyond the end (the catalog shrank) is the last page. Closed pairs are not
  listed.
- **Signals (#320, #685).** The pairs with a signal two a row, the last alone when odd (#419);
  then «🔄 Обновить» and «🧭 Выбрать пару вручную» in one row and «🏠 В меню» in its own. At most
  `SIGNALS_LIST_SIZE` = 12 pairs (#460) — 6 + 2 rows; at least `SIGNALS_MIN_SIZE` = 5 when five
  have a signal, the pairs below 80 % as the tail (#631); the scanner covers every eligible pair
  (#405), so the limit is the bot's (Telegram allows 100 buttons, 8 a row).
- **Amounts (#476, demo).** The amounts three a row, the risky ones («· риск») two a row, then
  «✏️ Своя сумма» and the way back in one row; each carries the duration (5). The screen is deleted
  after an amount's start, once the session's status is sent (#418).
- **Launch (#320, real).** «🚀 Запустить цикл · REAL», «💵 Изменить ставку», «↩️ К списку», one a
  row; each carries the duration (5). The screen is deleted after the start, once the session's status
  is sent (#418).
- **Summary (#685).** «📊 Анализ», then «↩️ Активы» (the pair's page) and «↩️ Типы».
- **The waits (#664).** The wait for the signals: «🧭 Выбрать пару вручную», then «🏠 В меню»;
  the wait for a pair (the door, the analysis, the start's 409): the other pairs with a signal now
  two a row for 30 s, then the same two rows. The start of trading (`signalsExpired`): «📡
  Показать сигналы» and «🧭 Выбрать пару вручную» in one row, «🏠 В меню» in its own.
- **Analysis (#360).** On a signal — since #509 not without one; without one the wait (#664) — «🚀 Сессия из 5
  циклов» alone in the first row where `sessionFitsDeadline(DEFAULT_SESSION_CYCLES, sec, martingale)`
  holds (`sessionFits`; #552: the worst case of four trades a cycle), at the demo's duration
  (#284, [bot-session.md](bot-session.md#the-button)), at any payout (#631; #379 withheld
  it below 80 % and said why); on a signal, «➕ Ещё» alone in
  the next row; then «🔄 Повторить анализ» (the same `demo:an` data); then «↩️ К паре»
  (`demo:a:<assetId>`, the summary, #685) and «↩️ Типы». On `fetch_failed` and when the signal call threw: the last two rows only.
  «⏳ Анализирую…» has no keyboard, so «📊 Анализ» cannot be pressed twice while the signal is
  asked for.
- **The card's amounts (#482, demo).** Under a signal's card in demo the amounts of the amount
  screen take the session row's place: the same rows (`appendCycleAmounts`, ✅ on the amount in
  effect, the risky ones two a row), `demo:sa:<assetId>:5:<amount>:a`, then «✏️ Своя сумма»
  in a row of its own — only when the access read gives demo mode, `stakeAccess` gives a broker
  snapshot (not for a blocked user), the amounts are not empty, and the session row's conditions
  hold (`sessionFits`). The caption's last line is then «Выбери сумму сделки 👇»
  (`analysisChooseAmount`). Otherwise — no snapshot, a balance below the minimum, a failed read —
  the session row as before, whose press opens the amount screen and says why there. An amount's
  press is #476's: the save, the start, the card deleted after the status (`deleteMessage` takes a
  photo as it takes a text); «✏️ Своя сумма» and «💵 Сумма» edit the pressed message, refused as a
  caption, and their screen goes as a new message.
- **Analysis expanded by «➕ Ещё» (#360).** The session row (where `sessionFits`) — in demo
  the card's amounts in its place, by the same conditions read at this press (#482) — then «🚀
  Открыть сделку: ⬆️ Вверх · $5.00» (or «⬇️ Вниз») and «💵 Сумма» in one row, then the repeat and
  the way back — the same message, only its keyboard edited. «🔄 Повторить анализ» draws the
  collapsed form again.
- **Real mode (#121, [trading-mode.md](trading-mode.md)).** The analysis reads access for the
  user's mode beside the catalog: in real mode the session row is «🚀 Сессия из 5 циклов · REAL»
  with `real:sess:<assetId>:5` (#327; in demo `demo:l:<assetId>:5:a`, the amount screen,
  #476), the disclaimer is `analysisDisclaimerReal` («…Реальный
  режим: сделка идёт на реальные деньги.»), and the hint is the demo one (#327). A failed read draws the demo text and
  keyboard. «➕ Ещё» carries the mode the
  text was drawn in (`:d`/`:r`; a datum without it is from before #121 and reads as `d`); the
  expansion draws a stake button only when its own access read gives that mode, otherwise just
  «🔄 Повторить анализ» and the way back. In real mode the expansion draws «🚀 Открыть
  сделку: ⬆️ Вверх · $1.00 · REAL» at the real stake in force (the saved real stake, the broker's
  minimum without one, #326), its fingerprint over `real:<amount>`, and «💵 Сумма» of the real
  picker (`stk:o:r:a:<assetId>:5`), under the real session row (#327). A pair opens, in real
  mode, the launch screen (#327): the real stake in force, `launchCycleReal` («…Реальный режим:
  сделки идут на реальные деньги.»), «🚀 Запустить цикл · REAL» and the real picker, where demo
  draws the amount screen (#476), at any payout (#631).
- **The shared screens** — the signals, the types, a type's pairs and the summary — read no mode,
  so their default texts hold in both (#121): «📡 Сигналы сейчас … Выбери пару.», «🧭 Выбор
  пары», «Дальше — анализ свечей: бот покажет сигнал и что можно сделать по нему.». The demo note
  («деньги не нужны», the cycle) is on the screens that know the mode: the demo launch and the
  demo analysis.

At most 15 buttons on a manual screen. Labels are
plain strings; every label but a pair's starts with an emoji.

## Texts

Every fragment is a `TEXTS` entry and the screens are assembled by `demoPairsScreen`,
`demoSummary` and `analysisScreen`; the symbol is a hole of
`telegramHtml`, escaped once — inside the card's `<pre>` too, with every label and value. The pairs screen, the summary and the
analysis of a signal each say once what the payout is: the size of a win on a right forecast, not
its probability. The summary and the analysis of a signal also name the
break-even share at that payout (#379): «Безубыточность: {breakEven}% верных прогнозов.» —
`100 / (100 + payout)`, one decimal, a dash where the payout gives none (`formatBreakEven`). No
profit, accuracy or probability is promised (`texts.test.ts` holds the absence of «вероятност» and
«точност» in every analysis entry); the only numbers are the broker's payout, the break-even share
computed from it, the page count and the signal's own features and display indicators.

## The analysis

`demo:an` keeps the order «check, then the screen». `readDemoTrade` runs on the catalog read at
this press; any refusal is the table in [The check](#the-check), with no «⏳» and no signal asked
for. On `ok` «⏳ Анализирую {symbol} · {duration}…» stands (`showWaiting`), then
`evaluateSignal(assetId, intervalForDuration(5))` asks the backend's `POST /trading/signal`
([signal.md](signal.md#post-tradingsignal-258)), then a text screen replaces «⏳», or a signal's
card goes as a photo and «⏳» is deleted (#482). The interval is
the longest table candle not above the duration; on `DEMO_DURATIONS_SEC` it is the duration
itself: a 5 s trade is analysed on `5s` candles, never on `1m` (#313;
`analysis.test.ts` A1 breaks when the two tables part, and `signal.test.ts` S3 when either falls
back to `1m`).

Where «⏳» stands decides where the result goes (#482). A pressed message with a photo (the
analysis card, the session's summary card #318) cannot become text, so its «⏳» goes as a new
message at once; trying the edit first would make the card's path five Telegram calls, past the
shutdown budget ([Timing](#timing)):

| «⏳» | Then |
|---|---|
| the pressed message edited, or «message is not modified» | the signal; a text result through `editOrReply`; a card as a photo, then «⏳» deleted |
| under a photo: sent as a new message | the signal; a text result edited into «⏳» by its id (gone → sent anew, a transport failure → nothing more, `editByIdOrReply`); a card as a photo, then «⏳» deleted |
| the pressed message gone or not editable | no «⏳» anew (`warn` `the demo screen was not edited, the analysis goes as a new message`); the signal, then the result — text or card — as a new message |
| failed in transport (the edit, or the new «⏳») | nothing more, and no signal asked for: a second message after an unknown delivery is worse than none |
| any other refusal | `bot.catch`, nothing more |

The card's photo and «⏳» after it (`sendCard`; the budget leaves one call after the photo):

| Outcome | Then |
|---|---|
| sent | the `file_id` of its largest size remembered for the direction (none in the answer: `warn` `the setup card picture is not remembered`, `no_file_id`); «⏳» deleted: «message to delete not found» → `info`, anything else, a transport failure too → `warn` `the analysis «⏳» was not deleted`, nothing more |
| refused by Telegram (`GrammyError`, a stale `file_id` among them) | the direction's `file_id` forgotten (`warn` `the analysis card photo was refused, sending its text`); the same caption and keyboard as text in place of «⏳» (any refusal → `warn`, nothing more), or as a new message where «⏳» is gone; the next press uploads the file |
| failed in transport | the outcome unknown (`error` `the analysis card failed in transport`): «⏳» says «⚠️ Не удалось получить свечи…» with «🔄 Повторить анализ» and the way back (its refusal → nothing more); without «⏳» nothing more. A repeat after a card that did arrive gives a second card (accepted) |

The pictures are `apps/bot/src/assets/setup-bull.png` and `setup-bear.png` (1280×640,
`SETUP_CARD_PHOTO_PATHS`; `assets.test.ts` holds each a PNG within the Bot API's photo limits):
replacing a file changes the card without a code change. The first card of each direction goes
as the file, every later one by the `file_id` Telegram answered with, kept in process memory by
`apps/bot/src/setup-card.ts` (`createSetupCardPhotos`), which the session message shares (#568,
[bot-session.md](bot-session.md#the-session-message)): a restart, or a second bot process, uploads
each picture once again. An answer with no size is `warn` `the setup card picture is not
remembered` (`reason: no_file_id`).

The screen (`analysisScreen`) is built from this press's pair and the answer only:

| Answer | Headline | Body | Buttons above the repeat (#360) |
|---|---|---|---|
| `decided`, `signal` — the card (#482), a photo of the bull or the bear | «🟢 Сильный сигнал на рост» / «🔴 Сильный сигнал на падение» | the block (below), the payout with the break-even share, «⚠️ Сигнал — не прогноз результата и не гарантия…», in demo over the amounts «Выбери сумму сделки 👇» | in demo the amounts, else the session, at any payout (#631); «➕ Ещё» by the decision's action |
| `decided`, a rule refusal (`volatility_too_low`, `volatility_too_high`, `volatility_below_tick_floor`, `trend_flat`, `rsi_neutral`, `trend_momentum_disagree`, `rsi_overbought`, `rsi_oversold`) — the wait (#664) | «⏳ Проверяю сигнал… Как только он появится, здесь откроется карточка сигнала.» (`analysisWaiting`) | the feature lines; no reason, no hint | «🧭 Выбрать пару вручную» / «🏠 В меню» only, the alternatives from the first poll ([The wait for a signal](#the-wait-for-a-signal-664)) |
| `decided`, a data refusal (`insufficient_candles`, `candle_gap`, `stale`, `invalid_candle`) — the wait (#664) | the same | no feature line, the decision carries none | the same |
| `fetch_failed` `rate_limited` with `retryAfterSec` | «⚠️ Брокер ограничил запросы. Попробуй через N с.» | — | none |
| any other `fetch_failed`, `rate_limited` without `retryAfterSec` | «⚠️ Не удалось получить свечи у брокера…»; `warn` `signal not evaluated` with `signalCode` (not for `rate_limited`) | — | none |
| `evaluateSignal` threw (unreachable, a timeout, a non-2xx, a broken body) | the same; `warn` `signal not evaluated` with the error | — | none |

`AnalysisScreen.session` is true on a signal only (#509, owner: no session on a pair without a
signal now); `AnalysisScreen.wait` on a refusal only (#664): its screen is the wait, which turns
into the card in the same message once the signal comes (`editMessageMedia`). Until #509 it was true on every `decided` answer, and the session waited for a signal
itself; the no-signal limit ([trading-session.md](trading-session.md#the-no-signal-limit-509)) now
stops such a wait after 20 candles of the session's interval (#637: 100 s on 5 s; 300 s for a 15 s session from before #685). Where the candles were not read, no session row is drawn either.

The card's block (#482) is a `<pre>`, so Telegram draws it monospaced with a copy button: eight
rows of a label (`cardRowPair` … `cardRowDirection`) padded to the longest label after the
overrides — by `String#length`, UTF-16 units, as the caption limit counts them — one space, the
value. Every number is the answer's:

```
Пара          EUR/USD
RSI           нейтрально 62.3
MACD          выше сигнальной 0.000023
MA50          цена выше 1.08531
MA200         цена ниже 1.08612
Тренд EMA     вверх
Волатильность в норме 0.041%
Направление   ⬆️ ВВЕРХ 🟢
```

- RSI: «перекуплен» at `features.rsi ≥ 50 + params.rsiExtremeBand`, «перепродан» at `≤ 50 −
  rsiExtremeBand`, «нейтрально» between — the bounds of the decision's own `rsi_overbought` /
  `rsi_oversold` (65 / 35 by default); then the RSI to a tenth.
- MACD (12, 26, 9): «пересечение вверх» / «пересечение вниз» when `indicators.macd.cross` says the
  cross happened on the last closed candle; otherwise «выше сигнальной» / «ниже сигнальной» /
  «на сигнальной» by the histogram's sign; then the histogram at the pair's digits plus one.
- MA50, MA200: «цена выше» / «цена ниже» / «цена на MA» by the last close against the average,
  then the average at the pair's digits.
- An indicator with `ok: false`: «данных мало ({closedCandles} из {required})» in place of the
  word and the number. With no `indicators` field (the unbroken tail failed the candle checks,
  [signal.md](signal.md)) all three say «данных мало (0 из 35 / 50 / 200)»: the row is never
  dropped and never prints a default.
- The trend word of the decision; «в норме» and the ATR% (a signal is decided with the volatility
  in bounds); «⬆️ ВВЕРХ 🟢» / «⬇️ ВНИЗ 🔴» by the action.

The direction is the decision's (Signal v2 on its 60 candles); MACD and MA are shown, not decided
on — #483's backtest found no MACD or MA gate better than v2
([signal.md](signal.md#macd-and-ma-on-history-483)) — so «рост» beside «MA200: цена ниже» is
possible.

The feature lines of a rule refusal (under the wait since #664), every number from the answer:

- «📐 Тренд по EMA: вверх — EMA{params.emaFast} {features.emaFast} выше EMA{params.emaSlow}
  {features.emaSlow}» — «выше»/«ниже»/«равна» by the order of the two EMAs; the trend words
  вверх / вниз / не определён.
- «⚡ Импульс по RSI: вверх — RSI{params.rsiPeriod} {features.rsi}» — вверх / вниз / нейтральный.
- «🌊 Волатильность по ATR: в норме — ATR{params.atrPeriod} {features.atrPct}% · {features.atrTicks}
  шага котировки» (always a tenth, so «шага») — told by the refusal (слишком низкая / слишком
  высокая / меньше порога в шагах котировки, #379), since the decider checks volatility first; the
  bot holds no bounds of its own. The refusal's reason itself is not shown since #664 (the
  `noSignal*` words are gone with «Сигнала нет»).
- «🕯 Закрытых свечей: {features.closedCandles}» and «💲 Последняя цена: {features.lastClose}».

Prices are printed with the pair's `digits`, RSI to a tenth, ATR% to a thousandth (a live 1m ATR%
sits in the hundredths and thousandths), ATR in quote steps to a tenth (`formatAtrTicks`). The periods come from `params`, never from the bot: a
backend tuned to other periods prints those (the fixture's are not the defaults). `analysis.test.ts`
A2 holds the card to the answer's numbers and the pair's payout, and nothing else.

«➕ Ещё» is drawn only on a signal, which is reached only after `readDemoTrade` was `ok` on this
press: the pair open by its schedule and the duration inside its range on a fresh catalog. Its
data `demo:more:<assetId>:5:<up|down>:<d|r>` carries the signal's direction and the mode at
the render (`analysisMoreDataOf` parses it with `createTradeIntentRequestSchema.shape.assetId`,
the duration set and `TradeAction`), so the expansion asks for no signal and reads no catalog: the
stake press reads the catalog and refuses a pair closed since (#127). A datum drawn between #379
and #631 also carries the payout floor's verdict (`:s`/`:n`) before the mode's token; the pattern
admits all four forms — none, `:s|:n`, `:s|:n:d|r`, `:d|:r` — and nobody reads the verdict: every
expansion draws the session row (#631; `demo.test.ts` → the old or new datum).

**«➕ Ещё» (#360).** The press answers the query beside `POST /trading/access` and edits only the
keyboard of the same message (`editMessageReplyMarkup`, no text — a photo's markup can be edited):
the session row stays first — in demo the card's amounts in its
place where this press's access read allows them (#482) —
then «🚀 Открыть сделку: ⬆️ Вверх · $5.00» and «💵 Сумма» (`stk:o:d:a:<assetId>:<sec>`, the picker
of the expansion's mode, `r` in real mode, #326) in one row, then the repeat and the way back. The
label names the amount the press would trade, the saved stake of the user's mode or the broker's
minimum (#297, #326), read at this press; a failed read only drops the amount from
the label (`warn` `trading access not read for the stake label`), and an access with no broker
snapshot draws none either, with no log. The stake data is
`demo:stake:<assetId>:<sec>:<up|down>:<nonce>:<fingerprint>`, parsed with
`createTradeIntentRequestSchema.shape` (`stakeDataOf`); `<fingerprint>` is 6 hex of the shown
amount's `sha256`. The nonce (`newStakeNonce`, 6 random bytes in hex) is drawn once per expansion
and is the trade's idempotency key (#127): the same button pressed again replays its trade, the
button of a new expansion opens a new one — a double tap on «➕ Ещё» draws two nonces, as two
renders of «🔄 Повторить анализ» did before. The press is #127's
([bot-demo-trade.md](bot-demo-trade.md)); data the schema refuses
(`demo:stake:0:60:up:0123456789ab`) only stops the spinner. The picker and the press's fingerprint
check are in [bot-demo-trade.md → The stake](bot-demo-trade.md#the-stake-297-326).

The keyboard edit's refusals: «message is not modified» is done (`info`
`the analysis keyboard already shows this`); «message to edit not found» / «can't be edited» (the same class as «there is no text in the message to edit», which a keyboard edit does not get: a photo's markup can be edited) sends
nothing more, since there is no analysis left to attach a stake button to and a new «📊 Анализ»
reaches the trade (`warn` `the analysis keyboard was not expanded`); a transport failure sends
nothing more (`error` `the analysis keyboard edit failed in transport, sending nothing more`); any
other refusal goes to `bot.catch`. «➕ Ещё» is a read: no «🔄 Повторить» ever carries it, and a
failed expansion changes nothing on screen.

## Edits

`editOrReply` edits the message the pressed button is under, and classifies every refusal
(`telegram-refusals.ts`):

- «message is not modified» (the same screen pressed twice) — done; `info`
  `the demo screen already shows this`.
- «message to edit not found» / «message can't be edited» / «there is no text in the message to
  edit» (a photo, e.g. the session's summary card, #318) — the screen is sent anew with the same
  keyboard; `warn` `the demo screen was not edited, sending it anew`.
- any other refusal — to `bot.catch`, nothing sent; the keyboard on screen is the retry.
- a transport failure — the edit is unknown, nothing more is sent; `error`
  `the demo screen edit failed in transport, sending nothing more`.

`answerCallbackQuery` runs beside the catalog read; a refused answer is logged
(`answering the callback query failed`) and the screen still goes.

## Timing

`HANDLER_CALLS.demo` is two backend calls (the signals and the catalog, beside the answer) and two
Bot API calls (the answer, then the list as a new message, #685): 26 s; `.demoSignals` (`demo:sig`,
the list in place) is two backend calls and up to three Bot API calls: 34 s (#320); `.demoLaunch`
is three backend calls (the catalog, access and the signals list, #664; the pair's signal from
#509 to #664) and up to three Bot API calls: 39 s, the wait included. The wait's polls and edits
run between updates, like the trackers, so they are no handler path
([The wait for a signal](#the-wait-for-a-signal-664)). Each of `.demoGroups`, `.demoPage` and `.demoAsset` (the summary, also by
`demo:d:<id>:5`) is one backend call and up to three Bot API calls (the edit refused as gone,
then the message sent anew): 5 000 + 3 × 8 000 = 29 s. `.demoAnalysis` is three backend calls
(the catalog and the access read beside the answer, then the signal) and up to four Bot API calls:
3 × 5 000 + 4 × 8 000 = 47 s. Its four-call paths (#482): the answer, «⏳» edited or sent under a
photo, the card's photo, «⏳» deleted; the answer, «⏳», the photo refused, «⏳» edited into the
text card; the answer, «⏳» sent under a photo, the text result's edit refused as gone, the result
sent anew; the answer, the summary gone, the photo refused, the text card sent. A gone summary
gets no «⏳» anew: with it the card's path would be 3 × 5 000 + 5 × 8 000 = 55 s, past the
shutdown budget. `.analysisMore` (#360) is one backend call (access beside the
answer) and two Bot API calls (the answer, the keyboard's edit; a refused edit sends nothing
more): 21 s. The longest declared path is `demoAnalysis`'s and, since #418, `sessionStart`'s 47 s,
so `HANDLER_BUDGET_MS` is 47 s
([bot-demo-trade.md](bot-demo-trade.md#timing));
`HANDLER_BUDGET_MS < SHUTDOWN_BUDGET_MS` (50 s) `< COMPOSE_STOP_GRACE_PERIOD_MS` (55 s) is
checked at import (`TIMING_CHAIN_HOLDS`). `.legacyDuration` (#313, #685, an old duration button or
a launch screen's from before #382) is the list's two reads and two Bot API calls, the answer and
the list as a new message: 26 s. `.legacyKeyboard` (a mode-less picker datum, a launch picker's
from before #382) is no backend call and two Bot API calls, the answer and the keyboard's removal:
16 s. The answer
and the read run together and are counted as sequential, as for confirm. `timing.test.ts` runs
every terminal branch of each handler named here through the real handlers — the page of a type
with no listed pair (#329) included. The pairs route reads the cache in memory; the signal route
makes at most one chart GET, inside `TRADING_SIGNAL_BUDGET_MS` (4 s), and
`TRADING_SIGNAL_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS` is checked at import and in
`timing.test.ts`.

## Logging

- `demo catalog not read` (`warn`) — `err` with the `BackendError`'s name and code,
  `backendStatus`, `backendReason`; no Telegram id, no symbol.
- `trading signals not read` (`warn`, #320) — the same fields.
- `trading signals list missing` (`warn`, #382) — `interval` only: the parsed body has no list for
  the demo's duration (`5s`).
- `legacy duration button` (`info`, #685) — `callbackData` alone: the press of a button with a
  duration the demo no longer offers, to see when the old buttons stop being pressed.
- `signal wait reads failed` (`warn`, #664) — the wait's shared reads failed: the signals' `err`
  with the backend fields, the catalog's (`backend_failed`) the same, `catalogReason` for a
  missing or stale catalog, `interval` for a body without the `5s` list; once for a series of
  failed ticks.
- `signal wait message not edited` (`info` for a message gone or a user who blocked the bot,
  `warn` for a 429 and the other refusals and transport failures, `error` for anything else, #664)
  — the method, the Telegram error code, the entry's `kind` (`list`/`pair`) and the pair's
  `origin` (`door`/`analysis`/`start`); no Telegram id, no symbol, never the description
  (`signal-wait.test.ts` W10c). `signal wait message not edited at the stop` (`warn`) — the same
  fields; `the signal wait card photo was refused, sending its text` (`warn`); `signal wait
  analysis not evaluated` (`warn`, once an entry) — the backend fields or `signalCode`;
  `trading access not read for the signal wait` (`warn`) — the backend fields.
- `signal not evaluated` (`warn`, #126) — for a thrown call, `err` with the error's name and code,
  `backendStatus`, `backendReason`; for a `fetch_failed` other than `rate_limited`, `signalCode`
  alone. No Telegram id, no symbol, nothing of the broker's text.
- the three edit outcomes above — the method and the Telegram error code, never the description
  or the text; the transport line also names the update id.
- «➕ Ещё»'s three keyboard lines (#360) — `the analysis keyboard already shows this` (`info`),
  `the analysis keyboard was not expanded` (`warn`), `the analysis keyboard edit failed in
  transport, sending nothing more` (`error`, with the update id): the method
  (`editMessageReplyMarkup`) and the Telegram error code, never the description.
- `trading access not read for the stake label` (`warn`) — written by «➕ Ещё» (#360) and the
  analysis (#121): `err` with the `BackendError`'s name and code, `backendStatus`,
  `backendReason`; no Telegram id, no amount.
- `trading access not read for the amount screen` (`warn`, #476) — the amount screen's access
  read: `err` with the `BackendError`'s name and code, `backendStatus`, `backendReason`; no
  Telegram id, no amount (`logging.test.ts`).
- `stake save outcome unknown` (`warn`) and `stake not saved` (`warn` for `user_not_found`,
  `error` otherwise) — an amount of the amount screen or its typed amount (#476), as the picker
  writes them: `err`, the backend fields and `mode: demo`; no Telegram id, no amount.
- `the amount prompt edit failed in transport, sending nothing more` (`error`, #476) — the method
  and the Telegram error code.
- `answering the callback query failed` (`warn`) — the method and the code; from an old button
  (#313, #314) also its `callbackData`.
- `the keyboard of an old button was not removed` (`info`) — the method, the code and the pressed
  `callbackData` (#329: the demo's, the picker's and the old oauth button's handlers share it).

`logging.test.ts` reads these lines back from the pino sink, except the two `callbackData` fields
and the old-button line, which `demo.test.ts` and `bot.test.ts` read from the handlers' logger.

## The reminder (#484)

The analysis card names its user and duration in the signal request (`analysis`), and the backend
records the decision as the user's last analysis ([signal.md](signal.md) → POST /trading/signal):
a signal with its pair and duration, a decision without one as none. The cycle's doors (`demo:l`)
read the signals list since #664 and send no signal request at all. The wait of an analysis
without a signal sends `analysis` when it reads the signal again (#664): its card is an analysis
shown, so the reminder can follow it. Ten minutes after an analysis with a signal that led to no
trade, no session and no other analysis, the backend's mailing engine sends a demo user one
reminder, `analysisUnusedReminder`, with «📊 Новый анализ» — `demo:an:<assetId>:<sec>` of the same
pair and duration (5 s; a reminder queued with 15 s before #685 leads to the signals list, the
legacy handler), so its press is this screen's handler, a fresh analysis: the signal of the old
card is stale. The bot holds no state for it; the rules, the window (60 min) and the outcomes are
[mailing.md](mailing.md) → The analysis reminder. The request still makes three backend calls
(`HANDLER_CALLS.demoAnalysis`): the record rides on the signal request.

## The wait for a signal (#664)

After the user chose a pair the bot never answers «сигнала нет» (owner 2026-10-21). Every path
that used to — the empty list, the door of a pair whose signal is gone, the analysis without a
signal and a session start refused with 409 `no_signal` ([bot-session.md](bot-session.md)) — draws
a wait instead and registers an entry with `apps/bot/src/signal-wait.ts`; the bot edits the same
message once the signal comes. A session still never starts without a signal (#509): the bot
waits, not the session.

**Entries.** One per user, in the bot process's memory (accepted risk 1: a crash, an entry past
the stop's window or one pushed out by `SIGNAL_WAIT_MAX_ENTRIES` (10 000) stays «⏳…» with its
working «🧭» / «🏠»). A new entry replaces the user's previous one: the old message is not edited
again, but for an edit already in flight. Any inline button and any command leave the wait (the
two middleware in `bot.ts`, beside `endInputStep`, #319); a plain text does not. The middleware
runs before the handlers, so a pair pressed under a wait ends it and the door registers a new one.

**The poll.** One timer for every entry while there is one, on the 5 s candle's boundary plus
`SIGNAL_WAIT_POLL_OFFSET_MS` (1 s) by the bot's clock: the scanner decides at the boundary plus
`SIGNAL_SCAN_SLACK_MS` (500 ms, the backend's, stated). A tick reads `GET /trading/signals` and
`GET /trading/pairs` once and decides every entry on that snapshot: two requests a candle whatever
the number of waiting users. A pair has a signal now when it is in the fresh `5s` list and
`checkDemoTrade` takes it — the list's own definition. A tick that finds the previous one in
flight is skipped. Push from the backend would need an inbound server on the bot: not built.

**The screens.**

| Entry | Drawn | Then |
|---|---|---|
| the list, no pair yet | «🔎 Анализирую сигналы · ⏱ 5 с…» (`signalsWaiting`) + [🧭] / [🏠] | a poll with a pair: the list in the same message, its 30 s from that edit |
| the list with pairs | «📡 Сигналы сейчас…» + the pairs + [🔄 · 🧭] / [🏠] | after `SIGNALS_LIST_TTL_MS` (30 s): «🚀 Начать торговлю / Сигнал держится одну свечу (⏱ 5 с), и этот список устарел…» (`signalsExpired`) + [📡 Показать сигналы · 🧭] / [🏠], and the entry ends |
| the pair (the door) | «⏳ Проверяю сигнал по {symbol}…» (`pairWaiting`) + the other pairs with a signal now, under `pairWaitingAlternatives`, read at the press | the alternatives taken away after 30 s, the wait goes on; the pair's signal: the amount screen (demo) or the launch (real) by a fresh access read, and the entry ends |
| the pair (409 `no_signal` of a start) | the same, in place of the launch or the amount screen, as a new message for a press elsewhere and a typed amount; the alternatives from the first poll | the same; the amount screen keeps its way back (`l`/`a`) |
| the analysis | the analysis header, «⏳ Проверяю сигнал…» (`analysisWaiting`), the feature lines of a rule refusal + [🧭] / [🏠]; the alternatives from the first poll | the pair's signal: `POST /trading/signal` with `analysis` (#484) and access, then the card in the same message by `editMessageMedia` (a refused photo: its caption as text); no signal by that read, `fetch_failed` or a throw: the entry stays, one `warn` |
| any | — | the pair closed, gone or not taking 5 s by the fresh catalog: its refusal (`demoPairClosed` …), the entry ends; past `SIGNAL_WAIT_MAX_MS` (1 h, a technical bound below Telegram's 48 h, not a product limit) or at the stop: `signalsExpired`, the entry ends |

The alternatives are a snapshot: drawn once (by the door at its press, by the first poll for the
analysis and the start, which have no call left in their budget for the read), taken away after
30 s by one edit; a first poll with no other pair leaves the wait alone with the pair for good. A
wait for a pair edits its message at most three times: the alternatives, their removal, the next
step. The stop and the bound draw the list's text for every kind of entry, the pair's and the
analysis's too («…этот список устарел»): the owner adjusts the text at review (manager's decision
2026-10-21).

**Edits.** By the message's id outside any update, in the entry's language, through `send.ts`
(`editMessageTextByIdHtml`, `editMessagePhotoByIdHtml`), only when the whole screen differs — its
text and its keyboard: the render key, as the session tracker's (#568). Paced one every
`SIGNAL_WAIT_EDIT_GAP_MS` (200 ms, 5 a second): with the session recovery's 4 and the backend's
20 + 9 a second on the same token the worst coincidence is about 38 a second, above Telegram's
~30 ([bot-session.md](bot-session.md)), so a 429 stops the tick's edits and pauses every edit for
its `retry_after`. More than 25 resolutions on one candle stretch over the next ones (accepted
risk 3).

| An edit's outcome | The entry |
|---|---|
| done, or «message is not modified» | drawn |
| the message gone, the bot blocked (403) | ends, nothing sent |
| 429 | unchanged; the tick's edits stop, none before `retry_after` |
| another refusal, a transport failure | retried by the next ticks; the third ends it |
| anything else | `error`, ends |

| A tick's reads | The entries |
|---|---|
| failed (the signals, the catalog, a body without `5s`) | unchanged, but the list's 30 s, the alternatives' 30 s and the bound, counted on the clock; one `warn` `signal wait reads failed` for the series |
| read | each entry by the screens table |

While the candle source is down the lists are empty (`scanned: 0`): every entry waits, and a door
pressed then waits too (accepted risk 2: before #664 its `POST /trading/signal` could still open
on the REST fallback; the start keeps it).

**The stop.** `stop()` arms no more polls, waits for the tick in flight (at most
`SIGNAL_WAIT_INFLIGHT_MS`, 26 s: an analysis's resolution) and meanwhile turns every remaining
waiting message into `signalsExpired`: one edit launched every 200 ms inside
`SIGNAL_WAIT_SHUTDOWN_BUDGET_MS` (20 s, 100 messages), none after a 429, the launched ones awaited
(each within `TELEGRAM_API_TIMEOUT_MS`). The step is `signal waiter` of `runBot`'s drain
(`lifecycle.ts`); the chain holds `SIGNAL_WAIT_SHUTDOWN_BUDGET_MS + TELEGRAM_API_TIMEOUT_MS <
SHUTDOWN_BUDGET_MS` and `SIGNAL_WAIT_INFLIGHT_MS < SHUTDOWN_BUDGET_MS` at import.

Enforced by `signal-wait.test.ts` W1–W15, `demo.test.ts` → the wait for signals, W-door1–5 and
W-an1, `trading-session.test.ts` W-start1–3, `cycle-stake.test.ts`, `timing.test.ts` → the wait's
bounds, `lifecycle.test.ts`.

## Boundaries

- **#258** — `POST /trading/signal`, its cache and the decider ([signal.md](signal.md)).
- **#343** — `GET /trading/signals` and the scanner behind it ([signal.md](signal.md)); the bot
  only reads and joins it.
- **#360** — part 2 of #320, shipped: the session first on the analysis, the single trade behind
  «➕ Ещё», and the session offered under a finished single trade
  ([bot-demo-trade.md](bot-demo-trade.md#the-status-message)).
- **#127** — the stake button's press, the intent and its status (`intent:` buttons):
  [bot-demo-trade.md](bot-demo-trade.md). It runs `readDemoTrade` again at the press, with the
  saved stake of the user's mode or `broker.minTradeAmount` (#297, #326).
- **#284** — the session of five trades in the bot (five cycles since #552; real sessions #327): the button, status and stop
  ([bot-session.md](bot-session.md)); the worker half is shipped (#287,
  [trading-session.md](trading-session.md)).
- **#24** — the status card and its button ([bot-menu.md](bot-menu.md)).
- **#484** — the analysis reminder is the backend's mailing ([mailing.md](mailing.md)); the bot
  only sends `analysis` with the card's signal request and handles the button as any `demo:an`.
  The chain before the first demo session is #202, apart from it.
- No `/demo` command, and no check of the user at entry: a blocked or revoked user is refused by
  the backend when the intent is created (#127).
