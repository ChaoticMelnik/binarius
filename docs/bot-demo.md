# The demo: an asset and a duration on a fresh catalog (issue #125)

The status card's «🎮 Запустить демо» button (#24, [bot-menu.md](bot-menu.md)) leads to four
screens in one message: the asset types, one type's pairs by page, the durations of a pair, and
the summary of the choice with «📊 Анализ». Every screen reads the broker's pairs again through
`GET /trading/pairs` ([pairs-catalog.md](pairs-catalog.md)) and draws nothing from an earlier
read. «📊 Анализ» shows a placeholder for now; the analysis is #126 and the trade #127.

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
  `demoAnalysisCallbackData`), the keyboards, and `editOrReply`. `bot.ts` mounts it once under
  its private-chat filter, after `/help` and before the text handler.
- `apps/bot/src/screen.ts` — `editRefusal`, the classification of a refused edit, shared with
  `/settings`.
- `apps/bot/src/backend-client.ts` — `readPairs()`: a `GET trading/pairs` under the bearer with
  no body, parsed by `safeParsePairsCatalogResponse`, the whole answer returned.
- `apps/bot/src/texts.ts` — the `demo*` entries of `TEXTS`, `demoPairsScreen`,
  `demoDurationsScreen`, `demoSummary`, `DEMO_GROUP_LABELS`, `DEMO_DURATION_LABELS`,
  `groupButtonLabel`, `pairButtonLabel`, and the `demo*Button` labels.
- `apps/bot/src/timing.ts` — `HANDLER_CALLS.demo`, `.demoGroups`, `.demoPage`, `.demoAsset`,
  `.demoDuration`, `.demoAnalysis`.
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
demo:an:<assetId>:<sec>   («📊 Анализ»)      → readDemoTrade, then the placeholder
```

Each press after the first answers the query and reads the catalog at the same time, then
edits the message the button is under. `demo` is the exception: the card is a photo, whose caption
cannot be turned into another screen, so it sends a new message. The bot keeps no state for the
demo: what the user chose travels in the callback data, so a restart, an old message and a second
device lead to the same screen.

The callback data is at most 26 bytes (`demo:t:cryptocurrency:9999`), inside the Bot API 64.
`<group>` is one of `DEMO_ASSET_GROUPS`, never the broker's own string; `<page>` is up to four
digits; `<assetId>` is up to ten digits, parsed by `createTradeIntentRequestSchema.shape.assetId`
(a positive int4, what #127 sends); `<sec>` is one of `DEMO_DURATIONS_SEC`, written into the
pattern. Data that matches a pattern but fails its check (`demo:a:0`, `demo:t:bond:0`) stops the
spinner and sends nothing; data that matches no pattern is not answered at all.

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
| `duration_unsupported` | the duration is outside `[minTimeframe, maxTimeframe]` | «❌ Эта длительность не подходит для {symbol}…» + «↩️ Длительность» + «↩️ Типы» |

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
- **Summary.** «📊 Анализ», then «↩️ Длительность» and «↩️ Типы». The placeholder after it has the
  two back buttons.

At most 15 buttons on a screen. Labels are plain strings; every label but a pair's starts with an
emoji.

## Texts

Every fragment is a `TEXTS` entry and the screens are assembled by `demoPairsScreen`,
`demoDurationsScreen` and `demoSummary`; the symbol is a hole of `telegramHtml`, escaped once.
The pairs screen, the durations screen and the summary each say once what the payout is: the size
of a win on a right forecast, not its probability. No profit, accuracy or probability is promised;
the only numbers are the broker's payout and the page count.

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
the new message); each of `.demoGroups`, `.demoPage`, `.demoAsset`, `.demoDuration` and
`.demoAnalysis` is one backend call and up to three Bot API calls (the edit refused as gone, then
the message sent anew): 5 000 + 3 × 8 000 = 29 s, under `confirm`'s 45 s, so `HANDLER_BUDGET_MS`,
the shutdown budget and the compose grace period do not move. The answer and the read run
together and are counted as sequential, as for oauth. `timing.test.ts` runs every terminal branch
of the six through the real handlers. The route reads the cache in memory; no broker call is on
the request path.

## Logging

- `demo catalog not read` (`warn`) — `err` with the `BackendError`'s name and code,
  `backendStatus`, `backendReason`; no Telegram id, no symbol.
- the three edit outcomes above — the method and the Telegram error code, never the description
  or the text; the transport line also names the update id.
- `answering the callback query failed` (`warn`) — the method and the code.

`logging.test.ts` reads these lines back from the pino sink.

## Boundaries

- **#126** — the analysis behind «📊 Анализ» (it replaces the placeholder's screen and keeps the
  check before it), `POST /trading/signal`, the stake button through `readDemoTrade`.
- **#127** — the stake button's handler, the intent and its status (`intent:` buttons); it runs
  `readDemoTrade` again at the press.
- **#130** — the demo session of five trades.
- **#24** — the status card and its button ([bot-menu.md](bot-menu.md)).
- No `/demo` command, and no check of the user at entry: a blocked or revoked user is refused by
  the backend when the intent is created (#127).
