# Stake sizing v1 (issue #19, default Martingale #450)

`apps/trading-worker/src/stake/` decides the amount of the next trade in a session, or stops the
session with a reason. It is a pure function: it reads no clock, no environment, no network and no
database, and writes no log. The same parameters and input always give the same decision. Its
caller is the session orchestrator (#287, `trading-session/orchestrator.ts`,
[trading-session.md](trading-session.md)), which builds the parameters with
`sessionStakeParams(settings)` from the session's `trading_sessions.settings` and feeds it the
session's history (#130).

Two strategies exist. `fixed` sends the same stake every time. `martingale` is a bounded
Martingale: after each loss the next stake recovers the loss of the streak plus the profit of the
base stake at the current payout. Since #450 new sessions run on `martingale` by default, with the
limits of [Defaults](#defaults); `SESSION_STAKE_STRATEGY=fixed` switches new sessions back. The
sizer's own default without parameters (`DEFAULT_STAKE_PARAMS`) stays `fixed`: only its tests use
it.

```bash
pnpm test --project unit apps/trading-worker/src/stake   # needs no database or Redis
```

## Use

```ts
const sizer = createStakeSizer(); // DEFAULT_STAKE_PARAMS: fixed, '1.00', stakeScale 2
const decision = sizer.next({
  history, payout, minTradeAmount, available, sessionStartedAtMs, nowMs: Date.now(),
});
```

`createStakeSizer(params?)` checks the parameters once (`assertStakeParams`) and keeps a frozen
copy in `sizer.params`; the caller changing its own object afterwards changes nothing. A decision
carries `version` (`STAKE_ALGORITHM_VERSION`, `'v1'`) but not the parameters, so a journal stores
`sizer.params` next to each decision.

## Inputs

| Field | Type | Source (the orchestrator, #287) |
|---|---|---|
| `history` | `readonly SessionTrade[]` | the session's trades in creation order |
| `payout` | number | `BinaryPair.payout` of the pair about to be traded; `fixed` does not read it |
| `minTradeAmount` | `DecimalString` | `broker_balance_snapshots.min_trade_amount` of the account |
| `available` | `DecimalString` | `broker_balance_snapshots.<mode>_available` |
| `sessionStartedAtMs`, `nowMs` | number | the session's `started_at` (database clock); the worker's clock, clamped to `started_at` so a worker clock behind the database's never throws (`orchestrator.db.test.ts` E11) |

`SessionTrade` is the module's own shape, so the module does not depend on the `trade_intents`
statuses:

| `kind` | Fields | The orchestrator (#287) maps from |
|---|---|---|
| `settled` | `stake`, `profit` (signed: `< 0` loss, `0` tie, `> 0` win) | `settled`, with `broker_trades.profit` |
| `rejected` | — | `rejected`: the order certainly never opened |
| `unresolved` | — | `manual_review`, a `settled` intent without its trade's profit, and any status without a result; a live intent never reaches the sizer, the attempt reschedules first |

## Data policy

Money is `DecimalString` at the input and output and a `bigint` scaled by 10^8 inside
(`money.ts`). The domain is that of `numeric(20,8)` and `tradeAmountSchema`: at most 12 integer and
8 fractional digits. A value outside it is refused, never rounded. `payout` is a JS number by the
`BinaryPair` contract. `parsePayout` turns it into an integer of scale 4 (the domain of
`broker_trades.payout numeric(8,4)`) through `String()` with no arithmetic, the policy of
`moneyWireSchema`. Zero, a negative value, `NaN`, `Infinity`, an exponent, more than 4 integer or
more than 4 fractional digits are refused. No JS float is made from money, and no `bigint` reaches
a decision.

Wrong parameters and a wrong clock (`nowMs` or `sessionStartedAtMs` not finite, negative, or
`nowMs < sessionStartedAtMs`) throw a `RangeError`. Bad data never throws: it is a `stop` with a
code.

## Decision order

`next(input)` runs these checks in this order, and the first one that fails is the answer:

| # | Check | Result |
|---|---|---|
| 0 | the clock | `RangeError` |
| 1 | each trade in index order: anything but `settled` or `rejected` | `stop unresolved_trade { index }`, for both strategies |
| 1 | `settled`: `stake` or `profit` outside the domain | `stop invalid_amount { field: 'history.stake' \| 'history.profit', index }` |
| 1 | `settled`: `stake <= 0`, then `profit < -stake` | `stop invalid_trade { index, problem: 'non_positive_stake' \| 'loss_exceeds_stake' }` |
| 2 | `minTradeAmount`, then `available`: outside the domain or `< 0` | `stop invalid_amount { field }` |
| 3 | the features (below) | — |
| 4m | martingale: `sessionElapsedMs > maxSessionDurationMs` | `stop session_duration_exceeded { sessionElapsedMs, maxSessionDurationMs }` |
| 5m | martingale: `step > maxSteps` | `stop max_steps_exceeded { step, maxSteps }` |
| 6m | martingale: the payout is refused, on step 1 too: a series that could not be continued is not started | `stop invalid_payout { payout }` (`String(payout)`) |
| 7m | martingale: step 1 is `baseStake`, later steps the formula below | — |
| 8m | martingale: `candidate > maxStake` | `stop max_stake_exceeded { amount, maxStake }` |
| 9m | martingale: `realizedSessionLoss + candidate > maxSessionLoss` | `stop max_session_loss_exceeded { amount, realizedSessionLoss, maxSessionLoss }` |
| 4f | fixed: `candidate = baseStake`; the payout and the martingale limits are not read | — |
| 10 | `candidate < minTradeAmount` | `stop below_min_trade_amount { amount, minTradeAmount }` |
| 11 | `candidate > available` | `stop insufficient_balance { amount, available }` |
| — | none of the above | `{ kind: 'stake', amount, features }` |

Every bound is inclusive: a value equal to its limit passes. The broker fixture's
`min_trade_amount` and `available` checks are inclusive too. A limit never adjusts the stake and
never skips a step: it stops the session. `amount` in a stop's `detail` is the canonical form
(`'2.18'`, `'1'`); the limits are echoed as they were given. A candidate above
`999999999999.99` is stopped by `maxStake` before it is formatted, so the `amount` of a `stake` is
always a valid trade amount.

The features: `settledTrades`; `consecutiveLosses` and `streakLoss`, walking the settled trades from
the end, where a loss counts and adds `-profit`, a tie and a rejected order are skipped, and a win
of any size or the start of the history ends the walk; `realizedSessionLoss = max(0, -Σ profit)`
over every settled trade; `sessionElapsedMs = nowMs - sessionStartedAtMs`; `step = 1` for `fixed`
and `consecutiveLosses + 1` for `martingale` — the raises `maxSteps` bounds. The step a trade's
message prints counts the trades of its cycle, ties included (#551,
[bot-session.md](bot-session.md#trade-messages-and-the-summary-464)), so with ties it can be above
this one and above `maxSteps`.

| Code | Source | What the orchestrator (#287) does |
|---|---|---|
| `unresolved_trade` | a trade without a result | a live intent never gets here: the attempt reschedules until it is terminal (reconciliation, #89, gives an `unknown` one its result). What reaches the sizer — `manual_review`, a `settled` intent without its profit — stops the session as `stake_stop`; no new stake is issued, which guards against counting a trade twice |
| `invalid_amount`, `invalid_trade`, `invalid_payout` | the data contract (a database row or the pairs catalog) | stops the session and logs a contract problem; the same data gives the same answer |
| `session_duration_exceeded`, `max_steps_exceeded`, `max_stake_exceeded`, `max_session_loss_exceeded` | a martingale limit | ends the session with the `stop_reason` of the same name (#450) |
| `below_min_trade_amount` | the account's broker minimum (`GET /broker/user`) | ends the session; the broker would answer 400 `Amount is below the minimum` |
| `insufficient_balance` | the mode's balance in the snapshot | ends the session; the broker would answer 400 `Insufficient balance` |

A martingale limit's stop ends the session with the `stop_reason` of the same name; every other
`stop` ends it as `stake_stop` (#287). The code is in the log line either way. The orchestrator
maps the codes through `STAKE_STOP_REASONS` (`satisfies Record<StopReason, …>`), and `StopReason`
is closed, so a code outside this table cannot be returned and a new one fails the typecheck until
it is mapped.

## Formula

With `s = stakeScale`, `floor_s` and `ceil_s` rounding to `s` fractional digits, and
`expectedProfit(x) = floor_s(x × payout / 100)` (the worst case: the fixture credits
`floor(amount × payout / 100)` in cents, docs/mock-broker.md; the live broker credits
`amount × payout / 100` unrounded, which is never less, [Live probe](#live-probe-2026-10-15)):

```
target = ceil_s(streakLoss + expectedProfit(baseStake))
stake  = ceil_s(target / (payout / 100))
```

`stake` is the smallest stake on the scale whose profit covers the target:
`expectedProfit(stake) >= target`, and the stake one step lower does not cover it. The tests check
both on a grid of 11 payouts and 9 losses. Rounding `target` up matters: a loss with 8 fractional
digits is not covered otherwise. Doubling is the special case of payout 100. A payout above 100
gives a stake below the loss, and the guarantee still holds.

Worked series (base `1.00`, `stakeScale 2`, every step a loss):

| payout | stakes | profit of each step (floored) >= its target |
|---|---|---|
| 85 | `1.00, 2.18, 4.75, 10.33, 22.49` | 1.85, 4.03, 8.78, 19.11 |
| 100 | `1.00, 2.00, 4.00, 8.00` | 2, 4, 8 |
| 82.5 | `1.00, 2.21, 4.89` | 1.82, 4.03 |
| 7.5 | `1.00, 14.27, 204.54`: a low payout runs the stake up into `maxStake` | 1.07, 15.34 |

At payout 85 the stake `2.17` would earn `floor2(1.8445) = 1.84 < 1.85`. A streak loss of
`1.00000001` gives target `ceil2(1.85000001) = 1.86` and stake `2.19`; without rounding the target
up the stake would be `2.18`, whose profit `1.85` does not cover `1.85000001`.

The session loss is checked before the stake: with `maxSteps 4` and `maxSessionLoss '10.00'`, after
losses of `1.00, 2.18, 4.75` (realized `7.93`) the next stake `10.33` is step 4, which passes, and
`7.93 + 10.33 = 18.26 > 10.00` stops the session with `max_session_loss_exceeded`. No single stake
can take the session past `maxSessionLoss`.

## Output

```ts
| { kind: 'stake'; version: 'v1'; amount; features }
| { kind: 'stop'; version: 'v1'; reason: <limit reason>; features; detail }
| { kind: 'stop'; version: 'v1'; reason: <data reason>; detail }
```

`amount` has exactly `stakeScale` fractional digits (`"10.00"`; `"1"` at scale 0) and passes
`tradeAmountSchema`. `features` is `{ strategy, step, consecutiveLosses, streakLoss,
realizedSessionLoss, settledTrades, sessionElapsedMs, baseStake }`, with the amounts as
`DecimalString`. No key is ever `undefined`, and a decision survives
`JSON.parse(JSON.stringify(decision))` unchanged. All codes come from `as const` constants in
`codes.ts`: `StakeKind`, `StakeStrategy`, `SessionTradeKind`, `StopReason`, `TradeProblem` and
`AmountField`.

## Parameters

`StakeParams` is a union: `{ strategy: 'fixed', baseStake, stakeScale }` or
`{ strategy: 'martingale', baseStake, stakeScale, limits }`. The sizer has no default limits: the
type requires all four, and `assertStakeParams` checks the same for an object that did not come
from a literal. A session's limits are written into its settings at the start
([Defaults](#defaults)).

| Name | Default | Rule |
|---|---|---|
| `strategy` | `fixed` | `fixed` or `martingale`; `fixed` carries no `limits` |
| `baseStake` | `'1.00'` | in the domain, `> 0`, at most `stakeScale` significant fractional digits (it is sent as it is) |
| `stakeScale` | 2 | integer in `[0, 8]`; every stake is rounded up to it |
| `limits.maxSteps` | — | integer `>= 2` (a one-step martingale is `fixed`) |
| `limits.maxStake` | — | in the domain, `>= baseStake` |
| `limits.maxSessionLoss` | — | in the domain, `>= baseStake`; below it the session would stop on its first stake |
| `limits.maxSessionDurationMs` | — | integer `>= 1` |

The defaults are checked when `config.ts` is imported, so a default edited out of its rules fails
at import.

## Defaults

Decided for #450 (owner 2026-10-10, item 3; the night's manager chose 12×). The strategy of new
sessions is `SESSION_STAKE_STRATEGY` (`martingale` or `fixed`; unset is `martingale`; anything
else, an empty value included, stops the backend and the `session-start` CLI at start). The start
route and the CLI write it into the session's settings v2 with `buildSessionSettings`, and for
`martingale` the limits of the session's base stake B, from `martingaleLimitsFor(B)`
(`packages/shared/src/trading-session.ts`, the one place of the multipliers):

| Limit | Default | Constant |
|---|---|---|
| `maxSteps` | 4: at most three raises in a row | `MARTINGALE_MAX_STEPS` |
| `maxStake` | 12 × B | `MARTINGALE_MAX_STAKE_MULTIPLIER = 12n` |
| `maxSessionLoss` | 20 × B | `MARTINGALE_MAX_SESSION_LOSS_MULTIPLIER = 20n` |
| `maxSessionDurationMs` | 3 600 000, the session's hour | `SESSION_MAX_DURATION_MS` |

The multiplication is `bigint` at scale 8 (`multiplyDecimal`), so a limit is canonical and on the
grid of B (`1.55` → `18.6`, `31`). A B whose limit leaves `numeric(20,8)` fails the settings
schema: the start route answers `balance_unavailable`, the CLI `invalid_settings`.

A series of losses only, stakes as multiples of B at `stakeScale 2`, by the sizer itself:

| payout | stakes of steps 1-4 | loss of 4 losses | what stops step 4 at 12×/20× |
|---|---|---|---|
| 96 % | 1 · 2.05 · 4.18 · 8.54 | 15.77 B | nothing; step 5 is `max_steps_exceeded` |
| 90 % | 1 · 2.12 · 4.47 · 9.44 | 17.03 B | nothing |
| 87 % | 1 · 2.15 · 4.63 · 9.95 | 17.73 B | nothing |
| 85 % | 1 · 2.18 · 4.75 · 10.33 | 18.26 B | nothing |
| 80 % | 1 · 2.25 · 5.07 · 11.40 | 19.72 B | nothing |
| 79 % (a payout that fell inside the session, #509) | 1 · 2.27 · 5.14 · 11.65 | 20.06 B | `max_session_loss_exceeded` |
| 77 % | 1 · 2.30 · 5.29 · 12.16 | — | `max_stake_exceeded` |
| 70 % | 1 · 2.43 · 5.90 · 14.33 | — | `max_stake_exceeded` |

**A deviation from the owner's figure.** The owner asked for one stake at most «~10×» B. At 10×
the fourth stake passes only at a payout of 87 % or more, so at the usual 80-86 % a series would
have two raises, not three. 12× keeps three raises at every payout from the start's 80 % floor,
and the session's loss stays within 20 × B. Back to 10×: `MARTINGALE_MAX_STAKE_MULTIPLIER = 10n`
and its pin in `trading-session.test.ts`; then at 80-86 % step 4 stops as `max_stake_exceeded`.

Rules of a session that the defaults do not change (#450 clarify):

- A tie leaves the series as it is: the next stake is the same step (`orchestrator.db.test.ts` G2,
  `steps-parity.test.ts`); the trade's message shows it as the next step of the same cycle
  (#551).
- The session ends at its N-th settled trade, in the middle of a series too (G9); its result shows
  the series' loss.
- Only the base stake is checked against the balance at the start. A series that outgrows the
  balance stops as `stake_stop` (`insufficient_balance`, G8).
- The strategy and the limits are frozen in the session's row at the start: switching
  `SESSION_STAKE_STRATEGY` changes new sessions only, and a v1 row of a session started before
  #450 trades on as `fixed`.

## Live probe (2026-10-15)

The four open items of #19 were closed by the owner on the pilot's demo account before Martingale
became the default (#450 comments of 2026-10-15). Sources: the broker's public catalog
`GET /v1/broker/pairs/binary` (144 pairs) and a read-only query of the pilot's `broker_trades`
(581 demo trades, 580 closed: 277 wins, 293 losses, 10 with `profit = 0`; stakes 1-100), then a demo
session with a stake of 1.55 at a payout of 87 % (session `44abf84b-…`).

| Item | Result | Evidence |
|---|---|---|
| 1. A stake with two fractional digits | closed: accepted | the broker took `amount "1.55"` and opened a trade of 1.55 (`raw.amount` 1.55); a loss took exactly 1.55 |
| 2. How `potential_profit` and `profit` are rounded | closed: `profit` is not rounded | a win of 1.55 at 87 % paid `profit` 1.3485 = 1.55 × 87 / 100 exactly (`raw.profit` 1.3485), more digits than `stakeScale`; `potential_profit` of the open trade was 1.35, a display value rounded to 2 digits (round-half-up or ceil, one sample cannot tell) that can be above the real payout by a fraction of a cent. All 277 earlier wins had `profit = amount × payout / 100` exactly, with integer stakes and payouts never needing a rounding |
| 3. A tie | closed: observed, the stake comes back | 10 trades of 5, 15 and 60 s at payouts 77-96 had `close_price = open_price` and `profit = 0`; no `profit = 0` at different prices and no non-zero profit at equal ones. The next stake after a tie is the owner's decision (above), not an observation |
| 4. The form of `payout` | closed: whole percent | every `payout` and `max_payout` of the catalog is an integer, 50-96, and so is `raw.payout` of all 581 trades; the "at most 4 fractional digits" rule holds with room |

What follows for the formula:

- `floor_s` is the conservative case. The real `profit` is at least `floor2(S × p / 100)`, so a
  series is recovered with a small margin and never short; the falsifiable claim of item 2
  ("`potential_profit` is not below `floor2(S × p / 100)`") holds.
- `potential_profit` is not the payout: nothing here reads it as the amount credited.
- The session's and the series' P&L can have more digits than `stakeScale` (up to 4 with a stake
  of 2 digits and a whole payout). The sizer counts them exactly (`size.test.ts` S23), and the bot
  prints a session's result with every digit (`formatSignedUsd`: `-$1.7515`, not the smaller
  `-$1.75`).
- The next martingale stake is still rounded up to `stakeScale`: the broker took 2 digits, more
  were not tried.

The payout is read from the catalog when the decision is made; the broker may open the trade at a
different `trade.payout`. The streak loss is counted from the actual `profit`, so a drifting payout
only changes one step's profit target, not the loss accounting. The session loss counts settled
trades only, and an unresolved trade stops the sizer, so the pre-check never undercounts.

## What it is not

- It does not wire itself into a session, read the database or the env, or log. The strategy of a
  session is chosen by `SESSION_STAKE_STRATEGY` at its start, not here.
- It makes no backtest, no tuning and no profitability claim. A Martingale raises the stake after
  every loss; its limits bound the damage, they do not remove it.
- It contains no user-facing text. The Russian wording of a stop reason is the bot's
  (`sessionStatusText` in `apps/bot/src/texts.ts`, [bot-session.md](bot-session.md#the-status-message)).

## Boundaries

- #130: `trading_sessions.settings` and the history read `readSessionHistory`
  ([trading-session.md](trading-session.md)). #287: the orchestrator that feeds them to the sizer
  (shipped). #450: settings v2 with the strategy and the limits, Martingale by default.
- #89: the result of an unresolved trade.
- The module's bigint arithmetic stays here; the limits' multiplication is shared's
  `multiplyDecimal` (`packages/shared/src/stake.ts`), which the start route and the CLI need.
- The invariant is Architecture Rules -> "Размер ставки v1" in `.claude/skills/architect/SKILL.md`.
