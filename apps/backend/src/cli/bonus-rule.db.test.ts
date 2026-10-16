import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, bonusRules, tokenLedger } from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import { runBonusRuleCli } from './bonus-rule';

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
  const code = await runBonusRuleCli(argv, { DATABASE_URL: tmp.url }, (line) => lines.push(line));
  return { code, lines };
}

const auditCount = async () => (await tmp.db.select({ id: auditLog.id }).from(auditLog)).length;

// the cases run in order on one database: the seed, a new version, its activation, refusals
describe('bonus-rule', () => {
  it('lists the seed', async () => {
    expect(await run('list')).toEqual({
      code: 0,
      lines: [
        'link_bonus v1 (link_bonus) — действует: {"tokens":"100"}',
        'referral_reward v1 (referral_reward) — действует: {"tokens":"50"}',
      ],
    });
  });

  it('creates an inactive version and activates it, one audit row each, no ledger row', async () => {
    expect(await run('new-version', 'link_bonus', '--params', '{"tokens":"150"}')).toEqual({
      code: 0,
      lines: [
        'Создана версия link_bonus v2, неактивная. Включить: bonus-rule activate link_bonus 2',
      ],
    });
    expect(await run('activate', 'link_bonus', '2')).toEqual({
      code: 0,
      lines: ['Действует link_bonus v2 (вместо v1). Уже начисленное не пересчитывается.'],
    });
    const actions = (await tmp.db.select({ action: auditLog.action }).from(auditLog)).map(
      (row) => row.action,
    );
    expect(actions).toEqual(['bonus_rule_version_created', 'bonus_rule_activated']);
    expect(await tmp.db.select().from(tokenLedger)).toEqual([]);
    expect((await run('list')).lines.slice(0, 2)).toEqual([
      'link_bonus v1 (link_bonus) — не действует: {"tokens":"100"}',
      'link_bonus v2 (link_bonus) — действует: {"tokens":"150"}',
    ]);
  });

  it.each([
    [
      'a first version without --kind',
      ['new-version', 'deposit_bonus', '--params', '{}'],
      'У правила deposit_bonus ещё нет версий: нужен --kind (link_bonus, referral_reward, deposit_bonus).',
    ],
    [
      'a kind other than the code’s',
      ['new-version', 'link_bonus', '--kind', 'deposit_bonus', '--params', '{}'],
      'Правило link_bonus — вида link_bonus; --kind должен совпадать.',
    ],
    [
      'tokens as a number',
      ['new-version', 'link_bonus', '--params', '{"tokens":150}'],
      'Параметры отклонены: tokens: Invalid input: expected string, received number.',
    ],
    [
      'tokens over the cap',
      ['new-version', 'link_bonus', '--params', '{"tokens":"1001"}'],
      'Параметры отклонены: tokens: expected at most 1000 tokens.',
    ],
    ['an unknown version', ['activate', 'link_bonus', '9'], 'Версии link_bonus v9 нет.'],
    ['the active version', ['activate', 'link_bonus', '2'], 'link_bonus v2 уже действует.'],
    ['an unknown code', ['deactivate', 'nothing'], 'Правила nothing нет.'],
  ])('refuses %s with exit 1 and writes nothing', async (_label, argv, line) => {
    const before = await auditCount();
    const rules = (await tmp.db.select({ id: bonusRules.id }).from(bonusRules)).length;
    expect(await run(...argv)).toEqual({ code: 1, lines: [line] });
    expect(await auditCount()).toBe(before);
    expect((await tmp.db.select({ id: bonusRules.id }).from(bonusRules)).length).toBe(rules);
  });

  it('deactivates, then refuses a second deactivation', async () => {
    expect(await run('deactivate', 'link_bonus')).toEqual({
      code: 0,
      lines: ['link_bonus v2 больше не действует; начисления по правилу остановлены.'],
    });
    expect(await run('deactivate', 'link_bonus')).toEqual({
      code: 1,
      lines: ['У правила link_bonus нет действующей версии.'],
    });
    const [row] = await tmp.db
      .select({ action: auditLog.action, payload: auditLog.payload })
      .from(auditLog)
      .where(eq(auditLog.action, 'bonus_rule_deactivated'));
    expect(row).toEqual({
      action: 'bonus_rule_deactivated',
      payload: { code: 'link_bonus', version: 2 },
    });
    expect(await run('activate', 'link_bonus', '1')).toEqual({
      code: 0,
      lines: ['Действует link_bonus v1. Уже начисленное не пересчитывается.'],
    });
  });
});
