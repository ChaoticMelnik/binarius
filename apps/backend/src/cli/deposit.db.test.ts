import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerAccountStatus, PostbackSource } from '@binarius/shared';
import { recordPostback } from '@binarius/db';
import {
  createTempDatabase,
  seedBrokerAccount,
  seedUser,
  type TempDatabase,
} from '@binarius/db/testing';
import { DEPOSIT_LIST_MAX, runDepositCli } from './deposit';

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
  const code = await runDepositCli(argv, { DATABASE_URL: tmp.url }, (line) => lines.push(line));
  return { code, lines };
}
const deliver = (query: Record<string, string>) =>
  recordPostback(tmp.db, { source: PostbackSource.Binodex, query });

const ISO = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`;

// the cases run in order on one database: empty first, then the fixtures
describe('deposit', () => {
  it('list on an empty journal points at the deposits page', async () => {
    expect(await run('list')).toEqual({
      code: 0,
      lines: ['Доставок нет. Депозиты — на странице /admin/deposits.'],
    });
  });

  it('list prints the journal newest first, refusals included', async () => {
    await deliver({ event: 'deposit', id: 'pb-1', payment_id: 'pay-1', a: '101962', amount: 'x' });
    await deliver({
      event: 'deposit',
      id: 'pb-1',
      payment_id: 'pay-1',
      a: '101962',
      amount: '10.50',
    });
    await deliver({ event: 'ftd', id: 'pb-2', payment_id: 'pay-1', a: '101962', amount: '10.50' });

    const { code, lines } = await run('list');

    expect(code).toBe(0);
    expect(lines[0]).toBe('Доставки постбэков, новые сверху (3):');
    const rows = lines.slice(1).map((line) => line.replace(new RegExp(`^${ISO}  `), 'T  '));
    expect(rows).toEqual([
      'T  ftd  постбэк pb-2  repeated  платёж pay-1  трейдер 101962  сумма 10.50',
      'T  deposit  постбэк pb-1  recorded  платёж pay-1  трейдер 101962  сумма 10.50',
      'T  deposit  постбэк pb-1  rejected: invalid_amount  платёж pay-1  трейдер 101962  сумма x',
    ]);
    expect((await run('list', '--limit', '1')).lines).toHaveLength(2);
  });

  it('show prints the deposit and each delivery with its parameters', async () => {
    const user = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, user.userId, {
      status: BrokerAccountStatus.Active,
      brokerUserId: 'trader-owned',
    });
    await deliver({
      event: 'deposit',
      id: 'pb-o',
      payment_id: 'pay-o',
      a: 'trader-owned',
      amount: '7',
      coin: 'USD',
    });
    await deliver({ event: 'ftd', id: 'pb-o-bad', payment_id: 'pay-o', amount: '7' });

    const { code, lines } = await run('show', 'pay-o');

    expect(code).toBe(0);
    expect(lines.slice(0, 7)).toEqual([
      'Депозит по платежу pay-o:',
      '  трейдер trader-owned',
      '  сумма 7.00000000 USD',
      '  статус received',
      `  владелец (Telegram ID) ${user.telegramUserId}`,
      expect.stringMatching(/^ {2}аккаунт [0-9a-f-]{36}$/),
      expect.stringMatching(new RegExp(`^  записан ${ISO}$`)),
    ]);
    expect(lines[7]).toBe('Доставки (2):');
    expect(lines[8]).toMatch(/deposit {2}постбэк pb-o {2}recorded/);
    expect(lines).toContain('    coin=USD');
    expect(lines.find((l) => l.includes('pb-o-bad'))).toMatch(/rejected: missing_trader_id/);
  });

  it('show prints an unowned deposit with none for the owner and the account', async () => {
    await deliver({ event: 'deposit', id: 'pb-u', payment_id: 'pay-u', a: 'nobody', amount: '1' });
    const { lines } = await run('show', 'pay-u');
    expect(lines).toContain('  владелец (Telegram ID) —');
    expect(lines).toContain('  аккаунт —');
    expect(lines).toContain('  сумма 1.00000000 —');
  });

  it('show of a payment with only refused deliveries prints them', async () => {
    await deliver({ event: 'deposit', id: 'pb-r', payment_id: 'pay-r', a: 't', amount: '-1' });
    const { code, lines } = await run('show', 'pay-r');
    expect(code).toBe(0);
    expect(lines[0]).toBe('Депозита по платежу pay-r нет: все его доставки отклонены.');
    expect(lines[1]).toBe('Доставки (1):');
  });

  it('show of an unknown payment exits 1', async () => {
    expect(await run('show', 'pay-none')).toEqual({
      code: 1,
      lines: ['Платёж pay-none не найден: ни депозита, ни доставок.'],
    });
  });

  it('prints a control character of a payload as ?', async () => {
    await deliver({
      event: 'deposit',
      id: 'pb-c',
      payment_id: 'pay-c',
      a: 't\u001b[31m',
      amount: '1',
    });
    const { lines } = await run('show', 'pay-c');
    expect(lines).toContain('    a=t?[31m');
    expect(lines.join('\n')).not.toContain('\u001b');
  });

  it.each([
    [[]],
    [['list', '--limit', '0']],
    [['list', '--limit', String(DEPOSIT_LIST_MAX + 1)]],
    [['list', '--limit', 'ten']],
    [['list', 'extra']],
    [['show']],
    [['show', 'a', 'b']],
    [['show', 'a', '--limit', '3']],
    [['purge']],
    [['list', '--unknown']],
  ])('refuses %j with exit 2 and the usage', async (argv) => {
    const { code, lines } = await run(...argv);
    expect(code).toBe(2);
    expect(lines[1]).toMatch(/^Журнал постбэков брокера/);
  });

  it('exits 1 on an unreachable database, by name and code only', async () => {
    const lines: string[] = [];
    const code = await runDepositCli(
      ['list'],
      { DATABASE_URL: 'postgres://nobody:secret-pass@127.0.0.1:1/none' },
      (line) => lines.push(line),
    );
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Не удалось прочитать журнал: /);
    expect(lines[0]).not.toContain('secret-pass');
  });
});
