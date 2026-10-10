# Mailing engine (#202)

What the bot sends a user who did not ask for it — a reminder, a nudge — goes through one engine
in the backend process. A mailing is a row of `notification_jobs`; the engine plans the rows from
facts already in the database and sends the due ones through the client push, the backend's one
send seam for user texts ([bot-start.md](bot-start.md) → Two seams).

It carries two scenarios: the **first-session chain**, three reminders that lead a user who
connected an account but has not started a trading session into the demo, and the **low-token
nudge** (#123), one push as the user's starter pack runs down. #124 (retention) adds its scenarios
to the same engine.

```bash
pnpm test --project unit apps/backend/src/mailing apps/backend/src/auth/client-push.test.ts   # no database or Redis
pnpm test --project integration packages/db/src/mailing-ops.db.test.ts apps/backend/src/mailing   # TEST_DATABASE_URL (README → Test database)
```

## Files

- `packages/shared/src/mailing.ts` — `NotificationKind` (the kinds, and the CHECK on
  `notification_jobs.kind` and `notification_kinds.kind`), `FIRST_SESSION_CHAIN` (the steps and
  their offsets) and `TOKEN_NUDGES` (the thresholds).
- `packages/db/src/mailing-scenarios.ts` — `MAILING_SCENARIOS`: per kind, the fact it counts
  from, the offset, the dedupe key, the predicate it holds while it applies and whether a canceled
  job is planned again.
- `packages/db/src/mailing-ops.ts` — the statements: `planMailingJobs`, `claimMailingJob`,
  `settleMailingJob`.
- `apps/backend/src/mailing/messages.ts` — `MAILING_MESSAGES`: per kind, the text; the keyboard is
  the demo button (`demoKeyboard`, `client-push.ts`), the same as the link push's re-login.
- `apps/backend/src/mailing/engine.ts` — the two loops, the pacer and the failure policy;
  `apps/backend/src/auth/client-push.ts` — `sendMailing`, beside the link push.
- `apps/backend/src/timing.ts` — the `MAILING_*` numbers and their links in `TIMING_CHAIN_HOLDS`.

`MAILING_SCENARIOS` and `MAILING_MESSAGES` are checked with `satisfies Record<NotificationKind, …>`:
a kind without either does not compile. The tests named below by their ids are in
`packages/db/src/mailing-ops.db.test.ts` (C1–C3, M1–M6, CUT), `apps/backend/src/mailing/engine.db.test.ts`
(M7–M11; the engine's own pacing is M10 there) and `apps/backend/src/mailing/engine.test.ts` (M10,
the pacer alone); the low-token nudge's are T1–T12 and its CUT in `mailing-ops.db.test.ts`.

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
  and so gets no chain.
- **The chain applies** while the user is not blocked by the admin, has an active account, and
  has no `trading_sessions` row of any status on any of their accounts (the owner, 2026-10-07: the
  chain leads to the first session). A session started at any moment ends it: a step already
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
one a minute after gets the step; no row, nothing; a fresh database holds one row per kind, the
chain's at one moment).

## The low-token nudge

| Kind          | Used of the starter pack | Balance (`users.token_balance`) | Text (`mailing` group) | Button             |
| ------------- | ------------------------ | ------------------------------- | ---------------------- | ------------------ |
| `tokens_half` | 50 %                     | 21–50                           | `tokensHalfUsed`       | «🎮 Демо-торговля» |
| `tokens_low`  | 80 %                     | 1–20                            | `tokensLow`            | «🎮 Демо-торговля» |
| `tokens_out`  | 100 %                    | 0                               | `tokensOut`            | «🎮 Демо-торговля» |

The owner's numbers (2026-10-08): 50, 80 and 100 % of the starter pack, each once per user, no
quiet hours. The texts say how many tokens are left and claim no accuracy, learning or model (the
issue's acceptance; `messages.test.ts` checks the words and that each text's number is its
threshold's balance).

**The button.** All three carry the demo button — the owner's decision of 2026-10-10, including at
100 %, where the user has no token for a trade: every client message carries a next step (rule 31)
and the deposit button does not exist yet. #27 (the deposit CTA) replaces the 80 % and 100 %
buttons with «💳 Пополнить»; until then the texts promise no way to top up.

- **The measure** is the cached balance (rule 2: equal to the ledger by its writers) against the
  starter pack, `LINK_BONUS_TOKENS` (100): a threshold is reached once
  `token_balance * 100 <= LINK_BONUS_TOKENS * (100 - used %)`. The starter pack is the only pack
  (one per user, `token_ledger_link_bonus_user_idx`), and a manual adjustment (#246) moves the
  balance like any writer. What a pack is after buying tokens is #117's to decide; until then each
  push is once per user, by its dedupe key (`tokens:50`, `tokens:80`, `tokens:100`).
- **It applies** to a user who received the starter pack and is not blocked by the admin, while
  the balance is in the kind's band, and while no higher kind has a job that is not canceled
  (`pending`, `sent` or `failed`).
- **The highest only** (the owner, 2026-10-10). A balance is in one band at most, so a user who
  passes several thresholds at once — at the deploy, or between two planner ticks (51 → 0) — is
  planned the highest one only. A lower kind does not apply while a higher one has a job that is
  not canceled, so it is not sent later either, even when an adjustment lifts the balance back into
  its band (T2, T5, T9); a canceled higher job bars nothing (T8, the owner, 2026-10-10). Two
  kinds planned by the two statements of one tick (the balance crossed a threshold between them)
  are settled by the claim: the lower one no longer applies and is canceled (T4).
- **At the deploy.** The fact a nudge counts from is the planning moment (`now()`), not a past
  event, so `notification_kinds.plans_from` only switches these kinds on: a user already past a
  threshold when the engine first plans them gets one push, for the highest threshold reached (the
  owner, 2026-10-10; T2). Migration `0042_tokens_nudge_kinds_seed.sql` seeds the three rows.
- **A top-up before the send** (a balance back over the threshold) cancels the planned job at the
  claim (T6). `scheduled_at` is the planning moment.
- **A canceled nudge is planned again** (the owner, 2026-10-10): once the scenario applies again —
  the balance back in the band, the user reachable — the planner turns the canceled job of that
  key back to `pending` with a new `scheduled_at` (`replansCanceled`), and it is sent once (T7).
  Only a canceled job comes back: it never reached Telegram, since only `pending` jobs are
  canceled, while `sent` and `failed` are final (T10). A user who is `off` or blocked the bot is
  not planned (T11); one who turns mailing back on while the balance is still in the band gets the
  push then, as one who never had a job would. The first-session chain keeps a canceled step
  canceled (T12).

## The planner

Every `MAILING_PLAN_TICK_MS` (60 s, shorter than the earliest step) the planner runs one
`INSERT … SELECT … ON CONFLICT (user_id, dedupe_key) DO NOTHING` per kind: a job for every user
whose fact plus the offset has come, whose fact is at or after the kind's `plans_from`, whom the
bot may reach (`deliverable()`: not blocked in Telegram, notifications not `off`), and for whom the
scenario applies. `scheduled_at` is the fact plus the offset. The dedupe key (`first_session:1h`,
`…:24h`, `…:72h`) makes it idempotent: a second run, a second backend process or a restart
inserts nothing twice (M1, M2), and a canceled job keeps its key, so a step canceled by `off` is
not planned again. The low-token nudge's kinds are the exception: their conflict clause is
`DO UPDATE … WHERE status = 'canceled'`, which plans a canceled job again (The low-token nudge).

The planner reads facts; no trading or linking path writes a mailing.

## The sender

Every `MAILING_SEND_TICK_MS` (5 s) the sender takes up to `MAILING_SEND_BATCH` (100) jobs, one at
a time, each by one statement (`claimMailingJob`):

1. among the `MAILING_CLAIM_SCAN` (50) earliest `pending` jobs that are due, of users that
   `acceptsMailing()` admits now, locked `FOR UPDATE … SKIP LOCKED` (a second process skips them);
2. those whose scenario no longer applies become `canceled`;
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
users (stated, not measured; M10). A batch at that rate takes its tick exactly (100 × 50 ms = 5 s,
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

Only `acceptsMailing()` decides (rule 19): `off` sends nothing, and `setNotificationLevel('off')`
cancels what is pending; `reduced` sends at most one mailing per `REDUCED_LEVEL_WINDOW_HOURS`
(24 h, counted from `sent_at`, M5) — the job waits, it is not dropped; a user marked unreachable
(`telegram_blocked_at`) gets nothing, and `markTelegramBlocked` cancels what is pending (M6). The
mailings' own `sent` rows are what the `reduced` window reads.

Lock order: every statement here is one autocommit statement on `Db`. The sender locks
`notification_jobs` rows only, never `users`, so `cancelPendingNotificationJobs`' order
(`users → notification_jobs`) never meets its reverse (rule 5).

## Adding a scenario

1. A kind in `NotificationKind`; `pnpm db:generate --name <kind>` regenerates the CHECKs.
2. A custom migration (`pnpm db:generate --custom --name <kind>_seed`) that inserts its
   `notification_kinds` row with `now()`, so it reaches only facts from its deploy on — or an
   explicit earlier `plans_from` if the owner wants history mailed.
3. Its entry in `MAILING_SCENARIOS` (the fact, the offset, the dedupe key, the predicate, whether
   a canceled job is planned again) and in
   `MAILING_MESSAGES` (the text from the catalog's `mailing` group, the keyboard).
4. Tests in `mailing-ops.db.test.ts` for its planning and stop conditions.

## Accepted risks

- During a deploy with two backend processes the two senders together may exceed the rate, and
  two claims of one `reduced` user at the same instant can both pass the window
  (`acceptsMailing()`'s comment). The first-session chain and the low-token nudge each have one
  kind applicable at a time, so only a `reduced` user with a chain step and a nudge due together
  can meet the second, during such a deploy.
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
- A backend rolled back to an image older than migrations 0041/0042 does not know the `tokens_*`
  kinds: its claim finds no scenario for them and cancels every due one it scans, up to
  `MAILING_CLAIM_SCAN` (50) a tick. The deploy itself does not do this (compose replaces the backend
  without overlap); only a rollback does. After the re-deploy the planner plans the canceled nudges
  again for the users still in their band.
- An account that is not a partner client gets no starter pack and therefore no chain.
- The last step has no end: a user who is unreachable or `off` at 72 h and comes back later gets
  it then, if they still have no session.
