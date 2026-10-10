# Mailing engine (#202)

What the bot sends a user who did not ask for it — a reminder, a nudge — goes through one engine
in the backend process. A mailing is a row of `notification_jobs`; the engine plans the rows from
facts already in the database and sends the due ones through the client push, the backend's one
send seam for user texts ([bot-start.md](bot-start.md) → Two seams).

Today it carries one scenario, the **first-session chain**: three reminders that lead a user who
connected an account but has not started a trading session into the demo. #123 (the low-token
nudge) and #124 (retention) add their scenarios to the same engine.

```bash
pnpm test --project unit apps/backend/src/mailing apps/backend/src/auth/client-push.test.ts   # no database or Redis
pnpm test --project integration packages/db/src/mailing-ops.db.test.ts apps/backend/src/mailing   # TEST_DATABASE_URL (README → Test database)
```

## Files

- `packages/shared/src/mailing.ts` — `NotificationKind` (the kinds, and the CHECK on
  `notification_jobs.kind` and `notification_kinds.kind`) and `FIRST_SESSION_CHAIN` (the steps and
  their offsets).
- `packages/db/src/mailing-scenarios.ts` — `MAILING_SCENARIOS`: per kind, the fact it counts
  from, the offset, the dedupe key and the predicate it holds while it applies.
- `packages/db/src/mailing-ops.ts` — the statements: `planMailingJobs`, `claimMailingJob`,
  `settleMailingJob`.
- `apps/backend/src/mailing/messages.ts` — `MAILING_MESSAGES`: per kind, the text and the keyboard.
- `apps/backend/src/mailing/engine.ts` — the two loops, the pacer and the failure policy;
  `apps/backend/src/auth/client-push.ts` — `sendMailing`, beside the link push.
- `apps/backend/src/timing.ts` — the `MAILING_*` numbers and their links in `TIMING_CHAIN_HOLDS`.

`MAILING_SCENARIOS` and `MAILING_MESSAGES` are checked with `satisfies Record<NotificationKind, …>`:
a kind without either does not compile. The tests named below by their ids are in
`packages/db/src/mailing-ops.db.test.ts` (C1–C3, M1–M6, CUT), `apps/backend/src/mailing/engine.db.test.ts`
(M7–M9, M11) and `apps/backend/src/mailing/engine.test.ts` (M10).

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
one a minute after gets the step; no row, nothing; a fresh database holds one row per kind, at
one moment).

## The planner

Every `MAILING_PLAN_TICK_MS` (60 s, shorter than the earliest step) the planner runs one
`INSERT … SELECT … ON CONFLICT (user_id, dedupe_key) DO NOTHING` per kind: a job for every user
whose fact plus the offset has come, whose fact is at or after the kind's `plans_from`, whom the
bot may reach (`deliverable()`: not blocked in Telegram, notifications not `off`), and for whom the
scenario applies. `scheduled_at` is the fact plus the offset. The dedupe key (`first_session:1h`,
`…:24h`, `…:72h`) makes it idempotent: a second run, a second backend process or a restart
inserts nothing twice (M1, M2), and a canceled job keeps its key, so a step canceled by `off` is
not planned again.

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

| Outcome                                        | The job                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Telegram accepted                              | `sent`, `last_error` cleared                                                                                          |
| 403                                            | `failed`, attempt counted; `recordTelegramSendFailure` marks the user unreachable and cancels their pending jobs (M7) |
| 429                                            | `pending` again after `retry_after`, no attempt counted; the sender pauses for `retry_after` (M8)                     |
| another refusal, or a text that fails to build | `pending` again after `MAILING_RETRY_MS` (5 min), attempt counted; `failed` at `MAILING_MAX_ATTEMPTS` (3)             |
| no answer (a timeout, a transport error)       | left `sent` with `outcome_unknown`: it may have been delivered, so it is never sent again (M9)                        |
| the process died after the claim               | the same: `sent` with `outcome_unknown`, never sent again (M11)                                                       |

A lost reminder is preferred to a duplicate. `last_error` holds a name and a code only
(`GrammyError:403`, rule 8); the log line has the job's id, its kind and the error's identity.

**Rate.** One pacer for every kind spaces the sends `1000 / MAILING_SEND_PER_SECOND` ms apart:
20 a second, under Telegram's limit of about 30 a second for one bot's messages to different
users (stated, not measured; M10). A batch at that rate fits its tick, so a tick never overlaps the
next (`TIMING_CHAIN_HOLDS`).

**Stop.** `stop()` ends both loops and waits for the statement or the one send in flight, which
`CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS` (3 s) bounds inside shutdown phase 1. The jobs not yet claimed
stay `pending` for the next start.

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
3. Its entry in `MAILING_SCENARIOS` (the fact, the offset, the dedupe key, the predicate) and in
   `MAILING_MESSAGES` (the text from the catalog's `mailing` group, the keyboard).
4. Tests in `mailing-ops.db.test.ts` for its planning and stop conditions.

## Accepted risks

- During a deploy with two backend processes the two senders together may exceed the rate, and
  two claims of one `reduced` user at the same instant can both pass the window
  (`acceptsMailing()`'s comment). The first-session chain has one step applicable at a time, so
  it cannot meet the second.
- An account that is not a partner client gets no starter pack and therefore no chain.
- The last step has no end: a user who is unreachable or `off` at 72 h and comes back later gets
  it then, if they still have no session.
