import { sql, type SQL } from 'drizzle-orm';
import {
  ANALYSIS_UNUSED_AFTER_MS,
  ANALYSIS_UNUSED_UNTIL_MS,
  BrokerAccountStatus,
  FIRST_SESSION_CHAIN,
  NotificationKind,
  REFERRAL_REWARDED_AFTER_MS,
  TokenLedgerKind,
  TradeMode,
  TradingSessionStatus,
  UserStatus,
} from '@binarius/shared';
import { literal } from './schema/columns';
import { brokerAccounts } from './schema/broker-accounts';
import { notificationJobs } from './schema/notification-jobs';
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
}): MailingScenario => ({
  facts: sql`(select ${factAt} as at)`,
  dedupeKey,
  keyApplies: sql`${notificationJobs.dedupeKey} = ${dedupeKey}`,
  ...rest,
});

// The moment the account was connected: the starter pack's ledger row, written in the
// activation transaction (grantLinkBonus). The predicate is token_ledger_link_bonus_user_idx's,
// so there is at most one row; an account connected with no active link_bonus rule has none, and
// so no chain (#13).
const linkedAt = sql`(select ${tokenLedger.createdAt} from ${tokenLedger}
  where ${tokenLedger.userId} = ${users.id}
    and ${tokenLedger.kind} = ${literal(TokenLedgerKind.Bonus)}
    and ${tokenLedger.brokerAccountId} is not null)`;

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
} as const satisfies Record<NotificationKind, MailingScenario>;
