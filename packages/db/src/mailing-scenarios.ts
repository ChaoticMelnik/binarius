import { sql, type SQL } from 'drizzle-orm';
import {
  BrokerAccountStatus,
  FIRST_SESSION_CHAIN,
  NotificationKind,
  TokenLedgerKind,
  UserStatus,
} from '@binarius/shared';
import { literal } from './schema/columns';
import { brokerAccounts } from './schema/broker-accounts';
import { tokenLedger } from './schema/token-ledger';
import { tradingSessions } from './schema/trading-sessions';
import { users } from './schema/users';

// What the planner and the sender know about a kind (docs/mailing.md). Both SQL fragments read
// the outer `users` row and lock nothing.
export interface MailingScenario {
  // the user's fact the kind counts from; NULL plans nothing
  factAt: SQL;
  afterHours: number;
  // one job per user per key (notification_jobs_dedupe_key_idx), so planning is idempotent
  dedupeKey: string;
  // checked when planning and again when the sender claims: false at claim cancels the job
  stillApplies: SQL;
}

// The moment the account was connected: the starter pack's ledger row, written in the
// activation transaction (grantLinkBonus). The predicate is token_ledger_link_bonus_user_idx's,
// so there is at most one row.
const linkedAt = sql`(select ${tokenLedger.createdAt} from ${tokenLedger}
  where ${tokenLedger.userId} = ${users.id}
    and ${tokenLedger.kind} = ${literal(TokenLedgerKind.Bonus)}
    and ${tokenLedger.brokerAccountId} is not null)`;

// The user can still act on the button: not blocked by the admin, an active account, and no
// trading session of any status on any of their accounts (owner, 2026-10-07: the chain leads to
// the first session, so any session ends it).
const beforeFirstSession = sql`(${users.status} = ${literal(UserStatus.Active)}
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
    afterHours: step.afterHours,
    dedupeKey: `first_session:${step.afterHours}h`,
    stillApplies:
      next === undefined
        ? beforeFirstSession
        : sql`(${beforeFirstSession} and ${linkedAt} + make_interval(hours => ${next.afterHours}) > now())`,
  };
};

// One entry per kind: a kind added to NotificationKind without a scenario does not compile.
export const MAILING_SCENARIOS = {
  [NotificationKind.FirstSession1h]: firstSessionStep(NotificationKind.FirstSession1h),
  [NotificationKind.FirstSession24h]: firstSessionStep(NotificationKind.FirstSession24h),
  [NotificationKind.FirstSession72h]: firstSessionStep(NotificationKind.FirstSession72h),
} as const satisfies Record<NotificationKind, MailingScenario>;
