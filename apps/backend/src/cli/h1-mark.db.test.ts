import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuditAction,
  buildH1SessionSettings,
  decimalStringSchema,
  SessionStakeStrategy,
} from '@binarius/shared';
import { auditLog } from '@binarius/db';
import {
  brokerAccountRow,
  createTempDatabase,
  seedTradingSession,
  seedUserWithAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import { runH1Cli } from './h1';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

async function run(argv: string[], env: NodeJS.ProcessEnv = { DATABASE_URL: tmp.url }) {
  let out = '';
  const err: string[] = [];
  const code = await runH1Cli(
    argv,
    env,
    (text) => (out += text),
    (line) => err.push(line),
  );
  return { code, out, err };
}

const h1Settings = () => {
  const built = buildH1SessionSettings({
    assetId: 101,
    cycles: 5,
    stake: { baseStake: decimalStringSchema.parse('1'), stakeScale: 2 },
    strategy: SessionStakeStrategy.Martingale,
  });
  if (!built.success) throw new Error('H1 fixture settings do not parse');
  return built.data;
};

// the CLI's audit rows (#745): setH1Mark writes none, the command writes one per change
const auditRows = (accountId: string) =>
  tmp.db
    .select({ action: auditLog.action, payload: auditLog.payload, actorType: auditLog.actorType })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'broker_account'), eq(auditLog.entityId, accountId)))
    .orderBy(asc(auditLog.createdAt));

describe('h1 mark, unmark, list (#670)', () => {
  it('H1-R1 marks, lists, keeps the mark under an active H1 session, unmarks', async () => {
    expect(await run(['list'])).toEqual({ code: 0, out: '', err: ['помеченных аккаунтов нет'] });

    const seed = await seedUserWithAccount(tmp.db);
    const id = seed.brokerAccountId;
    expect(await run(['mark', id])).toEqual({
      code: 0,
      out: '',
      err: ['аккаунт помечен для сессий H1'],
    });
    const since = (await brokerAccountRow(tmp.db, id)).h1Since!;
    expect((await run(['mark', id])).err).toEqual(['без изменений: метка уже такая']);

    const session = await seedTradingSession(tmp.db, id, { settings: h1Settings() });
    const listed = await run(['list']);
    expect(listed.code).toBe(0);
    expect(listed.out).toBe(
      `${[id, since.toISOString(), 'active', '-', seed.telegramUserId, 'demo', session.id].join('\t')}\n`,
    );
    expect(listed.err).toEqual(['аккаунтов: 1']);

    expect(await run(['unmark', id])).toEqual({
      code: 1,
      out: '',
      err: [`у аккаунта активная сессия H1: сначала h1 session stop --account ${id}`],
    });
    await tmp.pool.query(
      `update trading_sessions set status = 'stopped', stop_reason = 'user_stopped', ended_at = now() where id = $1`,
      [session.id],
    );
    expect((await run(['unmark', id])).err).toEqual(['метка H1 снята']);
    expect((await brokerAccountRow(tmp.db, id)).h1Since).toBeNull();
    expect((await run(['unmark', id])).code).toBe(0);
    // one row per change, none for a re-mark, the refused unmark or a second unmark
    expect(await auditRows(id)).toEqual([
      {
        action: AuditAction.BrokerAccountH1Set,
        payload: { accountId: id, result: 'marked' },
        actorType: 'system',
      },
      {
        action: AuditAction.BrokerAccountH1Cleared,
        payload: { accountId: id, result: 'unmarked' },
        actorType: 'system',
      },
    ]);

    expect(await run(['mark', randomUUID()])).toEqual({
      code: 1,
      out: '',
      err: ['аккаунт брокера не найден'],
    });
    const usage = await run(['mark', 'nope']);
    expect(usage.code).toBe(2);
    expect(usage.err.at(-1)).toContain('h1 mark <accountId>');
    expect((await run(['list'], {})).code).toBe(1);
  });
});
