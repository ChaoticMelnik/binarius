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

describe('parseH1Command (#670, #830)', () => {
  it('H1-C7 the removed commands are unknown: mark, unmark, list, shadow report', () => {
    const messageOf = (argv: string[]) => {
      try {
        parseH1Command(argv);
      } catch (error) {
        return error instanceof UsageError ? error.message : `not a UsageError: ${String(error)}`;
      }
      return 'parsed';
    };
    expect(messageOf(['mark', ACCOUNT])).toBe('неизвестная команда: mark');
    expect(messageOf(['unmark', ACCOUNT])).toBe('неизвестная команда: unmark');
    expect(messageOf(['list'])).toBe('неизвестная команда: list');
    expect(messageOf(['shadow', 'report', '--since', '24h'])).toBe('неизвестная команда: shadow');
    expect(messageOf([])).toBe('нет команды');
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
    ...extra,
  ];

  it('H1-C4′ session start takes the account, the pair and the cycles, 5 by default', () => {
    expect(parseH1Command(start())).toEqual({
      kind: 'session_start',
      accountId: ACCOUNT,
      assetId: 202,
      cycles: 5,
    });
    expect(parseH1Command(start('--cycles', '3'))).toMatchObject({ cycles: 3 });
  });

  it('H1-C5′ refuses cycles outside 1..20, a missing or odd value, and the old --trades/--max-loss', () => {
    const replace = (flag: string, value: string) => {
      const argv = start();
      argv[argv.indexOf(flag) + 1] = value;
      return argv;
    };
    expect(parseH1Command(start('--cycles', '1'))).toMatchObject({ cycles: 1 });
    expect(parseH1Command(start('--cycles', '20'))).toMatchObject({ cycles: 20 });
    for (const argv of [
      start('--cycles', '0'),
      start('--cycles', '21'),
      start('--cycles', '1.5'),
      start('--cycles', '05'),
      start('--cycles'),
      start('--trades', '50'),
      start('--max-loss', '20'),
      replace('--asset', '0'),
      replace('--asset', 'eur'),
      replace('--account', 'nope'),
      start().slice(0, 4),
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
      ['session', 'stop', '--account', ACCOUNT, '--cycles', '5'],
      ['session', 'status', ACCOUNT],
    ]) {
      expect(refused(argv), argv.join(' ')).toBe(true);
    }
  });
});
