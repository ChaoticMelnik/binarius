import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditActorType, BOT_TEXT_CATALOG } from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  listBotTextOverrides,
  lockBotTextOverrides,
  resetBotTextOverride,
  saveBotTextOverride,
  type BotTextActor,
} from './bot-text-ops';
import { createTempDatabase, type TempDatabase } from './testing';
import { auditLog, botTextOverrides } from './schema/index';

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

const actor: BotTextActor = { type: AuditActorType.System, staffId: null };
const longer = (key: 'cardBody' | 'cardBonusAlready') =>
  `${BOT_TEXT_CATALOG[key].source}\n${'я'.repeat(250)}`;
const save = (key: string, source: string, expectedVersion?: number) =>
  saveBotTextOverride(tmp.db, { key, source, expectedVersion, actor });
const reset = (key: string, expectedVersion?: number) =>
  resetBotTextOverride(tmp.db, { key, expectedVersion, actor });
const versionOf = (result: Awaited<ReturnType<typeof save>>) => {
  if (!result.ok) throw new Error(`expected a write, got ${result.reason}`);
  return result.version;
};

let auditMark: string;
const audits = async () =>
  (
    await tmp.db
      .select({ action: auditLog.action, payload: auditLog.payload, actorType: auditLog.actorType })
      .from(auditLog)
      .where(sql`${auditLog.createdAt} >= ${auditMark}::timestamptz`)
      .orderBy(auditLog.createdAt)
  ).filter((row) => row.action.startsWith('bot_text_'));

beforeEach(async () => {
  await tmp.db.delete(botTextOverrides);
  const { rows } = await tmp.db.execute<{ now: string }>(sql`select now()::text as now`);
  auditMark = rows[0]!.now;
});

describe('saveBotTextOverride', () => {
  it('B1 stores the first override with a version and audits the default as the old text', async () => {
    const version = versionOf(await save('welcome', 'Привет'));
    expect(version).toBeGreaterThan(0);
    expect(await listBotTextOverrides(tmp.db)).toMatchObject([
      { key: 'welcome', source: 'Привет', version, updatedByStaffId: null },
    ]);
    expect(await audits()).toEqual([
      {
        action: 'bot_text_saved',
        actorType: 'system',
        payload: {
          key: 'welcome',
          action: 'save',
          oldText: BOT_TEXT_CATALOG.welcome.source,
          newText: 'Привет',
          oldVersion: 0,
          newVersion: version,
        },
      },
    ]);
  });

  it('B2 gives a second save a new version', async () => {
    const first = versionOf(await save('welcome', 'Привет'));
    const second = versionOf(await save('welcome', 'Здравствуй', first));
    expect(second).toBeGreaterThan(first);
    expect((await audits())[1]?.payload).toMatchObject({ oldText: 'Привет', oldVersion: first });
  });

  it('B3 refuses a stale version and writes nothing', async () => {
    const first = versionOf(await save('welcome', 'Привет'));
    await save('welcome', 'Здравствуй');
    expect(await save('welcome', 'Поздно', first)).toMatchObject({
      ok: false,
      reason: 'version_conflict',
    });
    expect((await listBotTextOverrides(tmp.db))[0]?.source).toBe('Здравствуй');
    expect(await audits()).toHaveLength(2);
  });

  it('B4 takes version 0 for a key with no override', async () => {
    expect(await save('welcome', 'Привет', 0)).toMatchObject({ ok: true });
  });

  it('B5 never hands a reset key its old version back', async () => {
    const first = versionOf(await save('welcome', 'Привет'));
    await reset('welcome');
    await save('welcome', 'Снова');
    expect(await save('welcome', 'Поздно', first)).toMatchObject({
      reason: 'version_conflict',
    });
  });

  it('B6 reports an unchanged text without writing or auditing', async () => {
    await save('welcome', 'Привет');
    expect(await save('welcome', 'Привет')).toEqual({ ok: false, reason: 'unchanged' });
    expect(await save('support', BOT_TEXT_CATALOG.support.source)).toEqual({
      ok: false,
      reason: 'unchanged',
    });
    expect(await audits()).toHaveLength(1);
  });

  it('B7 refuses broken HTML and writes no row', async () => {
    expect(await save('welcome', '<b>Привет')).toMatchObject({
      ok: false,
      reason: 'refused',
      problems: [{ key: 'welcome', rejection: { code: 'invalid' } }],
    });
    expect(await listBotTextOverrides(tmp.db)).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it('B7 refuses a read-only key and an unknown one before the transaction', async () => {
    expect(await save('startCommand', 'Старт')).toMatchObject({
      reason: 'refused',
      problems: [{ rejection: { code: 'read_only_group' } }],
    });
    expect(await save('renamedKey', 'x')).toMatchObject({
      problems: [{ rejection: { code: 'unknown_key' } }],
    });
  });

  it('B8 serializes writers: a save waits for the lock and sees the rows written under it', async () => {
    let taken!: () => void;
    const lockTaken = new Promise<void>((resolve) => (taken = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = tmp.db.transaction(async (tx) => {
      await lockBotTextOverrides(tx);
      await tx.insert(botTextOverrides).values({ key: 'cardBody', source: longer('cardBody') });
      taken();
      await released;
    });
    await lockTaken;
    let settled = false;
    const pending = save('cardBonusAlready', longer('cardBonusAlready')).finally(() => {
      settled = true;
    });
    await until('the save to queue behind the lock', async () => {
      const { rows } = await tmp.db.execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      );
      return settled || (rows[0]?.waiting ?? 0) > 0;
    });
    release();
    await holder;
    expect(await pending).toMatchObject({
      ok: false,
      reason: 'refused',
      problems: [
        { key: 'cardBonusAlready', rejection: { code: 'message_overflow' } },
        { key: 'cardBody', rejection: { code: 'message_overflow' } },
      ],
    });
  });

  it('B9 lets the loaders read while a writer holds the lock', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const lockTaken = new Promise<void>((resolve) => (taken = resolve));
    const holder = tmp.db.transaction(async (tx) => {
      await lockBotTextOverrides(tx);
      taken();
      await released;
    });
    await lockTaken;
    // bounded, so a read that waits is released and reported rather than hanging the file
    const read = await Promise.race([
      listBotTextOverrides(tmp.db),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 2_000)),
    ]);
    release();
    await holder;
    expect(read).toEqual([]);
  });
});

