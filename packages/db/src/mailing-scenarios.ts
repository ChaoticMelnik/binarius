import { sql, type SQL } from 'drizzle-orm';
import {
  BrokerAccountStatus,
  FIRST_SESSION_CHAIN,
  NotificationKind,
  TOKEN_NUDGES,
  TokenLedgerKind,
  UserStatus,
} from '@binarius/shared';
import { LINK_BONUS_TOKENS } from './link-bonus-ops';
import { literal } from './schema/columns';
import { brokerAccounts } from './schema/broker-accounts';
import { notificationJobs } from './schema/notification-jobs';
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

// The low-token nudge (#123): the cached balance (rule 2: equal to the ledger) against the starter
// pack, the only pack a user gets (token_ledger_link_bonus_user_idx). A nudge's band is its own
// threshold down to the next one's, so a balance matches one nudge at most; and no nudge applies
// once a higher one has a job of any status, so a user who reaches several thresholds at once — at
// the deploy, or between two ticks — gets the highest only, and a lower one never later, even when
// an adjustment lifts the balance back into its band (owner, 2026-10-10). The fact is the planning
// moment: the kinds' plans_from only switches them on, and a user already past a threshold at the
// deploy gets that push (owner, 2026-10-10; docs/mailing.md → The low-token nudge).
const tokensReached = (usedPercent: number) =>
  sql`${users.tokenBalance} * 100 <= ${String(LINK_BONUS_TOKENS)}::bigint * ${100 - usedPercent}::int`;

const hasStarterPack = sql`exists (select 1 from ${tokenLedger}
  where ${tokenLedger.userId} = ${users.id}
    and ${tokenLedger.kind} = ${literal(TokenLedgerKind.Bonus)}
    and ${tokenLedger.brokerAccountId} is not null)`;

const tokenNudge = (kind: NotificationKind): MailingScenario => {
  const index = TOKEN_NUDGES.findIndex((nudge) => nudge.kind === kind);
  const nudge = TOKEN_NUDGES[index];
  if (nudge === undefined) throw new Error(`${kind} is not one of TOKEN_NUDGES`);
  const higher = TOKEN_NUDGES.slice(index + 1);
  const next = higher[0];
  return {
    factAt: sql`now()`,
    afterHours: 0,
    dedupeKey: `tokens:${nudge.usedPercent}`,
    stillApplies: sql`(${users.status} = ${literal(UserStatus.Active)}
      and ${hasStarterPack}
      and ${tokensReached(nudge.usedPercent)}
      ${
        next === undefined
          ? sql``
          : sql`and not (${tokensReached(next.usedPercent)})
      and not exists (select 1 from ${notificationJobs} higher
        where higher.user_id = ${users.id}
          and higher.kind in (${sql.join(
            higher.map((h) => literal(h.kind)),
            sql`, `,
          )}))`
      })`,
  };
};

// One entry per kind: a kind added to NotificationKind without a scenario does not compile.
export const MAILING_SCENARIOS = {
  [NotificationKind.FirstSession1h]: firstSessionStep(NotificationKind.FirstSession1h),
  [NotificationKind.FirstSession24h]: firstSessionStep(NotificationKind.FirstSession24h),
  [NotificationKind.FirstSession72h]: firstSessionStep(NotificationKind.FirstSession72h),
  [NotificationKind.TokensHalf]: tokenNudge(NotificationKind.TokensHalf),
  [NotificationKind.TokensLow]: tokenNudge(NotificationKind.TokensLow),
  [NotificationKind.TokensOut]: tokenNudge(NotificationKind.TokensOut),
} as const satisfies Record<NotificationKind, MailingScenario>;
