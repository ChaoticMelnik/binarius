import { sql, type SQL } from 'drizzle-orm';
import {
  ANALYSIS_UNUSED_AFTER_MS,
  ANALYSIS_UNUSED_UNTIL_MS,
  BrokerAccountStatus,
  FIRST_SESSION_CHAIN,
  NotificationKind,
  TokenLedgerKind,
  TradeMode,
  TradingSessionStatus,
  UserStatus,
} from '@binarius/shared';
import { literal } from './schema/columns';
import { brokerAccounts } from './schema/broker-accounts';
import { tokenLedger } from './schema/token-ledger';
import { tradeIntents } from './schema/trade-intents';
import { tradingSessions } from './schema/trading-sessions';
import { users } from './schema/users';

// What the planner and the sender know about a kind (docs/mailing.md). Every SQL fragment reads
// the outer `users` row and locks nothing.
export interface MailingScenario {
  // the user's fact the kind counts from; NULL plans nothing
  factAt: SQL;
  afterMs: number;
  // one job per user per key (notification_jobs_dedupe_key_idx), so planning is idempotent; the
  // claim cancels a job whose key the scenario would not plan now (a newer fact)
  dedupeKey: SQL;
  // the job's payload (jsonb), what the message is built from; '{}' when absent
  payload?: SQL;
  // checked when planning and again when the sender claims: false at claim cancels the job
  stillApplies: SQL;
}

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
  return {
    factAt: linkedAt,
    afterMs: step.afterHours * 3_600_000,
    dedupeKey: sql`${`first_session:${String(step.afterHours)}h`}`,
    stillApplies:
      next === undefined
        ? beforeFirstSession
        : sql`(${beforeFirstSession} and ${linkedAt} + make_interval(hours => ${next.afterHours}) > now())`,
  };
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

// One entry per kind: a kind added to NotificationKind without a scenario does not compile.
export const MAILING_SCENARIOS = {
  [NotificationKind.FirstSession1h]: firstSessionStep(NotificationKind.FirstSession1h),
  [NotificationKind.FirstSession24h]: firstSessionStep(NotificationKind.FirstSession24h),
  [NotificationKind.FirstSession72h]: firstSessionStep(NotificationKind.FirstSession72h),
  [NotificationKind.AnalysisUnused]: {
    factAt: lastAnalysisAt,
    afterMs: ANALYSIS_UNUSED_AFTER_MS,
    // the analysis' own moment, microseconds and UTC whatever the session's TimeZone
    dedupeKey: sql`('analysis_unused:' || extract(epoch from ${users.lastAnalysisAt})::text)`,
    payload: sql`jsonb_build_object('assetId', ${users.lastAnalysisAssetId},
      'durationSec', ${users.lastAnalysisDurationSec})`,
    stillApplies: analysisUnused,
  },
} as const satisfies Record<NotificationKind, MailingScenario>;
