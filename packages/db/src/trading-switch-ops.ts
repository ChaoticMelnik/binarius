import { eq, not, sql, type SQL } from 'drizzle-orm';
import {
  AuditActorType,
  AuditAction,
  AuditEntityType,
  TradingSwitchSource,
} from '@binarius/shared';
import type { Db } from './client';
import { auditLog } from './schema/audit-log';
import { tradingSwitch } from './schema/trading-switch';
import type { DbExecutor, Tx } from './trade-intent-ops';

// The global trading switch (#144, docs/kill-switch.md). Readers take no lock (Rule 5); the two
// writers lock the switch row and nothing else.

export type TradingSwitchRow = typeof tradingSwitch.$inferSelect;

// The one predicate every SQL reader embeds: a missing row reads as closed (fail-closed).
export const tradingOpenSql: SQL = sql`exists (select 1 from ${tradingSwitch} where ${tradingSwitch.tradingEnabled})`;

export async function readTradingSwitch(db: DbExecutor): Promise<TradingSwitchRow | undefined> {
  const [row] = await db.select().from(tradingSwitch);
  return row;
}

export const isTradingOpen = (row: TradingSwitchRow | undefined): boolean =>
  row?.tradingEnabled === true;

export interface TradingSwitchChange {
  changed: boolean;
  // the row as this transaction left it; when changed is false, the state that stood instead
  state: TradingSwitchRow;
}

// migration is the seed's own source; a writer never claims it
export type TradingSwitchWriter = Exclude<
  TradingSwitchSource,
  typeof TradingSwitchSource.Migration
>;

export interface StopTradingInput {
  source: TradingSwitchWriter;
  // already passed tradingSwitchReasonSchema at the boundary
  reason: string;
}

export function stopTrading(
  db: Db,
  { source, reason }: StopTradingInput,
): Promise<TradingSwitchChange> {
  const closed = { tradingEnabled: false, source, reason, changedAt: sql`now()` };
  return db.transaction(async (tx) => {
    // a missing row already reads as closed; inserting it records who closed it and why
    const [inserted] = await tx
      .insert(tradingSwitch)
      .values(closed)
      .onConflictDoNothing()
      .returning();
    const [updated] =
      inserted === undefined
        ? await tx
            .update(tradingSwitch)
            .set(closed)
            .where(eq(tradingSwitch.tradingEnabled, true))
            .returning()
        : [inserted];
    if (updated === undefined) return { changed: false, state: await lockedState(tx) };
    await audit(tx, AuditAction.TradingStopped, { via: 'cli', source, reason });
    return { changed: true, state: updated };
  });
}

export interface OpenTradingInput {
  reason?: string;
}

// The only writer of trading_enabled = true, and it always writes source = operator: only an
// operator opens trading (#144 decision 6; stated, test T8 in trading-switch-ops.db.test.ts).
export function openTrading(
  db: Db,
  { reason }: OpenTradingInput = {},
): Promise<TradingSwitchChange> {
  const open = {
    tradingEnabled: true,
    source: TradingSwitchSource.Operator,
    reason: reason ?? null,
    changedAt: sql`now()`,
  };
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(tradingSwitch)
      .values(open)
      .onConflictDoNothing()
      .returning();
    const [updated] =
      inserted === undefined
        ? await tx
            .update(tradingSwitch)
            .set(open)
            .where(not(tradingSwitch.tradingEnabled))
            .returning()
        : [inserted];
    if (updated === undefined) return { changed: false, state: await lockedState(tx) };
    await audit(tx, AuditAction.TradingResumed, { via: 'cli', reason: reason ?? null });
    return { changed: true, state: updated };
  });
}

// After a refused UPDATE the row exists; the lock pins the state reported until commit.
async function lockedState(tx: Tx): Promise<TradingSwitchRow> {
  const [row] = await tx.select().from(tradingSwitch).for('update');
  if (row === undefined) throw new Error('trading_switch row vanished inside its writer');
  return row;
}

async function audit(
  tx: Tx,
  action: typeof AuditAction.TradingStopped | typeof AuditAction.TradingResumed,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditLog).values({
    actorType: AuditActorType.System,
    action,
    entityType: AuditEntityType.TradingSwitch,
    payload,
  });
}
