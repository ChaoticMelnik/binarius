import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  BrokerAccountStatus,
  PostbackDeliveryOutcome,
  PostbackResponseOutcome,
  POSTBACK_MACROS,
  PostbackSource,
  classifyPostback,
  normalizeDecimal,
  type DecimalString,
  type PostbackEvent,
  type PostbackQuery,
  type PostbackRejectReason,
} from '@binarius/shared';
import type { Db } from './client';
import { brokerAccounts } from './schema/broker-accounts';
import { depositEvents } from './schema/deposit-events';
import { notRejectedDelivery, postbackDeliveries } from './schema/postback-deliveries';
import { users } from './schema/users';
import type { Tx } from './trade-intent-ops';

// What a repeated delivery disagreed on with the stored deposit; names only, never the values.
// The stored row keeps its first amount and trader.
export interface PostbackMismatch {
  amount?: true;
  traderId?: true;
}

export type RecordPostbackResult =
  | {
      outcome: typeof PostbackResponseOutcome.Rejected;
      reason: PostbackRejectReason;
      postbackId?: string;
      event?: PostbackEvent;
    }
  | { outcome: typeof PostbackResponseOutcome.Duplicate; postbackId: string; event: PostbackEvent }
  | {
      outcome: typeof PostbackResponseOutcome.Recorded;
      postbackId: string;
      event: PostbackEvent;
      depositEventId: string;
      attributed: boolean;
    }
  | {
      outcome: typeof PostbackResponseOutcome.Repeated;
      postbackId: string;
      event: PostbackEvent;
      depositEventId: string;
      mismatch?: PostbackMismatch;
    };

// Thrown inside the transaction to undo a deposit written for a postback id that a concurrent
// delivery recorded first; caught below as a duplicate.
class PostbackIdTaken extends Error {}

const notRejected = notRejectedDelivery(postbackDeliveries.outcome);

// The postback writer (#141, docs/postbacks.md). One transaction; it never credits, never writes
// users or token_ledger. Every delivery that reaches it is journaled except a repeat of a
// recorded postback id. Lock order: broker_accounts (FOR SHARE) → deposit_events → the journal,
// the same relative order as activation's users → broker_accounts → deposit_events (Rule 5).
export async function recordPostback(
  db: Db,
  { source, query }: { source: PostbackSource; query: PostbackQuery },
): Promise<RecordPostbackResult> {
  const classified = classifyPostback(query);
  if (classified.kind === 'rejected') {
    await db.insert(postbackDeliveries).values({
      source,
      postbackId: classified.postbackId ?? null,
      event: classified.event ?? null,
      outcome: PostbackDeliveryOutcome.Rejected,
      rejectReason: classified.reason,
      payload: query,
    });
    return {
      outcome: PostbackResponseOutcome.Rejected,
      reason: classified.reason,
      ...(classified.postbackId === undefined ? {} : { postbackId: classified.postbackId }),
      ...(classified.event === undefined ? {} : { event: classified.event }),
    };
  }
  const { postbackId, event, paymentId, traderId, amount, coin } = classified;
  const duplicate = { outcome: PostbackResponseOutcome.Duplicate, postbackId, event } as const;

  try {
    return await db.transaction(async (tx) => {
      const [seen] = await tx
        .select({ id: postbackDeliveries.id })
        .from(postbackDeliveries)
        .where(
          and(
            eq(postbackDeliveries.source, source),
            eq(postbackDeliveries.postbackId, postbackId),
            notRejected,
          ),
        );
      if (seen !== undefined) return duplicate;

      // FOR SHARE waits for an activation holding the row FOR NO KEY UPDATE, then reads the
      // status it committed: a deposit is never left unattributed by a confirm in flight
      const [account] = await tx
        .select({
          id: brokerAccounts.id,
          userId: brokerAccounts.userId,
          status: brokerAccounts.status,
        })
        .from(brokerAccounts)
        .where(eq(brokerAccounts.brokerUserId, traderId))
        .for('share');
      // a pending account is an unconfirmed claim: someone's deposit must not reach another
      // user's card through it. A revoked one was confirmed once.
      const owner =
        account !== undefined && account.status !== BrokerAccountStatus.Pending
          ? { userId: account.userId, brokerAccountId: account.id }
          : {};

      const [inserted] = await tx
        .insert(depositEvents)
        .values({
          source,
          brokerUserId: traderId,
          paymentId,
          amount,
          currency: coin ?? null,
          ...owner,
        })
        .onConflictDoNothing({ target: [depositEvents.source, depositEvents.paymentId] })
        .returning({ id: depositEvents.id });

      let result: RecordPostbackResult;
      if (inserted !== undefined) {
        result = {
          outcome: PostbackResponseOutcome.Recorded,
          postbackId,
          event,
          depositEventId: inserted.id,
          attributed: 'userId' in owner,
        };
      } else {
        const [stored] = await tx
          .select({
            id: depositEvents.id,
            amount: depositEvents.amount,
            brokerUserId: depositEvents.brokerUserId,
          })
          .from(depositEvents)
          .where(and(eq(depositEvents.source, source), eq(depositEvents.paymentId, paymentId)));
        if (stored === undefined) throw new Error('deposit vanished between conflict and read');
        const mismatch: PostbackMismatch = {
          ...(normalizeDecimal(stored.amount) === normalizeDecimal(amount) ? {} : { amount: true }),
          ...(stored.brokerUserId === traderId ? {} : { traderId: true }),
        };
        result = {
          outcome: PostbackResponseOutcome.Repeated,
          postbackId,
          event,
          depositEventId: stored.id,
          ...(Object.keys(mismatch).length === 0 ? {} : { mismatch }),
        };
      }

      const [delivery] = await tx
        .insert(postbackDeliveries)
        .values({
          source,
          postbackId,
          event,
          outcome:
            result.outcome === PostbackResponseOutcome.Recorded
              ? PostbackDeliveryOutcome.DepositRecorded
              : PostbackDeliveryOutcome.DepositRepeated,
          depositEventId: result.depositEventId,
          payload: query,
        })
        // postback_deliveries_source_postback_idx's own predicate: a partial unique index is an
        // arbiter only when the conflict clause implies it
        .onConflictDoNothing({
          target: [postbackDeliveries.source, postbackDeliveries.postbackId],
          where: notRejected,
        })
        .returning({ id: postbackDeliveries.id });
      if (delivery === undefined) {
        // a concurrent delivery of this postback id committed first. When it carried the same
        // payment, the deposit write above was a no-op; when it did not, undo what it wrote.
        if (inserted !== undefined) throw new PostbackIdTaken();
        return duplicate;
      }
      return result;
    });
  } catch (error) {
    if (error instanceof PostbackIdTaken) return duplicate;
    throw error;
  }
}

