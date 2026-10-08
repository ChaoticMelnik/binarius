import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditAction } from '@binarius/shared';
import { auditLog, tradingSwitch } from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import { runKillSwitchCli } from './kill-switch';

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

async function run(...argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runKillSwitchCli(argv, { DATABASE_URL: tmp.url }, (line) => lines.push(line));
  return { code, lines };
}

const ISO = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`;

// the cases run in order on one database: the seed, on, on again, off, off again, a lost row
describe('kill-switch', () => {
  it('status on a fresh database: open, written by the migration', async () => {
    const { code, lines } = await run('status');
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^Торговля открыта \\(с ${ISO}, источник migration\\)$`));
  });

  it('off on the open seed: already open, exit 0, no audit row', async () => {
    const { code, lines } = await run('off');
    expect(code).toBe(0);
    expect(lines[0]).toMatch(
      new RegExp(`^Торговля уже открыта \\(с ${ISO}, источник migration\\)$`),
    );
  });

  it('on closes trading, prints what goes on, and status shows the reason', async () => {
    const on = await run('on', '--reason', 'инцидент брокера');
    expect(on).toEqual({
      code: 0,
      lines: [
        'Торговля остановлена. Новые заявки отклоняются; уже открытые сделки, сверка и расчёт продолжаются.',
      ],
    });
    const status = await run('status');
    expect(status.lines[0]).toMatch(
      new RegExp(`^Торговля остановлена \\(с ${ISO}, источник operator\\): инцидент брокера$`),
    );
  });

  it('on again: already closed with the first reason, exit 0', async () => {
    const { code, lines } = await run('on', '--reason', 'вторая');
    expect(code).toBe(0);
    expect(lines[0]).toMatch(
      new RegExp(`^Торговля уже остановлена \\(с ${ISO}, источник operator\\): инцидент брокера$`),
    );
  });

  it('off opens trading for demo and real; off again says so', async () => {
    expect(await run('off', '--reason', 'брокер в норме')).toEqual({
      code: 0,
      lines: ['Торговля открыта — demo и real.'],
    });
    expect((await run('off')).lines[0]).toMatch(
      new RegExp(`^Торговля уже открыта \\(с ${ISO}, источник operator\\)$`),
    );
  });

  it('wrote exactly two audit rows, one per change', async () => {
    const rows = await tmp.db
      .select({ action: auditLog.action, payload: auditLog.payload })
      .from(auditLog)
      .where(
        sql`${auditLog.action} in (${AuditAction.TradingStopped}, ${AuditAction.TradingResumed})`,
      )
      .orderBy(auditLog.createdAt);
    expect(rows).toEqual([
      {
        action: 'trading_stopped',
        payload: { via: 'cli', source: 'operator', reason: 'инцидент брокера' },
      },
      { action: 'trading_resumed', payload: { via: 'cli', reason: 'брокер в норме' } },
    ]);
  });

  it('status without the row: stopped, exit 0', async () => {
    await tmp.db.delete(tradingSwitch);
    expect(await run('status')).toEqual({
      code: 0,
      lines: ['Строки переключателя нет — торговля остановлена'],
    });
  });
});

describe('kill-switch against an unreachable database', () => {
  it('exits 1 once with the status hint, no throw and no driver message', async () => {
    const lines: string[] = [];
    const code = await runKillSwitchCli(
      ['on', '--reason', 'проверка'],
      { DATABASE_URL: 'postgres://binarius:secret@127.0.0.1:1/binarius' },
      (line) => lines.push(line),
    );
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^Не удалось выполнить команду: \S.*\. Состояние могло измениться — проверьте командой status\.$/,
    );
    expect(lines[0]).toContain('ECONNREFUSED');
    expect(lines[0]).not.toMatch(/secret|127\.0\.0\.1|connect/);
  });

  it('status says only that the read failed', async () => {
    const lines: string[] = [];
    const code = await runKillSwitchCli(
      ['status'],
      { DATABASE_URL: 'postgres://binarius@127.0.0.1:1/binarius' },
      (line) => lines.push(line),
    );
    expect(code).toBe(1);
    expect(lines).toEqual(['Не удалось прочитать состояние: Error (Error ECONNREFUSED).']);
  });
});
