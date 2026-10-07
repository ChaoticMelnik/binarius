# The demo: an asset, a duration and the analysis on a fresh catalog (issues #125, #126)

The status card's «🎮 Запустить демо» button (#24, [bot-menu.md](bot-menu.md)) leads to five
screens in one message: the asset types, one type's pairs by page, the durations of a pair, the
summary of the choice with «📊 Анализ», and the analysis. Every screen reads the broker's pairs again through
`GET /trading/pairs` ([pairs-catalog.md](pairs-catalog.md)) and draws nothing from an earlier
read. «📊 Анализ» shows the analysis of the pair's candles by Signal module v1 (#126,
[The analysis](#the-analysis)); the trade behind its stake button is #127
([bot-demo-trade.md](bot-demo-trade.md)).

```bash
pnpm test --project unit apps/bot/src packages/broker-rest packages/shared/src/catalog.test.ts apps/backend/src/trading/pairs-routes.test.ts   # needs no database or Redis
```

## Components

- `apps/bot/src/demo-catalog.ts` — the check, with no Telegram and no texts:
  `DEMO_ASSET_GROUPS`, `DEMO_DURATIONS_SEC`, `DEMO_PAGE_SIZE`, `groupOf`, `isOpen`, `pairsOf`,
  `openPairsOf`, `pageOf`, `pageIndexOf`, `durationOptions`, `checkDemoPair`, `checkDemoTrade`,
  `readDemoCatalog`, `readDemoTrade`.
- `apps/bot/src/demo.ts` — `createDemoComposer({ backend, logger, now })`: the six handlers, the
  callback data builders (`DEMO_CALLBACK_DATA`, `DEMO_GROUPS_CALLBACK_DATA`,
  `demoPageCallbackData`, `demoAssetCallbackData`, `demoDurationCallbackData`,
  `demoAnalysisCallbackData`, `stakeCallbackData`), `STAKE_CALLBACK_PATTERN`, `stakeDataOf` and
  `newStakeNonce` (#127), the keyboards, and `editOrReply`, which returns its outcome. `bot.ts`
  mounts it once under its private-chat filter, after `/help` and before the text handler, and
  mounts #127's `createDemoTradeComposer` (the stake press) right after it.
- `apps/bot/src/analysis.ts` — the analysis screen as a pure function (#126): `analysisScreen`,
  `analysisUnavailableScreen`, `analysisSubject`, `NO_SIGNAL_REASON_TEXT`, `TREND_WORDS`,
  `MOMENTUM_WORDS`, `VOLATILITY_WORDS` (maps to catalog keys, [bot-texts.md](bot-texts.md)),
  `formatPrice`, `formatRsi`, `formatAtrPct`.
- `apps/bot/src/screen.ts` — `editRefusal`, the classification of a refused edit, shared with
  `/settings`.
- `apps/bot/src/backend-client.ts` — `readPairs()`: a `GET trading/pairs` under the bearer with
  no body, parsed by `safeParsePairsCatalogResponse`, the whole answer returned;
  `evaluateSignal(assetId, interval)`: a `POST trading/signal` with `{ assetId, interval }`,
  parsed by `safeParseTradingSignalResponse`, the whole answer returned (a `fetch_failed` is an
  answer, not an error).
- `apps/bot/src/texts.ts` — the `demo*` entries of `TEXTS`, `demoPairsScreen`,
  `demoDurationsScreen`, `demoSummary`, `DEMO_GROUP_LABELS`, `DEMO_DURATION_LABELS`,
  `groupButtonLabel`, `pairButtonLabel`, and the `demo*Button` labels; the `analysis*`,
  `analyzing` entries, `ACTION_LABELS`, `stakeButtonLabel` and
  `LABELS.repeatAnalysisButton` (#126); the texts are catalog entries
  ([bot-texts.md](bot-texts.md)).
- `apps/bot/src/timing.ts` — `HANDLER_CALLS.demo`, `.demoGroups`, `.demoPage`, `.demoAsset`,
  `.demoDuration`, `.demoAnalysis`; the link
  `TRADING_SIGNAL_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS`.
- `packages/broker-rest/src/pairs-catalog.ts` and `packages/shared/src/catalog.ts` — the `fresh`
  flag of the catalog ([Fresh](#fresh)).

## Sequence

```text
demo                      (the card's button)
  bot  → answerCallbackQuery ∥ GET /trading/pairs
  bot  → sendMessage: the types present, each «💱 Валюты · 46» with its count of open pairs
demo:g                    («↩️ Типы»)        → the same screen, edited in place
demo:t:<group>:<page>     (a type, «◀️», «▶️») → the type's open pairs, page <page>
demo:a:<assetId>          (a pair, «↩️ Длительность»)  → the check of the pair, then its durations
demo:d:<assetId>:<sec>    (a duration)       → readDemoTrade, then the summary with «📊 Анализ»
demo:an:<assetId>:<sec>   («📊 Анализ», «🔄 Повторить анализ»)
  bot  → answerCallbackQuery ∥ GET /trading/pairs → readDemoTrade
  bot  → editMessageText: «⏳ Анализирую EUR/USD OTC · ⏱ 1 мин…», no keyboard
  bot  → POST /trading/signal { assetId, interval: intervalForDuration(sec) }
  bot  → editMessageText: the analysis screen with its keyboard
demo:stake:<assetId>:<sec>:<up|down>:<nonce>  (the stake button) → the trade, bot-demo-trade.md
```

Each press after the first answers the query and reads the catalog at the same time, then
edits the message the button is under. `demo` is the exception: the card is a photo, whose caption
cannot be turned into another screen, so it sends a new message. The bot keeps no state for the
demo: what the user chose travels in the callback data, so a restart, an old message and a second
device lead to the same screen.

The callback data is at most 44 bytes (`demo:stake:2147483647:3600:down:0123456789ab`), inside the
Bot API 64.
`<group>` is one of `DEMO_ASSET_GROUPS`, never the broker's own string; `<page>` is up to four
digits; `<assetId>` is up to ten digits, parsed by `createTradeIntentRequestSchema.shape.assetId`
(a positive int4, what #127 sends); `<sec>` is one of `DEMO_DURATIONS_SEC`, written into the
pattern, so `demo:an:101:120` and `demo:stake:101:120:up:0123456789ab` match nothing; `<up|down>`
is a `TradeAction`; `<nonce>` is 12 lowercase hex characters. Data that matches a pattern but fails its check (`demo:a:0`, `demo:t:bond:0`)
stops the spinner and sends nothing; data that matches no pattern is not answered at all.

## The check

`readDemoTrade(backend, assetId, durationSec, now)` reads the catalog, then checks the pair on the
clock taken after the read. #126 calls it before it shows the stake button, #127 before it
creates the intent; neither re-implements a check.

| Outcome | Source | What the bot shows |
|---|---|---|
| `catalog_unavailable` | `503 catalog_unavailable`, told by the reason: the route has no snapshot (not warmed yet, or the broker failing for longer than `BROKER_PAIRS_MAX_STALE_MS`) | «⚠️ Каталог активов сейчас недоступен…» + «🔄 Повторить»; no log line, the backend logs each failed refresh |
| `catalog_stale` | `200` with `fresh: false` | «⏳ Каталог активов обновляется…» + «🔄 Повторить»; no log line |
| `backend_failed` | any other refusal (401, 404, 400, …), a 5xx, no answer, a timeout, a broken body | «⚠️ Сервис временно недоступен…» + «🔄 Повторить»; `warn` `demo catalog not read` |
| `pair_missing` | the id is not in the catalog (delisted, or forged data) | «❌ Этот актив больше не доступен…» + «↩️ Типы» |
| `pair_closed` | `scheduledUntil > now` on the bot's clock | «🔒 {symbol} сейчас закрыт по расписанию…» + «↩️ Активы» + «↩️ Типы» |
| `duration_unsupported` | the duration is not one of `DEMO_DURATIONS_SEC` (#125 review m5: it arrives from callback data), or is outside `[minTimeframe, maxTimeframe]` | «❌ Эта длительность не подходит для {symbol}…» + «↩️ Длительность» + «↩️ Типы» |

«🔄 Повторить» carries the pressed data again, so a retry after `demo:d:…` lands on the summary
once the catalog is back. A retry is always safe: nothing in the demo writes anything.

A pair is open when `scheduledUntil` is 0 or not after now (`isOpen`): the broker sends
milliseconds since the epoch, read as "not tradable until" — the mock broker's reading, which
refuses an order only while `scheduled_until > now`. The durations a pair admits are
`DEMO_DURATIONS_SEC` within `[minTimeframe, maxTimeframe]`, both ends included (`durationOptions`).

`demo:a` checks the pair too (`checkDemoPair`), since it can close between the page and the
press, and an empty catalog reads as `catalog_unavailable` on the types screen: there is nothing
to choose from.

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
  `DEMO_ASSET_GROUPS`: 💱 Валюты, 🛢 Сырьё, 📈 Акции, 💠 Криптовалюты, 📊 Индексы, 📁 Другие (any
  broker type outside the five). A type with no pair at all has no button; a type with pairs but
  none open shows «· 0» and its press says «🔒 {type}: сейчас всё закрыто по расписанию».
- **Pairs.** `DEMO_PAGE_SIZE` = 12 open pairs, two per row, sorted by symbol in code-unit order
  (ties by id), each «EUR/USD OTC · 85%» — the broker's symbol (it carries «OTC» itself) and its
  payout as it arrives. Then one row: «◀️» when a page before exists, «↩️ Типы», «▶️» when a page
  after exists. A page beyond the end (the catalog shrank) is the last page. Closed pairs are not
  listed.
- **Durations.** The admitted durations of `⏱ 1 мин`, `⏱ 5 мин`, `⏱ 15 мин`, `⏱ 30 мин`, `⏱ 1 ч`,
  three per row, then «↩️ Активы» (the pair's type, the page it is listed on) and «↩️ Типы». A
  pair that admits none says so, with the two back buttons.
- **Summary.** «📊 Анализ», then «↩️ Длительность» and «↩️ Типы».
- **Analysis.** On a signal, «🚀 Открыть сделку: ⬆️ Вверх» (or «⬇️ Вниз») alone in the first row;
  then «🔄 Повторить анализ» (the same `demo:an` data); then «↩️ Длительность» and «↩️ Типы».
  «⏳ Анализирую…» has no keyboard, so «📊 Анализ» cannot be pressed twice while the signal is
  asked for.

At most 15 buttons on a screen. Labels are plain strings; every label but a pair's starts with an
emoji.

## Texts

Every fragment is a `TEXTS` entry and the screens are assembled by `demoPairsScreen`,
`demoDurationsScreen`, `demoSummary` and `analysisScreen`; the symbol is a hole of
`telegramHtml`, escaped once. The pairs screen, the durations screen, the summary and the
analysis of a signal each say once what the payout is: the size of a win on a right forecast, not
its probability. No profit, accuracy or probability is promised (`texts.test.ts` holds the
absence of «вероятност» and «точност» in every analysis entry); the only numbers are the broker's
payout, the page count and the signal's own features.

## The analysis

`demo:an` keeps the order «check, then the screen». `readDemoTrade` runs on the catalog read at
this press; any refusal is the table in [The check](#the-check), with no «⏳» and no signal asked
for. On `ok` the summary becomes «⏳ Анализирую {symbol} · {duration}…», then
`evaluateSignal(assetId, intervalForDuration(sec))` asks the backend's `POST /trading/signal`
([signal.md](signal.md#post-tradingsignal-258)), then the screen replaces «⏳». The interval is
the longest table candle not above the duration; on `DEMO_DURATIONS_SEC` it is the duration
itself (`analysis.test.ts` A1 breaks when the two tables part).

Where «⏳» went decides where the result goes (`editOrReply`'s outcome):

| «⏳» | Then |
|---|---|
| edited, or «message is not modified» | the signal, then the result through `editOrReply` (its own four outcomes) |
| the summary gone → «⏳» sent anew | the signal, then the result as a new message with its keyboard |
| failed in transport | nothing more, and no signal asked for: a second message after an unknown delivery is worse than none |
| any other refusal | `bot.catch`, nothing more |

The screen (`analysisScreen`) is built from this press's pair and the answer only:

| Answer | Headline | Body | Stake button |
|---|---|---|---|
| `decided`, `signal` | «📈 Сигнал: ⬆️ Вверх» / «📉 Сигнал: ⬇️ Вниз» | the feature lines, the payout, «⚠️ Сигнал — не прогноз результата и не гарантия…» | yes, by the decision's action |
| `decided`, a rule refusal (`volatility_too_low`, `volatility_too_high`, `trend_flat`, `rsi_neutral`, `trend_momentum_disagree`) | «⏸ Сигнала нет: {reason in words}» | the feature lines, «Без сигнала бот сделку не предлагает…» | no |
| `decided`, a data refusal (`insufficient_candles`, `candle_gap`, `stale`, `invalid_candle`) | «⏸ Сигнала нет: {reason in words}» | «Повтори анализ через минуту…»; no feature line, the decision carries none | no |
| `fetch_failed` `rate_limited` with `retryAfterSec` | «⚠️ Брокер ограничил запросы. Попробуй через N с.» | — | no |
| any other `fetch_failed`, `rate_limited` without `retryAfterSec` | «⚠️ Не удалось получить свечи у брокера…»; `warn` `signal not evaluated` with `signalCode` (not for `rate_limited`) | — | no |
| `evaluateSignal` threw (unreachable, a timeout, a non-2xx, a broken body) | the same; `warn` `signal not evaluated` with the error | — | no |

The feature lines, every number from the answer:

- «📐 Тренд по EMA: вверх — EMA{params.emaFast} {features.emaFast} выше EMA{params.emaSlow}
  {features.emaSlow}» — «выше»/«ниже»/«равна» by the order of the two EMAs; the trend words
  вверх / вниз / не определён.
- «⚡ Импульс по RSI: вверх — RSI{params.rsiPeriod} {features.rsi}» — вверх / вниз / нейтральный.
- «🌊 Волатильность по ATR: в норме — ATR{params.atrPeriod} {features.atrPct}%» — told by the
  refusal (слишком низкая / слишком высокая), since the decider checks volatility first; the bot
  holds no bounds of its own.
- «🕯 Закрытых свечей: {features.closedCandles}» and «💲 Последняя цена: {features.lastClose}».

Prices are printed with the pair's `digits`, RSI to a tenth, ATR% to a thousandth (a live 1m ATR%
sits in the hundredths and thousandths). The periods come from `params`, never from the bot: a
backend tuned to other periods prints those (`analysis.test.ts` A2 runs on non-default ones).

The stake button is drawn only on a signal, which is reached only after `readDemoTrade` was `ok`
on this press: the pair open by its schedule and the duration inside its range on a fresh
catalog. Its data `demo:stake:<assetId>:<sec>:<up|down>:<nonce>` parses with
`createTradeIntentRequestSchema.shape` (`stakeDataOf`). The nonce (`newStakeNonce`, 6 random bytes
in hex) is drawn once per render, «🔄 Повторить анализ» included, and is the trade's idempotency
key (#127): the same button pressed again replays its trade, the button of a new render opens a
new one. The press is #127's ([bot-demo-trade.md](bot-demo-trade.md)); data the schema refuses
(`demo:stake:0:60:up:0123456789ab`) only stops the spinner.

## Edits

`editOrReply` edits the message the pressed button is under, and classifies every refusal
(`screen.ts`):

- «message is not modified» (the same screen pressed twice) — done; `info`
  `the demo screen already shows this`.
- «message to edit not found» / «message can't be edited» — the screen is sent anew with the same
  keyboard; `warn` `the demo screen was not edited, sending it anew`.
- any other refusal — to `bot.catch`, nothing sent; the keyboard on screen is the retry.
- a transport failure — the edit is unknown, nothing more is sent; `error`
  `the demo screen edit failed in transport, sending nothing more`.

`answerCallbackQuery` runs beside the catalog read; a refused answer is logged
(`answering the callback query failed`) and the screen still goes.

## Timing

`HANDLER_CALLS.demo` is one backend call and two Bot API calls (the answer beside the read, then
the new message); each of `.demoGroups`, `.demoPage`, `.demoAsset` and `.demoDuration` is one
backend call and up to three Bot API calls (the edit refused as gone, then the message sent
anew): 5 000 + 3 × 8 000 = 29 s. `.demoAnalysis` is two backend calls and up to four Bot API
calls — «⏳» refused as gone and sent anew, the signal, the result sent; or «⏳» edited, the
signal, the result's edit refused as gone and sent anew: 2 × 5 000 + 4 × 8 000 = 42 s.
`.stakePlaceholder` is the answer and one message. All are under `confirm`'s 45 s, so
`HANDLER_BUDGET_MS`, the shutdown budget and the compose grace period do not move. The answer and
the read run together and are counted as sequential, as for oauth. `timing.test.ts` runs every
terminal branch of the seven through the real handlers. The pairs route reads the cache in
memory; the signal route makes at most one chart GET, inside `TRADING_SIGNAL_BUDGET_MS` (4 s),
and `TRADING_SIGNAL_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS` is checked at import and in
`timing.test.ts`.

## Logging

- `demo catalog not read` (`warn`) — `err` with the `BackendError`'s name and code,
  `backendStatus`, `backendReason`; no Telegram id, no symbol.
- `signal not evaluated` (`warn`, #126) — for a thrown call, `err` with the error's name and code,
  `backendStatus`, `backendReason`; for a `fetch_failed` other than `rate_limited`, `signalCode`
  alone. No Telegram id, no symbol, nothing of the broker's text.
- the three edit outcomes above — the method and the Telegram error code, never the description
  or the text; the transport line also names the update id.
- `answering the callback query failed` (`warn`) — the method and the code.

`logging.test.ts` reads these lines back from the pino sink.

## Boundaries

- **#258** — `POST /trading/signal`, its cache and the decider ([signal.md](signal.md)).
- **#127** — the stake button's press, the intent and its status (`intent:` buttons):
  [bot-demo-trade.md](bot-demo-trade.md). It runs `readDemoTrade` again at the press, with the
  amount `broker.minTradeAmount`.
- **#284** — the demo session of five trades in the bot; the worker half is shipped (#287,
  [trading-session.md](trading-session.md)).
- **#24** — the status card and its button ([bot-menu.md](bot-menu.md)).
- No `/demo` command, and no check of the user at entry: a blocked or revoked user is refused by
  the backend when the intent is created (#127).
