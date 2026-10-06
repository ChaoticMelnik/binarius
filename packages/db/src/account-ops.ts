import { desc, eq } from 'drizzle-orm';
import {
  addressOrNull,
  BrokerAccountStatus,
  USER_ACCOUNT_LIST_LIMIT,
  type LinkedAccountView,
  type UserAccountView,
  type UserStatus,
} from '@binarius/shared';
import type { Db } from './client';
import { brokerAccounts } from './schema/broker-accounts';
import { users } from './schema/users';

export type LinkedAccountRow = Pick<typeof brokerAccounts.$inferSelect, 'id' | 'email' | 'status'>;

export interface UserAccountSnapshot {
  status: UserStatus;
  accounts: LinkedAccountRow[];
}

// What /account shows; reads only. Two plain selects with no transaction: nothing here is
// written, and an answer a few milliseconds mixed across a concurrent block or link is accepted
// (docs/bot-account.md → Accepted risks). `undefined` when the user has no row yet.
export async function readUserAccounts(
  db: Db,
  telegramUserId: bigint,
): Promise<UserAccountSnapshot | undefined> {
  const [user] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.telegramUserId, telegramUserId));
  if (user === undefined) return undefined;

  const accounts = await db
    .select({ id: brokerAccounts.id, email: brokerAccounts.email, status: brokerAccounts.status })
    .from(brokerAccounts)
    .where(eq(brokerAccounts.userId, user.id))
    .orderBy(desc(brokerAccounts.createdAt), desc(brokerAccounts.id))
    .limit(USER_ACCOUNT_LIST_LIMIT);
  return { status: user.status, accounts };
}

// Built key by key, and the id only on a pending row: it is what the confirm button carries, and
// nothing else needs it. A blank address is no address — "Подключён: " with nothing after it is
// what the bot would print otherwise. toUserStartView and toBrokerAccountView call the same
// addressOrNull (#214).
export function toLinkedAccountView(row: LinkedAccountRow): LinkedAccountView {
  const email = addressOrNull(row.email);
  switch (row.status) {
    case BrokerAccountStatus.Pending:
      return { status: row.status, id: row.id, email };
    case BrokerAccountStatus.Active:
    case BrokerAccountStatus.Revoked:
      return { status: row.status, email };
  }
}

export function toUserAccountView(snapshot: UserAccountSnapshot): UserAccountView {
  return { status: snapshot.status, accounts: snapshot.accounts.map(toLinkedAccountView) };
}