describe('resetBotTextOverride', () => {
  it('B10 deletes the override and audits the default as the new text', async () => {
    const version = versionOf(await save('welcome', 'Привет'));
    expect(await reset('welcome', version)).toEqual({ ok: true, version: 0 });
    expect(await listBotTextOverrides(tmp.db)).toEqual([]);
    expect((await audits())[1]).toEqual({
      action: 'bot_text_reset',
      actorType: 'system',
      payload: {
        key: 'welcome',
        action: 'reset',
        oldText: 'Привет',
        newText: BOT_TEXT_CATALOG.welcome.source,
        oldVersion: version,
        newVersion: 0,
      },
    });
  });

  it('B11 reports a key already on its default without auditing', async () => {
    expect(await reset('welcome')).toEqual({ ok: false, reason: 'already_default' });
    expect(await audits()).toEqual([]);
  });

  it('B12 refuses a reset with a stale version', async () => {
    const first = versionOf(await save('welcome', 'Привет'));
    await save('welcome', 'Здравствуй');
    expect(await reset('welcome', first)).toMatchObject({ reason: 'version_conflict' });
  });

  it('B13 refuses a reset that breaks an overridden host', async () => {
    await save('connectButton', 'A');
    await save('welcome', `${'я'.repeat(1022)} {connectButton}`);
    expect(await reset('connectButton')).toMatchObject({
      reason: 'refused',
      problems: [{ key: 'welcome' }],
    });
    expect(await listBotTextOverrides(tmp.db)).toHaveLength(2);
  });

  it('removes the row of a key the catalog no longer has', async () => {
    await tmp.db.insert(botTextOverrides).values({ key: 'renamedKey', source: 'x' });
    expect(await reset('renamedKey')).toMatchObject({ ok: true });
    expect((await audits())[0]?.payload).toMatchObject({ oldText: null, newText: null });
  });
});
