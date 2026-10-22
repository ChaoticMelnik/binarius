import { sql, type Column, type SQL } from 'drizzle-orm';
import {
  ANALYSIS_UNUSED_AFTER_MS,
  ANALYSIS_UNUSED_UNTIL_MS,
  BrokerAccountStatus,
  DepositModeSwitch,
  FIRST_SESSION_CHAIN,
  NotificationKind,
  REAL_MODE_BY_DEPOSIT_AFTER_MS,
  realModeByDepositPayloadSchema,
  REFERRAL_REWARDED_AFTER_MS,
  TOKEN_NUDGE_AFTER_MS,
  TOKEN_NUDGES,
  TokenLedgerKind,
  TradeMode,
  TradingSessionStatus,
  UserStatus,
} from '@binarius/shared';
import { literal } from './schema/columns';
import { brokerAccounts } from './schema/broker-accounts';
import { brokerBalanceSnapshots } from './schema/broker-balance-snapshots';
import { depositEvents } from './schema/deposit-events';
import { NotificationJobStatus, notificationJobs } from './schema/notification-jobs';
import { tokenLedger } from './schema/token-ledger';
import { tradeIntents } from './schema/trade-intents';
import { tradingSessions } from './schema/trading-sessions';
import { users } from './schema/users';

// What the planner and the sender know about a kind (docs/mailing.md). Every SQL fragment reads
// the outer `users` row and locks nothing.
export interface MailingScenario {
  // the user's facts the kind counts from: a lateral subquery over `users` with a column `at`
  // (the fact's moment; no row, or a NULL `at`, plans nothing) and whatever dedupeKey and payload
  // read as fact.<column>
  facts: SQL;
  afterMs: number;
  // over `users` and `fact`: one job per user per key (notification_jobs_dedupe_key_idx), so
  // planning is idempotent
  dedupeKey: SQL;
  // over `users` and `fact`: the job's payload (jsonb), what the message is built from; '{}' when
  // absent
  payload?: SQL;
  // over `users` only: checked when planning and again when the sender claims; false at the claim
  // cancels the job
  stillApplies: SQL;
  // at the claim, over `users` and `notification_jobs`: the job's key is one the scenario would
  // plan now, so a job whose fact was replaced (a newer analysis) is cancelled
  keyApplies: SQL;
  // the planner turns a canceled job of the key back to pending, with the new payload, once the
  // scenario applies again; without it a canceled job keeps its key and the kind is never planned
  // again for the user
  replansCanceled?: boolean;
  // An important kind (#686) is planned and claimed for any notification_level, while the bot can
  // reach the user (reachable(), not deliverable()); its `sent` rows do not count in the `reduced`
  // window, and setNotificationLevel('off') does not cancel its jobs. markTelegramBlocked does.
  important?: true;
}

// A kind with at most one fact per user: its key reads `users` only, so the claim compares it
// directly.
const oneFact = ({
  factAt,
  dedupeKey,
  ...rest
}: {
  factAt: SQL;
  afterMs: number;
  dedupeKey: SQL;
  payload?: SQL;
  stillApplies: SQL;
  replansCanceled?: boolean;
}): MailingScenario => ({
  facts: sql`(select ${factAt} as at)`,
  dedupeKey,
  keyApplies: sql`${notificationJobs.dedupeKey} = ${dedupeKey}`,
  ...rest,
});

// A column of the user's starter pack: the ledger row written in the activation transaction
// (grantLinkBonus). The predicate is token_ledger_link_bonus_user_idx's, so there is at most one
// row; an account connected with no active link_bonus rule has none, and so no chain and no
// low-token nudge (#13, #123).
const starterPack = (column: Column) =>
  sql`(select ${column} from ${tokenLedger}
  where ${tokenLedger.userId} = ${users.id}
    and ${tokenLedger.kind} = ${literal(TokenLedgerKind.Bonus)}
    and ${tokenLedger.brokerAccountId} is not null)`;

// The moment the account was connected.
const linkedAt = starterPack(tokenLedger.createdAt);

// The user can still act on the button: not blocked by the admin, an active account, and no
// trading session of any status on any of their accounts (owner, 2026-10-07: the chain leads to
// the first session, so any session ends it), and the user trades demo: the chain leads into the
// demo, so a user in real mode gets none, and a step planned before the switch is cancelled at the
// claim (#121).
const beforeFirstSession = sql`(${users.status} = ${literal(UserStatus.Active)}
  and ${users.tradingMode} = ${literal(TradeMode.Demo)}
  and exists (select 1 from ${brokerAccounts}
    where ${brokerAccounts.userId} = ${users.id}
      and ${brokerAccounts.status} = ${literal(BrokerAccountStatus.Active)})
  and not exists (select 1 from ${tradingSessions}
    join ${brokerAccounts} on ${brokerAccounts.id} = ${tradingSessions.brokerAccountId}
    where ${brokerAccounts.userId} = ${users.id}))`;

