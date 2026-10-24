import { and, asc, eq, isNotNull, notInArray, sql, type SQL } from 'drizzle-orm';
import { BrokerAccountStatus, ServiceAccountNotWorkingReason, UserStatus } from '@binarius/shared';
import type { Db } from './client';
import type { AdminServiceAccountView } from '@binarius/shared';
import {
  adminBrokerAccountColumns,
  toAdminBrokerAccountListItem,
  type AdminBrokerAccountRow,
} from './admin-read-ops';
import { brokerAccounts } from './schema/broker-accounts';
import { users } from './schema/users';
import { millisecondsAgo, millisecondsFromNow } from './sql-time';
import type { DbExecutor, Tx } from './trade-intent-ops';

// Service accounts (#391, docs/service-accounts.md). The fragments below are the one definition of
// which service accounts count: the price stream (#404) reads "in service", the backend's keeper
// and the admin page read "working", so none of them can disagree about an account. The database
// clock decides the token's age.

const marked = isNotNull(brokerAccounts.serviceSince);

// marked, the account active, its user active: a market data socket may run on it (#404). A token
// that merely expired does not take an account out: the stream's start exchanges it (serviceOnly)
export const serviceAccountInServiceSql: SQL = sql`(${marked}
  and ${brokerAccounts.status} = ${BrokerAccountStatus.Active}
  and ${users.status} = ${UserStatus.Active})`;

export const serviceAccountWorkingSql: SQL = sql`(${serviceAccountInServiceSql}
  and ${brokerAccounts.accessTokenExpiresAt} > now())`;

// The token service's order of checks: the user, then the account, then the token.
const notWorkingReasonSql = sql<ServiceAccountNotWorkingReason | null>`case
  when ${users.status} <> ${UserStatus.Active} then ${ServiceAccountNotWorkingReason.UserBlocked}
  when ${brokerAccounts.status} = ${BrokerAccountStatus.Pending} then ${ServiceAccountNotWorkingReason.Pending}
  when ${brokerAccounts.status} = ${BrokerAccountStatus.Revoked} then ${ServiceAccountNotWorkingReason.Revoked}
  when ${brokerAccounts.accessTokenExpiresAt} <= now() then ${ServiceAccountNotWorkingReason.TokenExpired}
  else null end`;

export interface ServiceBrokerAccount {
  id: string;
  brokerUserId: string;
  serviceSince: Date;
}

// The #404 contract: the in-service accounts, oldest mark first.
export async function listServiceBrokerAccounts(exec: DbExecutor): Promise<ServiceBrokerAccount[]> {
  const rows = await exec
    .select({
      id: brokerAccounts.id,
      brokerUserId: brokerAccounts.brokerUserId,
      serviceSince: brokerAccounts.serviceSince,
    })
    .from(brokerAccounts)
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .where(serviceAccountInServiceSql)
    .orderBy(asc(brokerAccounts.serviceSince), asc(brokerAccounts.id));
  return rows.map((row) => {
    // the predicate's first term; a NULL here would be a broken WHERE, not a state
    if (row.serviceSince === null) throw new Error('listServiceBrokerAccounts: unmarked row');
    return { id: row.id, brokerUserId: row.brokerUserId, serviceSince: row.serviceSince };
  });
}

export interface ServiceRenewalCandidatesOptions {
  // a token that expires within this is due
  renewAheadMs: number;
  // a row rotated (or created) more recently than this is not due, whatever its expiry says
  rotationGapMs: number;
  limit: number;
  // accounts the caller holds back for now
  exclude?: readonly string[];
}

// The keeper's queue: marked, active accounts of active users whose token is due, soonest expiry
// first. The token service re-checks the mark under the row lock; this list only narrows the work.
export async function listServiceRenewalCandidates(
  db: Db,
  { renewAheadMs, rotationGapMs, limit, exclude = [] }: ServiceRenewalCandidatesOptions,
): Promise<string[]> {
  const rows = await db
    .select({ id: brokerAccounts.id })
    .from(brokerAccounts)
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .where(
      and(
        marked,
        eq(brokerAccounts.status, BrokerAccountStatus.Active),
        eq(users.status, UserStatus.Active),
        sql`${brokerAccounts.accessTokenExpiresAt} <= ${millisecondsFromNow(renewAheadMs)}`,
        sql`coalesce(${brokerAccounts.tokenRotatedAt}, ${brokerAccounts.createdAt}) <= ${millisecondsAgo(rotationGapMs)}`,
        notInArray(brokerAccounts.id, [...exclude]),
      ),
    )
    .orderBy(asc(brokerAccounts.accessTokenExpiresAt), asc(brokerAccounts.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

export type ServiceAccountState = AdminBrokerAccountRow & {
  userId: string;
  telegramUserId: bigint;
  working: boolean;
  notWorkingReason: ServiceAccountNotWorkingReason | null;
};

// Every marked account, working or not, oldest mark first.
export async function listServiceAccountStates(exec: DbExecutor): Promise<ServiceAccountState[]> {
  return exec
    .select({
      ...adminBrokerAccountColumns,
      userId: brokerAccounts.userId,
      telegramUserId: users.telegramUserId,
      working: sql<boolean>`${serviceAccountWorkingSql}`,
      notWorkingReason: notWorkingReasonSql,
    })
    .from(brokerAccounts)
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .where(marked)
    .orderBy(asc(brokerAccounts.serviceSince), asc(brokerAccounts.id));
}

export type ServiceMarkResult = 'marked' | 'unmarked' | 'unchanged' | 'not_found';

// One conditional UPDATE: the current state is in the predicate, so a re-mark keeps the first
// date and two admins pressing at once write once. Nothing else on the row changes — the mark
// survives a revocation and a re-login (owner's answer Q5).
export async function setServiceMark(
  tx: Tx,
  { accountId, service }: { accountId: string; service: boolean },
): Promise<ServiceMarkResult> {
  const updated = await tx
    .update(brokerAccounts)
    .set({
      serviceSince: service ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(brokerAccounts.id, accountId),
        sql`(${brokerAccounts.serviceSince} is null) = ${service}`,
      ),
    )
    .returning({ id: brokerAccounts.id });
  if (updated.length > 0) return service ? 'marked' : 'unmarked';
  const [existing] = await tx
    .select({ id: brokerAccounts.id })
    .from(brokerAccounts)
    .where(eq(brokerAccounts.id, accountId));
  return existing === undefined ? 'not_found' : 'unchanged';
}

// The admin's projection of a state: the list item's allowlist plus the two facts of the count.
export function toAdminServiceAccountView(state: ServiceAccountState): AdminServiceAccountView {
  return {
    ...toAdminBrokerAccountListItem(state),
    working: state.working,
    notWorkingReason: state.notWorkingReason,
  };
}

// One account through the admin's column allowlist: the answer of a mark or an unmark.
export async function readBrokerAccountForAdmin(
  exec: DbExecutor,
  accountId: string,
): Promise<AdminBrokerAccountRow | undefined> {
  const [row] = await exec
    .select(adminBrokerAccountColumns)
    .from(brokerAccounts)
    .where(eq(brokerAccounts.id, accountId));
  return row;
}
