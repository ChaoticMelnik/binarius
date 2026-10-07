import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// T8 (#144): only an operator opens trading. No CHECK holds it yet (#96 adds one with the first
// source that must never open), so the rule is that openTrading is the only non-test source that
// writes trading_enabled = true, and the seed migration is the only SQL that does. A new writer
// fails this list until someone decides it belongs here.
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const ALLOWED = ['packages/db/src/trading-switch-ops.ts'];
const OPEN_WRITE = String.raw`tradingEnabled: true|trading_enabled"? *= *true`;

describe('writers of an open trading switch', () => {
  it('T8 only openTrading writes trading_enabled = true outside tests', () => {
    let out = '';
    try {
      out = execFileSync(
        'git',
        [
          'grep',
          '--untracked',
          '-l',
          '-E',
          OPEN_WRITE,
          '--',
          'apps',
          'packages',
          'tooling',
          ':!*.test.ts',
          ':!*/drizzle/*',
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      );
    } catch (error) {
      // git grep exits 1 when nothing matches
      if ((error as { status?: number }).status !== 1) throw error;
    }
    expect(
      out
        .split('\n')
        .filter((line) => line !== '')
        .sort(),
    ).toEqual(ALLOWED);
  });
});