// A step is stale once the next one is due: after a backend outage the user gets the latest step,
// not the backlog of them one after another.
const firstSessionStep = (kind: NotificationKind): MailingScenario => {
  const index = FIRST_SESSION_CHAIN.findIndex((step) => step.kind === kind);
  const step = FIRST_SESSION_CHAIN[index];
  if (step === undefined) throw new Error(`${kind} is not a step of FIRST_SESSION_CHAIN`);
  const next = FIRST_SESSION_CHAIN[index + 1];
  return oneFact({
    factAt: linkedAt,
    afterMs: step.afterHours * 3_600_000,
    dedupeKey: sql`${`first_session:${String(step.afterHours)}h`}`,
    stillApplies:
      next === undefined
        ? beforeFirstSession
        : sql`(${beforeFirstSession} and ${linkedAt} + make_interval(hours => ${next.afterHours}) > now())`,
  });
};

const lastAnalysisAt = sql`${users.lastAnalysisAt}`;

// The analysis reminder (#484, docs/mailing.md → The analysis reminder): the user, not blocked by
// the admin and trading demo, has created no trade and started no session since the analysis, runs
// no session now, and the reminder's window has not closed. Another analysis is a new fact and so a
// new key: the job of the previous one is cancelled at the claim by the key, not here.
const analysisUnused = sql`(${users.status} = ${literal(UserStatus.Active)}
  and ${users.tradingMode} = ${literal(TradeMode.Demo)}
  and now() < ${lastAnalysisAt} + make_interval(secs => ${ANALYSIS_UNUSED_UNTIL_MS / 1000})
  and not exists (select 1 from ${tradeIntents}
    where ${tradeIntents.userId} = ${users.id}
      and ${tradeIntents.createdAt} > ${lastAnalysisAt})
  and not exists (select 1 from ${tradingSessions}
    join ${brokerAccounts} on ${brokerAccounts.id} = ${tradingSessions.brokerAccountId}
    where ${brokerAccounts.userId} = ${users.id}
      and (${tradingSessions.startedAt} > ${lastAnalysisAt}
        or ${tradingSessions.status} <> ${literal(TradingSessionStatus.Stopped)})))`;

// The inviter's rewards (#116): one row per reward of the user, each its own job (#576,
// docs/mailing.md → The referral reward notification). The key names the ledger row, the payload
// carries its tokens as text (a bigint, rule 2). token_ledger is append-only, so a reward never
// goes away; the claim re-checks only the admin block and that the key names a reward of this user.
const rewardRows = sql`(select ${tokenLedger.createdAt} as at, ${tokenLedger.id} as reward_id,
    ${tokenLedger.balanceDelta}::text as tokens
  from ${tokenLedger}
  where ${tokenLedger.userId} = ${users.id} and ${tokenLedger.referralId} is not null)`;

// The pack's tokens: the rule version's amount when the account was connected, positive
// (token_ledger_kind_check) and never changed (append-only, rule 3).
const packTokens = starterPack(tokenLedger.balanceDelta);

// The threshold's share of the pack, inlined as integers: bigint arithmetic, no JS number (rule 2).
const leftPercent = (usedPercent: number) => sql.raw(String(100 - usedPercent));

// The cached balance (rule 2) is at or under the threshold's share of the user's own pack. No
// pack: NULL, which plans nothing and cancels at the claim.
const tokensReached = (usedPercent: number) =>
  sql`${users.tokenBalance} * 100 <= ${packTokens} * ${leftPercent(usedPercent)}`;

// The low-token nudge (#123, docs/mailing.md → The low-token nudge). A kind's band ends where the
// next threshold's begins, and a kind does not apply while a higher one has a job that is not
// canceled, so a user who passes several thresholds at once gets the highest only, and none lower
// afterwards. The fact is the planning moment, so plans_from only switches the kinds on. A canceled
// job is planned again once the balance is back in its band. trading_mode is not read: tokens are
// spent in both modes.
const tokenNudge = (kind: NotificationKind): MailingScenario => {
  const index = TOKEN_NUDGES.findIndex((nudge) => nudge.kind === kind);
  const nudge = TOKEN_NUDGES[index];
  if (nudge === undefined) throw new Error(`${kind} is not one of TOKEN_NUDGES`);
  const higher = TOKEN_NUDGES.slice(index + 1);
  const next = higher[0];
  return oneFact({
    factAt: sql`now()`,
    afterMs: TOKEN_NUDGE_AFTER_MS,
    dedupeKey: sql`${`tokens:${String(nudge.usedPercent)}`}`,
    // bigint division: the floor, the same boundary as tokensReached's
    payload: sql`jsonb_build_object('tokens',
      (${packTokens} * ${leftPercent(nudge.usedPercent)} / 100)::text)`,
    stillApplies: sql`(${users.status} = ${literal(UserStatus.Active)}
      and ${tokensReached(nudge.usedPercent)}${
        next === undefined
          ? sql``
          : sql`
      and not (${tokensReached(next.usedPercent)})
      and not exists (select 1 from ${notificationJobs} higher
        where higher.user_id = ${users.id}
          and higher.status <> ${literal(NotificationJobStatus.Canceled)}
          and higher.kind in (${sql.join(
            higher.map((h) => literal(h.kind)),
            sql`, `,
          )}))`
      })`,
    replansCanceled: true,
  });
};

