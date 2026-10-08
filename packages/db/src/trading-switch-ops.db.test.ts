import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTempDatabase,
  intentRequest,
  seedQueuedIntent,
  seedUserWithAccount,
  type TempDatabase,
} from './testing';
import { AuditAction } from '@binarius/shared';
import { auditLog, tradingSwitch } from './schema/index';
import { TradeIntentError, createTradeIntent, takeIntent } from './trade-intent-ops';
import { openTrading, readTradingSwitch, stopTrading } from './trading-switch-ops';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

// audit_log is append-only: every case reads only the rows written after its own start
let auditMark: string;
const switchAudits = () =>
  tmp.db
    .select({ action: auditLog.action, payload: auditLog.payload, entityType: auditLog.entityType })
    .from(auditLog)
    .where(
      sql`${auditLog.createdAt} >= ${auditMark}::timestamptz and ${auditLog.action} in (${AuditAction.TradingStopped}, ${AuditAction.TradingResumed})`,
    )
    .orderBy(auditLog.createdAt);

// the seed state of migration 0020, restored by hand before each case
beforeEach(async () => {
  await tmp.db.delete(tradingSwitch);
  await tmp.db.execute(
    sql`insert into trading_switch (trading_enabled, source, reason) values (true, 'migration', null)`,
  );
  const { rows } = await tmp.db.execute<{ now: string }>(sql`select now()::text as now`);
  auditMark = rows[0]!.now;
});

describe('the seed', () => {
  it('T1 a freshly migrated database has one open row written by the migration', async () => {
    const fresh = await createTempDatabase(baseUrl!);
    try {
      expect(await fresh.db.select().from(tradingSwitch)).toEqual([
        expect.objectContaining({
          id: true,
          tradingEnabled: true,
          source: 'migration',
          reason: null,
        }),
      ]);
    } finally {
      await fresh.drop();
    }
  });
});

describe('stopTrading', () => {
  it('T2 closes an open switch and writes one trading_stopped row', async () => {
    const result = await stopTrading(tmp.db, { source: 'operator', reason: 'инцидент брокера' });
    expect(result.changed).toBe(true);
    expect(result.state).toMatchObject({
      tradingEnabled: false,
      source: 'operator',
      reason: 'инцидент брокера',
    });
    expect(await readTradingSwitch(tmp.db)).toMatchObject({ tradingEnabled: false });
    expect(await switchAudits()).toEqual([
      {
        action: 'trading_stopped',
        entityType: 'trading_switch',
        payload: { via: 'cli', source: 'operator', reason: 'инцидент брокера' },
      },
    ]);
  });

  it('T3 on a closed switch changes nothing and writes no audit row', async () => {
    await stopTrading(tmp.db, { source: 'operator', reason: 'первая' });
    const again = await stopTrading(tmp.db, { source: 'operator', reason: 'вторая' });
    expect(again.changed).toBe(false);
    expect(again.state).toMatchObject({ tradingEnabled: false, reason: 'первая' });
    expect((await switchAudits()).map((row) => row.action)).toEqual(['trading_stopped']);
  });
});

describe('openTrading', () => {
  it('T4 opens a closed switch as the operator and writes one trading_resumed row', async () => {
    // closed by hand with the seed's source, so only openTrading can have written operator
    await tmp.db.execute(
      sql`update trading_switch set trading_enabled = false, reason = 'закрыто', source = 'migration'`,
    );
    const result = await openTrading(tmp.db, { reason: 'брокер в норме' });
    expect(result.changed).toBe(true);
    expect(result.state).toMatchObject({
      tradingEnabled: true,
      source: 'operator',
      reason: 'брокер в норме',
    });
    expect(await switchAudits()).toEqual([
      {
        action: 'trading_resumed',
        entityType: 'trading_switch',
        payload: { via: 'cli', reason: 'брокер в норме' },
      },
    ]);
  });

  it('T5 on the open seed changes nothing: no audit row, source stays migration', async () => {
    const result = await openTrading(tmp.db);
    expect(result.changed).toBe(false);
    expect(result.state).toMatchObject({ tradingEnabled: true, source: 'migration' });
    expect(await switchAudits()).toEqual([]);
  });

  it('writes a NULL reason when none is given', async () => {
    await stopTrading(tmp.db, { source: 'operator', reason: 'x' });
    const result = await openTrading(tmp.db);
    expect(result.state.reason).toBeNull();
  });
});

describe('a missing row (fail-closed)', () => {
  it('T6 reads as closed for take and create; stopTrading recreates it closed', async () => {
    const queued = await seedQueuedIntent(tmp.db);
    const other = await seedUserWithAccount(tmp.db);
    await tmp.db.delete(tradingSwitch);

    expect(await readTradingSwitch(tmp.db)).toBeUndefined();
    expect(
      await takeIntent(tmp.db, {
        id: queued.intent.id,
        expectedVersion: queued.intent.version,
        maxAgeMs: 60_000,
      }),
    ).toBeUndefined();
    const refused = await createTradeIntent(tmp.db, intentRequest(other.telegramUserId)).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(TradeIntentError);
    expect((refused as TradeIntentError).code).toBe('trading_paused');

    const repaired = await stopTrading(tmp.db, { source: 'operator', reason: 'строка удалена' });
    expect(repaired.changed).toBe(true);
    expect(await tmp.db.select().from(tradingSwitch)).toEqual([
      expect.objectContaining({ tradingEnabled: false, reason: 'строка удалена' }),
    ]);
    expect((await switchAudits()).map((row) => row.action)).toEqual(['trading_stopped']);
  });

  it('openTrading recreates it open', async () => {
    await tmp.db.delete(tradingSwitch);
    const result = await openTrading(tmp.db);
    expect(result.changed).toBe(true);
    expect(await tmp.db.select().from(tradingSwitch).where(eq(tradingSwitch.id, true))).toEqual([
      expect.objectContaining({ tradingEnabled: true, source: 'operator' }),
    ]);
  });
});
