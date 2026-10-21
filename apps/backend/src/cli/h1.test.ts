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