// The deposits that switched the user to real (#686, docs/mailing.md → The real-mode notification):
// one row per deposit, each its own job; the fact's moment is the switch's (mode_switch_at).
// deposit_events' outcome is written once (markDepositModeSwitch), so a switched row stays one.
const switchedDeposits = sql`(select ${depositEvents.modeSwitchAt} as at,
    ${depositEvents.id} as deposit_id, ${depositEvents.brokerAccountId} as broker_account_id
  from ${depositEvents}
  where ${depositEvents.userId} = ${users.id}
    and ${depositEvents.modeSwitch} = ${literal(DepositModeSwitch.Switched)})`;

// the payload's key as its schema names it, so the message's parse and this SQL cannot drift apart
const STAKE_KEY = literal(realModeByDepositPayloadSchema.keyof().enum.stake);

// One entry per kind: a kind added to NotificationKind without a scenario does not compile.
export const MAILING_SCENARIOS = {
  [NotificationKind.FirstSession1h]: firstSessionStep(NotificationKind.FirstSession1h),
  [NotificationKind.FirstSession24h]: firstSessionStep(NotificationKind.FirstSession24h),
  [NotificationKind.FirstSession72h]: firstSessionStep(NotificationKind.FirstSession72h),
  [NotificationKind.AnalysisUnused]: oneFact({
    factAt: lastAnalysisAt,
    afterMs: ANALYSIS_UNUSED_AFTER_MS,
    // the analysis' own moment, microseconds and UTC whatever the session's TimeZone
    dedupeKey: sql`('analysis_unused:' || extract(epoch from ${users.lastAnalysisAt})::text)`,
    payload: sql`jsonb_build_object('assetId', ${users.lastAnalysisAssetId},
      'durationSec', ${users.lastAnalysisDurationSec})`,
    stillApplies: analysisUnused,
  }),
  [NotificationKind.ReferralRewarded]: {
    facts: rewardRows,
    afterMs: REFERRAL_REWARDED_AFTER_MS,
    dedupeKey: sql`('referral_rewarded:' || fact.reward_id::text)`,
    payload: sql`jsonb_build_object('tokens', fact.tokens)`,
    stillApplies: sql`(${users.status} = ${literal(UserStatus.Active)})`,
    keyApplies: sql`exists (select 1 from ${tokenLedger}
      where ${tokenLedger.userId} = ${users.id} and ${tokenLedger.referralId} is not null
        and ${notificationJobs.dedupeKey} = 'referral_rewarded:' || ${tokenLedger.id}::text)`,
  },
  [NotificationKind.TokensHalf]: tokenNudge(NotificationKind.TokensHalf),
  [NotificationKind.TokensLow]: tokenNudge(NotificationKind.TokensLow),
  [NotificationKind.TokensOut]: tokenNudge(NotificationKind.TokensOut),
  [NotificationKind.RealModeByDeposit]: {
    facts: switchedDeposits,
    afterMs: REAL_MODE_BY_DEPOSIT_AFTER_MS,
    dedupeKey: sql`('real_mode_by_deposit:' || fact.deposit_id::text)`,
    // the real stake in use: the saved one, else the broker's minimum of the deposit's account
    // (one snapshot per account), as text (rule 2); NULL when neither is known
    payload: sql`jsonb_build_object(${STAKE_KEY}, coalesce(${users.realStake},
      (select ${brokerBalanceSnapshots.minTradeAmount} from ${brokerBalanceSnapshots}
        where ${brokerBalanceSnapshots.brokerAccountId} = fact.broker_account_id))::text)`,
    // the message says the mode is REAL: not once the user went back to demo
    stillApplies: sql`(${users.status} = ${literal(UserStatus.Active)}
      and ${users.tradingMode} = ${literal(TradeMode.Real)})`,
    keyApplies: sql`exists (select 1 from ${depositEvents}
      where ${depositEvents.userId} = ${users.id}
        and ${depositEvents.modeSwitch} = ${literal(DepositModeSwitch.Switched)}
        and ${notificationJobs.dedupeKey} = 'real_mode_by_deposit:' || ${depositEvents.id}::text)`,
    replansCanceled: true,
    important: true,
  },
} as const satisfies Record<NotificationKind, MailingScenario>;

// The important kinds (MailingScenario.important), from the scenarios alone.
export const IMPORTANT_NOTIFICATION_KINDS: readonly NotificationKind[] = (
  Object.keys(MAILING_SCENARIOS) as NotificationKind[]
).filter((kind) => (MAILING_SCENARIOS[kind] as MailingScenario).important === true);
