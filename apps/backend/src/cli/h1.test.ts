import { describe, expect, it } from 'vitest';
import { parseH1Command } from './h1';
import { UsageError } from './trade-log';

const ACCOUNT = '0b6f0a5e-3c1d-4f6a-9b2e-7d8c9e0f1a2b';

const refused = (argv: string[]) => {
  try {
    parseH1Command(argv);
  } catch (error) {
    return error instanceof UsageError;
  }
  return false;
};

describe('parseH1Command (#670)', () => {
  it('H1-C1 mark and unmark take one account uuid', () => {
    expect(parseH1Command(['mark', ACCOUNT])).toEqual({ kind: 'mark', accountId: ACCOUNT });
    expect(parseH1Command(['unmark', ACCOUNT])).toEqual({ kind: 'unmark', accountId: ACCOUNT });
  });

  it('H1-C2 refuses a missing, malformed or second account id and any option', () => {
    for (const argv of [
      ['mark'],
      ['mark', 'not-a-uuid'],
      ['unmark', '42'],
      ['mark', ACCOUNT, ACCOUNT],
      ['mark', ACCOUNT, '--since', '24h'],
      ['unmark', '--account', ACCOUNT],
    ]) {
      expect(refused(argv), argv.join(' ')).toBe(true);
    }
  });

  it('H1-C3 list takes nothing; shadow report keeps its own parser', () => {
    expect(parseH1Command(['list'])).toEqual({ kind: 'list' });
    expect(refused(['list', ACCOUNT])).toBe(true);
    expect(refused(['list', '--all'])).toBe(true);
    expect(parseH1Command(['shadow', 'report', '--since', '24h'])).toEqual({
      kind: 'shadow_report',
      args: { since: { hours: 24 }, until: undefined },
    });
    expect(refused(['marks', ACCOUNT])).toBe(true);
  });
});

describe('parseH1Command: h1 session (#670)', () => {
  const start = (...extra: string[]) => [
    'session',
    'start',
    '--account',
    ACCOUNT,
    '--asset',
    '202',
    '--trades',
    '50',
    '--max-loss',
    '20',
    ...extra,
  ];

  it('H1-C4 session start takes the account, the pair, N trades and k', () => {
    expect(parseH1Command(start())).toEqual({
      kind: 'session_start',
      accountId: ACCOUNT,
      assetId: 202,
      trades: 50,
      maxLossMultiplier: 20,
    });
  });

  it('H1-C5 refuses trades outside 1..720, k outside 1..1000 and a missing or odd value', () => {
    const replace = (flag: string, value: string) => {
      const argv = start();
      argv[argv.indexOf(flag) + 1] = value;
      return argv;
    };
    expect(parseH1Command(replace('--trades', '720'))).toMatchObject({ trades: 720 });
    expect(parseH1Command(replace('--max-loss', '1000'))).toMatchObject({
      maxLossMultiplier: 1000,
    });
    for (const argv of [
      replace('--trades', '0'),
      replace('--trades', '721'),
      replace('--trades', '1.5'),
      replace('--trades', '05'),
      replace('--max-loss', '0'),
      replace('--max-loss', '1001'),
      replace('--max-loss', '-1'),
      replace('--asset', '0'),
      replace('--asset', 'eur'),
      replace('--account', 'nope'),
      start().slice(0, 8),
      start('extra'),
      start('--since', '24h'),
    ]) {
      expect(refused(argv), argv.join(' ')).toBe(true);
    }
  });

  it('H1-C6 session stop and status take only --account', () => {
    expect(parseH1Command(['session', 'stop', '--account', ACCOUNT])).toEqual({
      kind: 'session_stop',
      accountId: ACCOUNT,
    });
    expect(parseH1Command(['session', 'status', '--account', ACCOUNT])).toEqual({
      kind: 'session_status',
      accountId: ACCOUNT,
    });
    for (const argv of [
      ['session'],
      ['session', 'pause', '--account', ACCOUNT],
      ['session', 'stop'],
      ['session', 'stop', '--account', ACCOUNT, '--trades', '5'],
      ['session', 'status', ACCOUNT],
    ]) {
      expect(refused(argv), argv.join(' ')).toBe(true);
    }
  });
});
