# Mailing engine (#202)

What the bot sends a user who did not ask for it — a reminder, a nudge — goes through one engine
in the backend process. A mailing is a row of `notification_jobs`; the engine plans the rows from
facts already in the database and sends the due ones through the client push, the backend's one
send seam for user texts ([bot-start.md](bot-start.md) → Two seams).

Today it carries five scenarios: the **first-session chain**, three reminders that lead a user who
connected an account but has not started a trading session into the demo, the **analysis
reminder** (#484), one reminder after an analysis card nobody acted on, the **referral reward
notification** (#576), one message to an inviter per reward, the **low-token nudge** (#123),
one push when the balance falls to a share of the user's starter pack, and the **real-mode
notification** (#686), one message per deposit that switched the user to real, the one
*important* kind. #124 (retention) adds its
scenarios to the same engine.

```bash
pnpm test --project unit apps/backend/src/mailing apps/backend/src/auth/client-push.test.ts apps/backend/src/trading/signal-routes.test.ts   # no database or Redis
pnpm test --project integration packages/db/src/mailing-ops.db.test.ts apps/backend/src/mailing   # TEST_DATABASE_URL (README → Test database)
```

## Files

- `packages/shared/src/mailing.ts` — `NotificationKind` (the kinds, and the CHECK on
  `notification_jobs.kind` and `notification_kinds.kind`), `FIRST_SESSION_CHAIN` (the steps and
  their offsets), `ANALYSIS_UNUSED_AFTER_MS`/`ANALYSIS_UNUSED_UNTIL_MS` and
  `analysisUnusedPayloadSchema` (#484), `REFERRAL_REWARDED_AFTER_MS` and
  `referralRewardedPayloadSchema` (#576), `TOKEN_NUDGES`, `TOKEN_NUDGE_AFTER_MS` and
  `tokenNudgePayloadSchema` (#123), `REAL_MODE_BY_DEPOSIT_AFTER_MS` and
  `realModeByDepositPayloadSchema` (#686), and `MAILING_MIN_OFFSET_MS`, the earliest offset among
  the kinds that wait.
- `packages/db/src/mailing-scenarios.ts` — `MAILING_SCENARIOS`: per kind, the facts it counts
  from (`facts`, a lateral row source over the user's row with a column `at`), the offset
  (`afterMs`), the dedupe key and the job's payload (SQL over the user's row and the fact; the
  payload `'{}'` when absent), the predicate it holds while it applies (`stillApplies`) and the
  claim's key predicate (`keyApplies`), and whether the planner takes a canceled job back
  (`replansCanceled`, #123), and whether it is important (`important`, #686, Delivery rules);
  `IMPORTANT_NOTIFICATION_KINDS` lists those, from the scenarios alone. A kind with one fact per
  user goes through `oneFact`: its facts are one row, its key reads the user's row only and the
  claim compares it directly.
- `packages/db/src/mailing-ops.ts` — the statements: `planMailingJobs`, `claimMailingJob`,
  `settleMailingJob`.
- `apps/backend/src/mailing/messages.ts` — `MAILING_MESSAGES`: per kind, the message built from the
  job's payload and the `MailingContext` (the cashier's URL, the user's mode and language at the
  claim; only #686's kind reads the language, the others are Russian until #633); the
  chain's keyboard is the demo button (`demoKeyboard`, `client-push.ts`), the same as the link
  push's re-login, the analysis reminder's a new analysis.
- `apps/backend/src/mailing/engine.ts` — the two loops, the pacer, the failure policy and
  `wakePlan()` (#686, The planner → The wake); its
  `cashierUrl` is `cashierUrlOf(WEB_PUBLIC_URL)`, passed once by `apps/backend/src/index.ts`;
  `apps/backend/src/auth/client-push.ts` — `sendMailing`, beside the link push.
- `apps/backend/src/timing.ts` — the `MAILING_*` numbers and their links in `TIMING_CHAIN_HOLDS`.

`MAILING_SCENARIOS` and `MAILING_MESSAGES` are checked with `satisfies Record<NotificationKind, …>`:
a kind without either does not compile. The tests named below by their ids are in
`packages/db/src/mailing-ops.db.test.ts` (C1–C3, M1–M6, CUT; A1–A8 for #484; R1–R8 for #576; T1–T16 for #123), `apps/backend/src/mailing/engine.db.test.ts`
(M7–M11, E1–E2, E-R1–E-R2, E-MR; the engine's own pacing is M10 there), `apps/backend/src/mailing/engine.test.ts` (M10,
the pacer alone; WP1–WP6, the wake) and `apps/backend/src/mailing/messages.test.ts`; MR1–MR9 for
#686 in `mailing-ops.db.test.ts`.

## The first-session chain

| Kind                | Sent                   | Text (`mailing` group of the catalog) | Button             |
| ------------------- | ---------------------- | ------------------------------------- | ------------------ |
| `first_session_1h`  | 1 h after the connect  | `firstSessionReminder1h`              | «🎮 Демо-торговля» |
| `first_session_24h` | 24 h after the connect | `firstSessionReminder24h`             | «🎮 Демо-торговля» |
| `first_session_72h` | 72 h after the connect | `firstSessionReminder72h`             | «🎮 Демо-торговля» |

The owner's numbers (2026-10-08): three reminders, around the clock, no quiet hours. The button is
`demoButton` with `DEMO_CALLBACK_DATA`, the bot's entry into the demo, from which the user launches
a session (#320). The texts follow the catalog's style ([bot-start.md](bot-start.md) → Style) and
promise no profit; they are overridable like every catalog text and are read when the job is sent.

- **The connect** is the starter pack's ledger row: the `token_ledger` row with `kind = 'bonus'`
  and a `broker_account_id`, which `grantLinkBonus` writes in the transaction that makes the
  account active (the bot's confirm and the email login alike). One per user
  (`token_ledger_link_bonus_user_idx`). An account that is not a partner client earns no pack,
  and so gets no chain; nor does an account connected while no `link_bonus` rule version is
  active (`no_active_rule`, [bonus-rules.md](bonus-rules.md), #13).
- **The chain applies** while the user is not blocked by the admin, trades demo
  (`users.trading_mode = 'demo'`, #121: the chain leads into the demo; a step planned before a
  switch to real is canceled at the claim), has an active account, and has no `trading_sessions`
  row of any status on any of their accounts (the owner, 2026-10-07: the chain leads to the first
  session). A session started at any moment ends it: a step already
  planned is canceled when the sender reaches it.
- **One step at a time.** A step is sent only until the next one is due; the last has no end.
  After a backend outage longer than a step, the user gets the latest step, not the missed ones
  one after another.

### Cutoff

The chain reaches only accounts connected after the engine was deployed (the owner, 2026-10-10:
no reminders for accounts connected before it). `notification_kinds` holds, per kind,
`plans_from`: the planner plans a kind only for a fact at or after it. Migration
`0040_first_session_kinds_seed.sql` seeds the three rows with `now()` — the database clock at the
moment the migration runs, the clock `token_ledger.created_at` is written by — in one statement,
so the three steps share one cutoff. A kind with no row plans nothing, so a kind added later
without its seed stays silent rather than mailing everyone's history. Tests:
`mailing-ops.db.test.ts` CUT (an account a minute before each kind's `plans_from` gets nothing,
one a minute after gets the step; no row, nothing; a fresh database holds one row per kind, at
one moment). The analysis reminder's row is seeded by `0058_analysis_unused_seed.sql` the same
way; its fact is written only by a backend that has that migration, so its cutoff is formal.
The referral reward notification's row is seeded by `0065_referral_rewarded_seed.sql`: rewards
granted before its deploy get no notification and stay visible in /invite only. The low-token
nudges' rows are seeded by `0067_tokens_nudge_kinds_seed.sql`; their fact is the planning moment,
so the row only switches them on (The low-token nudge → At the deploy). The real-mode
notification's row is seeded by `0076_real_mode_by_deposit_seed.sql`; 0075 closed every earlier
deposit as `predates`, so no switch precedes it anyway.

## The analysis reminder (#484)

| Kind              | Sent                                   | Text (`mailing` group)   | Button                                        |
| ----------------- | -------------------------------------- | ------------------------ | --------------------------------------------- |
| `analysis_unused` | 10 min after an analysis with a signal | `analysisUnusedReminder` | «📊 Анализ» (`demo:an:<assetId>:<sec>`) |

A user who opened the bot's analysis card with a signal ([bot-demo.md](bot-demo.md) → The
reminder) and within `ANALYSIS_UNUSED_AFTER_MS` (10 min) neither created a trade nor started a
session nor opened another analysis gets one reminder. The signal shown then is stale, so the
button is a fresh analysis of the same pair and duration (`demoAnalysisCallbackData`,
`packages/shared/src/bot-navigation.ts`), not a trade on the old signal. It is sent with the sound
on, as every mailing, and the text promises no result.

- **The fact** is three columns of `users`: `last_analysis_at`, `last_analysis_asset_id`,
  `last_analysis_duration_sec` (CHECK `users_last_analysis_check`: all three or none). One writer,
  `setLastAnalysis` (`packages/db/src/user-ops.ts`), called by `POST /trading/signal` when the
  request carries `analysis` — only the bot's analysis card sends it ([signal.md](signal.md) →
  POST /trading/signal): a signal writes the pair, the duration and `now()`; no signal clears all
  three, so the previous analysis' reminder is cancelled ("another analysis" holds for any
  analysis); a fetch failure or a refusal writes nothing. The cycle's doors (`demo:l`, #509) and the
  session start read the same feed without the field: they are not an analysis.
- **It applies** while the user is not blocked by the admin, trades demo (#121), has created no
  `trade_intents` row and started no `trading_sessions` row after the analysis, has no session
  that is not stopped on any account (a cycle started before the analysis and still running), and
  less than `ANALYSIS_UNUSED_UNTIL_MS` (60 min) has passed since the analysis. The bot block,
  `off` and `reduced` are the engine's own rules (Delivery rules): under `reduced` the job waits
  for the 24-hour window and is cancelled at the claim once the hour has passed.
- **One reminder per analysis.** The dedupe key is `analysis_unused:` and the epoch of
  `last_analysis_at` (microseconds, UTC whatever the session's `TimeZone`), so each analysis has
  its own key and a new analysis is a new key. The payload is the pair and the duration, which
  the message parses with `analysisUnusedPayloadSchema`; one that does not parse is `mailing not
built` (retried, then `failed`, or cancelled by the window first).
- **Timing.** The planner ticks every 60 s and the sender every 5 s, so a reminder comes 10:00 to
  about 11:05 after the analysis; `ANALYSIS_UNUSED_AFTER_MS + MAILING_PLAN_TICK_MS +
MAILING_SEND_TICK_MS < ANALYSIS_UNUSED_UNTIL_MS` is a link of `TIMING_CHAIN_HOLDS`. After a
  backend outage longer than the hour, the analyses of that time are never reminded.

What becomes of a job of this kind:

| Outcome                                                                                                       | The job                                                                    |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| the claim: it applies and the key is the current analysis'                                                    | `sent` with `outcome_unknown`, then the sender's table below               |
| the claim: another analysis, no signal (NULL fact), a trade or session, real mode, admin block, window closed | `canceled` in the same statement; its key stays taken, never planned again |
| the planner: no fact, or a fact older than the window or before `plans_from`                                  | not created                                                                |

Tests: `mailing-ops.db.test.ts` A1–A8 and CUT, `engine.db.test.ts` E1–E2, `messages.test.ts`,
`signal-routes.test.ts` R10–R17, `user-ops.db.test.ts` LA1–LA3.

## The referral reward notification (#576)

| Kind                | Sent                                        | Text (`mailing` group) | Button                             |
| ------------------- | ------------------------------------------- | ---------------------- | ---------------------------------- |
| `referral_rewarded` | at the next ticks after an inviter's reward | `referralRewarded`     | «👥 Пригласить ещё» (`cmd:invite`) |

An inviter whose invitee connected a Binodex partner account gets the reward of #116
([referrals.md](referrals.md) → The reward) and, through this kind, one message per reward: the
amount, and a button that opens /invite as a new message (`commandRetryCallbackData('invite')`,
the bot's own retry of the command). The text names the amount as «Начислено токенов за
приглашение: +N», which reads for any N without a plural form.

- **The fact** is the reward's `token_ledger` row: `referral_id` is not null, `user_id` is the
  inviter. A user may have several, so the kind's `facts` is a lateral subquery of those rows,
  each its own job. The row is append-only (rule 3) and its one writer is `grantReferralReward`
  (rule 34): the fact never goes away.
- **It applies** while the inviter is not blocked by the admin (`users.status = active`), checked
  when planning and again at the claim. The trading mode is not read: the reward is tokens, not
  the demo path. The bot block, `off` and `reduced` are the engine's own rules (Delivery rules):
  under `reduced` a second reward waits for the 24-hour window; a reward while notifications are
  `off` or the bot is blocked is planned once they are back, with no window of its own.
- **One notification per reward.** The dedupe key is `referral_rewarded:` and the ledger row's
  id; with `token_ledger_referral_idx` (one reward per referral) that is at most one notification
  per invitee. The payload is the row's `balance_delta` as text (a bigint, rule 2), which the
  message parses with `referralRewardedPayloadSchema`; one that does not parse is `mailing not
built` (retried, then `failed`). At the claim, `keyApplies` holds while the key names a reward of
  this user — always, for a key the planner wrote.
- **Timing.** `REFERRAL_REWARDED_AFTER_MS` is 0: the job is due at the reward's own moment, so the
  message comes at the planner's and the sender's next ticks, at most
  `MAILING_PLAN_TICK_MS + MAILING_SEND_TICK_MS` (65 s) after the activation commits. The kind is not
  in `MAILING_MIN_OFFSET_MS`, the earliest offset of the kinds that wait: the link
  `MAILING_PLAN_TICK_MS < MAILING_MIN_OFFSET_MS` concerns only those.

What becomes of a job of this kind:

| Outcome                                                               | The job                                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| the claim: the inviter is active and the key names their reward       | `sent` with `outcome_unknown`, then the sender's table below               |
| the claim: blocked by the admin, or the key names no reward of theirs | `canceled` in the same statement; its key stays taken, never planned again |
| the planner: bot blocked or notifications `off`                       | not created yet; planned on the first tick after they are back             |
| the planner: a reward before `plans_from`                             | never created                                                              |

Tests: `mailing-ops.db.test.ts` R1–R8 and its CUT, `engine.db.test.ts` E-R1–E-R2,
`messages.test.ts`, the pin in `timing.test.ts`.

## The real-mode notification (#686)

| Kind                   | Sent                                            | Text (`mailing` group) | Buttons                                                      |
| ---------------------- | ----------------------------------------------- | ---------------------- | ------------------------------------------------------------ |
| `real_mode_by_deposit` | right after a deposit switched the user to real | `realModeByDeposit`    | «⚙️ Режим торговли» (`mode`) \| «🏠 В меню» (`menu`), one row |

A deposit of a user in demo switches them to real
([trading-mode.md](trading-mode.md#the-automatic-switch-after-a-deposit-686)); this kind tells
them: the deposit came, the mode is REAL, trades go on real money, the stake, and the way back
(`/settings` → «⚙️ Режим торговли»). No deposit amount and no balance.

- **The fact** is a `deposit_events` row with `mode_switch = 'switched'`, at its `mode_switch_at`;
  a user may have several (back to demo, another deposit), each its own job. The outcome is written
  once, so the fact never goes away.
- **It applies** while the user is active and in real (`stillApplies`): a user who went back to
  demo before the send gets nothing. `keyApplies`: the key names a switched deposit of this user.
- **One message per switch.** The key is `real_mode_by_deposit:` and the deposit's id. The payload
  is `{ stake }`: `coalesce(users.real_stake, the account snapshot's min_trade_amount)::text`
  (rule 2), `null` without either, which the text names «минимальная ставка брокера»; a payload
  that does not parse (`realModeByDepositPayloadSchema`) is `mailing not built`. The stake is the
  planning moment's (≤ a tick after the switch); the mode screen shows the current one.
- **The user's language** (#508): the claim returns `users.language`, and the message is built
  with `clientTextsOf(language)` and `clientLabelsOf(language)` (`auth/texts.ts`; Russian with the
  staff overrides, English the static source). The English text is in `BOT_TEXT_SOURCES_EN`,
  listed in `TRANSLATED_BEFORE_633`.
- **Important** (Delivery rules): planned and claimed at any `notification_level` while the bot can
  reach the user; `off` does not cancel it; a block cancels it, and `replansCanceled` plans it
  again after the unblock while the user is still active and in real.
- **Timing.** `REAL_MODE_BY_DEPOSIT_AFTER_MS` is 0. The pass wakes the planner after the switch's
  commit (`wakePlan()`, The planner → The wake), so the job does not wait for the planner's tick;
  the sender's tick sends it (≤ `MAILING_SEND_TICK_MS` when its queue is empty).

Tests: `mailing-ops.db.test.ts` MR1–MR9 and its CUT, `delivery-ops.db.test.ts` (`reachable`,
A-win, `except`), `engine.db.test.ts` E-MR, `messages.test.ts`, `deposit-mode-switch.db.test.ts`
X1–X5.

## The low-token nudge (#123)

| Kind          | Applies when the balance is at or under | Text (`mailing` group) | Buttons                                                                  |
| ------------- | --------------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `tokens_half` | 50 % of the pack (pack 100: 50)         | `tokensHalfUsed`       | the entry: «🎮 Демо-торговля», in real mode «🚀 Торговать» (`demo`)      |
| `tokens_low`  | 20 % of the pack (pack 100: 20)         | `tokensLow`            | «💳 Пополнить» (the cashier, `web_app`), then «⭐ Купить» (`buy`) |
| `tokens_out`  | 0                                       | `tokensOut`            | the same as `tokens_low`                                                 |

The owner's answers (2026-10-08, 2026-10-10, 2026-10-18): thresholds at 50, 80 and 100 % of the
**user's own starter pack** used, each sent once per user, and at a jump across several only the
highest. The texts talk about the balance, print the threshold (`{nudgeTokens}`, «не больше 37»
needs no plural form) and imply no accuracy, learning or model (the issue's acceptance) and no
tokens for a deposit (#386 is open).

- **The measure** is the cached `users.token_balance` (rule 2: kept equal to the ledger by its
  writers) against the pack: the `balance_delta` of the user's starter-pack `token_ledger` row
  (`kind = bonus`, `broker_account_id` not null; `token_ledger_link_bonus_user_idx`, at most one;
  positive and never changed, rule 3). The comparison is bigint arithmetic in SQL,
  `balance * 100 <= pack * (100 − p)`, never a JS number. No pack (an account that is not a partner
  client, a balance of rewards or purchases only): NULL, so nothing is planned and a job is
  canceled at the claim. The payload is `{ tokens: (pack * (100 − p) / 100)::text }`, the floor of
  the same boundary (pack 75: 37, 15, 0), parsed by `tokenNudgePayloadSchema`.
- **Bands and the highest only.** A kind applies while the balance is in its band (at or under its
  threshold, above the next one) and no higher kind has a job that is not canceled. So one push
  per crossing: a user who passed 50 and 80 % between two ticks, or at the deploy, gets only the
  80 % one, and no lower one later, even when a credit lifts the balance back into a lower band.
  Two kinds planned before the send (balance falling while the first waits): the claim cancels the
  lower.
- **It applies** while the user is not blocked by the admin; checked when planning and at the
  claim. The trading mode is not read: tokens are spent in both modes. The bot block, `off` and
  `reduced` are the engine's own rules.
- **A canceled job comes back** (`replansCanceled`): a nudge canceled because a credit lifted the
  balance before the send is planned again, with the new payload and `scheduled_at`, once the
  balance is back in its band. Only `canceled`: `sent` and `failed` are final, `pending` already
  waits.
- **At the deploy** every user already in a band gets one push, the highest band reached: the
  fact is the planning moment, so `plans_from` only switches the kinds on.
- **The buttons.** The entry button (50 %, and in the cashier's place when `cashierUrlOf` returns
  undefined because `WEB_PUBLIC_URL` is not https) is labelled by the user's mode read at the claim,
  as the status card labels it (#121): the path is the same `DEMO_CALLBACK_DATA` (#327). 80 % and
  100 % carry the cashier of #27 in row 1 and the purchase of #117 in row 2. The 50 % text names no
  button («нажми кнопку ниже»); the 80/100 % texts name only «⭐ Купить», the row that is
  always there.
- **Timing.** `TOKEN_NUDGE_AFTER_MS` is 0, like `REFERRAL_REWARDED_AFTER_MS`: due at the planning
  moment, out of `MAILING_MIN_OFFSET_MS`.

Out of scope: a repeat after a purchase or any later credit (each threshold is once per user,
owner 2026-10-18); English texts (#633).

Tests: `mailing-ops.db.test.ts` T1–T16 and its CUT, `engine.db.test.ts` (the 80/100 % sends with
their keyboard, a jump 51 → 0, cancel → re-plan → one send), `messages.test.ts`, the pin in
`timing.test.ts`.

## The planner

Every `MAILING_PLAN_TICK_MS` (60 s, shorter than the earliest offset of the kinds that wait, `MAILING_MIN_OFFSET_MS`) the planner runs one
`INSERT … SELECT … ON CONFLICT (user_id, dedupe_key) DO NOTHING` per kind (`DO UPDATE … WHERE
status = 'canceled'` for a kind with `replansCanceled`, The low-token nudge): a job for every user
whose fact plus the offset has come, whose fact is at or after the kind's `plans_from`, whom the
bot may reach (`deliverable()`: not blocked in Telegram, notifications not `off`; an important
kind: `reachable()`, not blocked in Telegram, #686), and for whom the
scenario applies — one job per row of the kind's `facts` (`cross join lateral`). `scheduled_at` is
the fact plus the offset, and `payload` the scenario's. The dedupe key (`first_session:1h`,
`…:24h`, `…:72h`; `analysis_unused:<epoch>`; `referral_rewarded:<ledger row id>`;
`tokens:50`, `tokens:80`, `tokens:100`; `real_mode_by_deposit:<deposit id>`) makes it idempotent: a second run, a second backend process or a restart
inserts nothing twice (M1, M2), and a canceled job keeps its key, so a step canceled by `off` is
not planned again — except a low-token nudge's, which is taken back once it applies again (T7).

The planner reads facts; no trading or linking path writes a mailing.

**The wake (#686).** `wakePlan()` runs a pass now, or one more right after the pass in flight; wakes
during a pass merge into one more pass (a counter reset before the pass's first statement, so a
wake that came before it is served by that pass), and after `stop()` it does nothing — the repeat
goes through `planTick()`, which checks `stopped`. A plain `planTick()` would join the pass in
flight, which may have read past the commit; its fact would then wait for the timer. The one
caller is the deposit pass after a switch; the timer stays the fallback. A wake during the pass
that `stop()` ends gives no repeat. Tests: `engine.test.ts` WP1–WP6, `deposit-mode-switch.db.test.ts`
X5.

## The sender

Every `MAILING_SEND_TICK_MS` (5 s) the sender takes up to `MAILING_SEND_BATCH` (100) jobs, one at
a time, each by one statement (`claimMailingJob`):

1. among the `MAILING_CLAIM_SCAN` (50) earliest `pending` jobs that are due, of users that
   `acceptsMailing()` admits now (an important kind's: `reachable()`, #686), locked `FOR UPDATE … SKIP LOCKED` (a second process skips them);
2. those whose scenario no longer applies, or whose dedupe key is not the one the scenario would
   plan now (a newer fact: another analysis), become `canceled`; a predicate that is NULL (the
   fact gone) counts as not applying (`coalesce(…, false)`), so such a job never sits at the head
   of the scan neither cancelled nor claimed (A5);
3. the earliest one that applies becomes `sent`, with `sent_at = now()` and
   `last_error = 'outcome_unknown'`, before anything reaches Telegram.

Then it sends through the client push and writes the outcome:

| Outcome                                              | The job                                                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Telegram accepted                                    | `sent`, `last_error` cleared                                                                                          |
| 403                                                  | `failed`, attempt counted; `recordTelegramSendFailure` marks the user unreachable and cancels their pending jobs (M7) |
| 429                                                  | `pending` again after `retry_after`, no attempt counted; the sender pauses for `retry_after` (M8)                     |
| another refusal (4xx), or a text that fails to build | `pending` again after `MAILING_RETRY_MS` (5 min), attempt counted; `failed` at `MAILING_MAX_ATTEMPTS` (3)             |
| no answer (a timeout, a transport error), a 5xx      | left `sent` with `outcome_unknown`: never sent again (M9); the batch goes on (Accepted risks)                         |
| the process died after the claim                     | the same: `sent` with `outcome_unknown`, never sent again (M11)                                                       |

Such a send may have been delivered: a lost reminder is preferred to a duplicate. An unknown
answer does not stop the batch, so an outage loses every job claimed while it lasts (Accepted
risks). `last_error` holds a name and a code only (`GrammyError:403`, rule 8); the log line has the
job's id, its kind and the error's identity. Each tick that claimed or canceled anything logs `mailing tick` with a count per answer:
`delivered`, `refused` (403), `deferred` (429), `retry` (another refusal, a text that failed to
build), `unknown` (no answer, a 5xx) and `canceled` (claim-time cancels); only `delivered` is
known to have reached a user.

If writing the outcome fails, the job stays as the claim left it, `sent` with `outcome_unknown`,
and is never sent again; the failure is logged by name and code (`mailing not settled`). What
Telegram's answer asks of the sender still happens: the pause after a 429, the unreachable mark
after a 403 (`engine.db.test.ts` → a settle that fails).

**Rate.** One pacer for every kind spaces the sends `1000 / MAILING_SEND_PER_SECOND` ms apart:
20 a second, under Telegram's limit of about 30 a second for one bot's messages to different
users (stated, not measured; M10); the session notices' 9 a second (#464,
[bot-session.md](bot-session.md#rate-and-timing)) come on top, and the two together stay under it. A batch at that rate takes its tick exactly (100 × 50 ms = 5 s,
`TIMING_CHAIN_HOLDS` holds with equality, no headroom), so the claims and sends push a full batch
past it; the tick that overlaps it is a no-op. The gaps and Telegram's pause run on a monotonic clock
(`performance.now`): a wall-clock step neither stretches nor cuts them.

**Stop.** `stop()` ends both loops and waits for what is in flight: the planner's tick (one
statement per kind), and the sender's current step — the pace's gap (`1000 / MAILING_SEND_PER_SECOND`,
50 ms) if it is sleeping, after which nothing more is claimed, or a job already taken: the claim, the
one send (`CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS`, 3 s), the settle and, after a 403, the unreachable
mark. The gap plus the send sit inside shutdown phase 1
(`TIMING_CHAIN_HOLDS`); the statements are ordinary latency, as phase 1 counts every statement, and
a database that times out each of them (the pool's `query_timeout`) can push the stop past phase 1
into `exit(1)`. Nothing is sent twice either way: the claim has already marked the job `sent`. The
jobs not yet claimed stay `pending` for the next start (M11).

## Delivery rules

For an ordinary kind only `acceptsMailing()` decides (rule 19): `off` sends nothing, and `setNotificationLevel('off')`
cancels what is pending; `reduced` sends at most one mailing per `REDUCED_LEVEL_WINDOW_HOURS`
(24 h, counted from `sent_at`, M5) — the job waits, it is not dropped; a user marked unreachable
(`telegram_blocked_at`) gets nothing, and `markTelegramBlocked` cancels what is pending (M6). The
mailings' own `sent` rows are what the `reduced` window reads.

**Important kinds** (#686; today `real_mode_by_deposit`, `important: true` in its scenario,
`IMPORTANT_NOTIFICATION_KINDS`): a message about the user's money that the level does not hold.
The planner and the claim take `reachable()` (`telegram_blocked_at is null`) for them instead of
`deliverable()`/`acceptsMailing()`; their `sent` rows do not count in the `reduced` window; and
`setNotificationLevel('off')` cancels everything pending but them
(`cancelPendingNotificationJobs(tx, userId, { except: IMPORTANT_NOTIFICATION_KINDS })`).
`markTelegramBlocked` cancels them too.

Lock order: every statement here is one autocommit statement on `Db`. The sender locks
`notification_jobs` rows only, never `users`, so `cancelPendingNotificationJobs`' order
(`users → notification_jobs`) never meets its reverse (rule 5).

## Adding a scenario

1. A kind in `NotificationKind`; `pnpm db:generate --name <kind>` regenerates the CHECKs.
2. A custom migration (`pnpm db:generate --custom --name <kind>_seed`) that inserts its
   `notification_kinds` row with `now()`, so it reaches only facts from its deploy on — or an
   explicit earlier `plans_from` if the owner wants history mailed.
3. Its entry in `MAILING_SCENARIOS` and in `MAILING_MESSAGES` (the text from the catalog's
   `mailing` group, the keyboard, from the payload). A kind with one fact per user goes through
   `oneFact` (the fact's moment as SQL over the user's row, the offset in ms, the dedupe key over
   the user's row, the payload if the message needs data, the predicate): the claim cancels a job
   whose key the scenario would not plan now, so a key that changes with the fact makes the
   newest fact win; a constant key is always current. A kind with several facts per user (#576)
   gives `facts` as a lateral subquery, reads its key and payload from `fact.<column>`, and gives
   `keyApplies`, the claim's predicate over the user's row and the job that the key is still one
   it would plan. `replansCanceled: true` when a job canceled because the condition stopped holding
   should come back once it holds again (#123); without it a canceled key is never planned again.
   `important: true` only for a message the notification level must not hold (#686, Delivery
   rules → Important kinds).
4. A link in `TIMING_CHAIN_HOLDS` only for a kind that waits: its offset counts in
   `MAILING_MIN_OFFSET_MS`, which the planner's tick must stay under; a kind due at its fact (0)
   is left out of it.
5. Tests in `mailing-ops.db.test.ts` for its planning and stop conditions.

## Accepted risks

- During a deploy with two backend processes the two senders together may exceed the rate, and
  two claims of one `reduced` user at the same instant can both pass the window
  (`acceptsMailing()`'s comment). The first-session chain has one step applicable at a time, so
  it cannot meet the second.
- An opt-out (`setNotificationLevel('off')`) or a block (`markTelegramBlocked`) that commits
  after a claim's snapshot does not stop that claim: one message can still go out milliseconds
  after it, never two — the claimed job is already `sent`, so the cancel passes it by. Closing
  the gap would mean locking `users` in the claim, against the lock order above (rule 5).
- A send whose outcome is unknown — no answer from Telegram (grammY's `HttpError`: a timeout, DNS,
  a refused connection) or a 5xx — neither ends the batch nor pauses the sender (the owner's
  decision of 2026-10-10). During a Telegram outage every job claimed while it lasts is marked
  `sent` with `outcome_unknown` and never sent again: up to `MAILING_SEND_BATCH` (100) jobs a tick,
  every `MAILING_SEND_TICK_MS` (5 s), for as long as the outage lasts, so a few seconds can cost the
  whole due backlog, right after a restart included. Nothing is ever sent twice. To see it: the
  `mailing tick` lines' `unknown` count, the `mailing not delivered` warnings with a
  `transportError` or a 5xx `telegramErrorCode`, and
  `select count(*) from notification_jobs where status = 'sent' and last_error = 'outcome_unknown'`.
- An account that is not a partner client gets no starter pack and therefore no chain; the same
  holds for one connected while no `link_bonus` rule version is active (#13).
- The last step has no end: a user who is unreachable or `off` at 72 h and comes back later gets
  it then, if they still have no session.
- The analysis reminder (#484): "after the analysis" compares `created_at`/`started_at` with
  `last_analysis_at` on the database clock, so a trade whose transaction started before the
  analysis was written (a second device in the same second) does not count, and the reminder goes
  out anyway. Two analyses of one user in the same microsecond would share a key; they are two
  sequential writes of one row.
- The payload is the analysis as planned: a new analysis between the claim and the send does not
  stop the claimed job (milliseconds, the same gap as an opt-out after a claim).
- The record is best-effort: a failed write of the fact is a `warn` (`last analysis not
recorded`) and the analysis is answered; there is then no reminder. The write runs after the
  feed's budget, so a slow database can make the bot's request time out while the fact is
  written: a reminder of a card the user did not see, whose button is a fresh analysis.
- There is no daily cap: a user who keeps opening analyses without trading gets at most one
  reminder per 10 minutes of inaction, each new analysis moving the deadline; `reduced` limits it
  to one a day.
- The low-token nudge (#123): a rollback to an image before 0066/0067 cannot plan the kinds, and
  its claim's `case` has no branch for them, so a pending `tokens_*` job is canceled by the old
  sender; after the re-deploy the planner takes it back (`replansCanceled`).
- A Stars refund (#118) or an admin adjustment (#246) can move a user into a band without a trade;
  the text names the balance, so it stays true.
- No repeat after a purchase or a reward: a user who refills and spends again gets no second push
  for a threshold already sent (owner 2026-10-18).