// Late attachment (#141): the deposits of a trader that arrived before the account was
// confirmed. Preconditions, which the caller's activation transaction owns: users and the
// account row are held FOR NO KEY UPDATE and the account was just made active. One statement
// sets user_id and broker_account_id together, so the pair CHECK and both composite FKs see the
// finished row. Idempotent: an attached row no longer matches.
export async function attachDepositsToAccount(
  tx: Tx,
  { accountId, userId, brokerUserId }: { accountId: string; userId: string; brokerUserId: string },
): Promise<void> {
  await tx
    .update(depositEvents)
    .set({ userId, brokerAccountId: accountId })
    .where(
      and(
        eq(depositEvents.source, PostbackSource.Binodex),
        eq(depositEvents.brokerUserId, brokerUserId),
        isNull(depositEvents.userId),
        isNull(depositEvents.brokerAccountId),
      ),
    );
}

export type PostbackDeliveryRow = typeof postbackDeliveries.$inferSelect;

// The journal, newest first, rejected rows included (the `deposit list` CLI).
export async function listRecentPostbackDeliveries(
  db: Db,
  limit: number,
): Promise<PostbackDeliveryRow[]> {
  return db
    .select()
    .from(postbackDeliveries)
    .orderBy(desc(postbackDeliveries.createdAt), desc(postbackDeliveries.id))
    .limit(limit);
}

export interface DepositByPayment {
  deposit:
    | {
        id: string;
        brokerUserId: string;
        amount: DecimalString;
        currency: string | null;
        status: string;
        brokerAccountId: string | null;
        telegramUserId: bigint | null;
        createdAt: Date;
      }
    | undefined;
  // the deposit's deliveries and the rejected ones that named this payment id, oldest first
  deliveries: PostbackDeliveryRow[];
}

// One payment with every delivery that named it (the `deposit show` CLI).
export async function readDepositByPayment(
  db: Db,
  { source, paymentId }: { source: PostbackSource; paymentId: string },
): Promise<DepositByPayment> {
  const [deposit] = await db
    .select({
      id: depositEvents.id,
      brokerUserId: depositEvents.brokerUserId,
      amount: depositEvents.amount,
      currency: depositEvents.currency,
      status: depositEvents.status,
      brokerAccountId: depositEvents.brokerAccountId,
      telegramUserId: users.telegramUserId,
      createdAt: depositEvents.createdAt,
    })
    .from(depositEvents)
    .leftJoin(users, eq(users.id, depositEvents.userId))
    .where(and(eq(depositEvents.source, source), eq(depositEvents.paymentId, paymentId)));
  const rejectedForPayment = and(
    eq(postbackDeliveries.source, source),
    eq(postbackDeliveries.outcome, PostbackDeliveryOutcome.Rejected),
    sql`${postbackDeliveries.payload} ->> ${POSTBACK_MACROS.paymentId} = ${paymentId}`,
  );
  const deliveries = await db
    .select()
    .from(postbackDeliveries)
    .where(
      deposit === undefined
        ? rejectedForPayment
        : or(eq(postbackDeliveries.depositEventId, deposit.id), rejectedForPayment),
    )
    .orderBy(postbackDeliveries.createdAt, postbackDeliveries.id);
  return { deposit, deliveries };
}
