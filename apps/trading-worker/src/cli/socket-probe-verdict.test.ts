import { decimalStringSchema } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import {
  compareDecimal,
  renderVerdict,
  verdict,
  type HeardAnswers,
  type ProbeOutcomes,
  type ProbeVerdict,
} from './socket-probe-verdict';

const heard = (openTradeSuccess: number, openTradeFail: number): HeardAnswers => ({
  openTradeSuccess,
  openTradeFail,
});
const SILENT = heard(0, 0);
const BOTH = heard(1, 1);
const SAFE: ProbeOutcomes = { command1: 'success', command2: 'fail' };

describe('verdict', () => {
  it('is sender_only only when command 1 succeeded, command 2 failed, A heard both and B nothing', () => {
    expect(verdict(SAFE, BOTH, SILENT)).toEqual({ kind: 'sender_only' });
  });

  // one row per path of the review's table (PR #282, round 1, M1)
  it.each<[string, ProbeOutcomes, HeardAnswers, string[]]>([
    [
      'command 1 timed out, so A was tainted and command 2 never went out',
      {
        command1: 'unknown',
        command2: 'not_sent',
        detail: { command1: 'aborted, ready', command2: 'not_ready, reconnecting' },
      },
      SILENT,
      [
        'command 1 did not succeed (unknown, aborted, ready)',
        'command 2 was not sent (not_sent, not_ready, reconnecting)',
        'A heard no open_trade_success',
        'A heard no open_trade_fail',
      ],
    ],
    [
      'the broker refused command 1',
      { command1: 'fail', command2: 'fail' },
      heard(0, 2),
      ['command 1 did not succeed (fail)', 'A heard no open_trade_success'],
    ],
    [
      'command 1 was not sent',
      { command1: 'not_sent', command2: 'fail', detail: { command1: 'not_ready, connecting' } },
      heard(0, 1),
      ['command 1 was not sent (not_sent, not_ready, connecting)', 'A heard no open_trade_success'],
    ],
    [
      'command 2 skipped for a minimum of 0.01 or less',
      { command1: 'success', command2: 'skipped' },
      heard(1, 0),
      ['command 2 skipped: min_trade_amount <= 0.01', 'A heard no open_trade_fail'],
    ],
    [
      'the broker accepted the below-minimum command',
      { command1: 'success', command2: 'success' },
      heard(2, 0),
      ['command 2 did not fail (success)', 'A heard no open_trade_fail'],
    ],
    [
      'command 2 unknown',
      { command1: 'success', command2: 'unknown', detail: { command2: 'aborted, ready' } },
      heard(1, 0),
      ['command 2 did not fail (unknown, aborted, ready)', 'A heard no open_trade_fail'],
    ],
    [
      'command 2 not run',
      { command1: 'success', command2: 'not_run' },
      heard(1, 0),
      ['command 2 was not run', 'A heard no open_trade_fail'],
    ],
    [
      'the outcomes say success and fail but A heard no fail',
      SAFE,
      heard(1, 0),
      ['A heard no open_trade_fail'],
    ],
    [
      'the outcomes say success and fail but A heard no success',
      SAFE,
      heard(0, 1),
      ['A heard no open_trade_success'],
    ],
  ])('is inconclusive when %s', (_label, outcomes, onA, missing) => {
    expect(verdict(outcomes, onA, SILENT)).toEqual({ kind: 'inconclusive', missing });
  });

  it.each<[string, ProbeOutcomes, HeardAnswers, HeardAnswers]>([
    ['B heard a success', SAFE, BOTH, heard(1, 0)],
    ['B heard a fail', SAFE, BOTH, heard(0, 1)],
    [
      'B heard a fail while A is inconclusive',
      { command1: 'unknown', command2: 'not_sent' },
      SILENT,
      heard(0, 1),
    ],
  ])('is broadcast when %s', (_label, outcomes, onA, onB) => {
    expect(verdict(outcomes, onA, onB)).toEqual({ kind: 'broadcast', onB });
  });
});

describe('renderVerdict', () => {
  it.each<[ProbeVerdict, string]>([
    [{ kind: 'sender_only' }, 'verdict: answers go to the sender; BROKER_WS_URL may be set'],
    [
      { kind: 'broadcast', onB: heard(1, 2) },
      'verdict: the broker broadcasts answers (B heard success=1 fail=2); keep BROKER_WS_URL unset',
    ],
    [
      {
        kind: 'inconclusive',
        missing: ['command 2 skipped: min_trade_amount <= 0.01', 'A heard no open_trade_fail'],
      },
      'verdict: inconclusive: command 2 skipped: min_trade_amount <= 0.01; A heard no open_trade_fail; keep BROKER_WS_URL unset',
    ],
  ])('renders %j as one English line', (result, line) => {
    expect(renderVerdict(result)).toBe(line);
  });
});

describe('compareDecimal', () => {
  const d = (value: string) => decimalStringSchema.parse(value);
  it.each<[string, string, -1 | 0 | 1]>([
    ['0.015', '0.01', 1],
    ['0.01', '0.010', 0],
    ['1', '0.01', 1],
    ['0.005', '0.01', -1],
    ['10.00000000', '10', 0],
    ['0.0100000001', '0.01', 1],
    ['0', '-0.00', 0],
    ['-0.02', '0.01', -1],
    ['-0.02', '-0.01', -1],
  ])('compares %s with %s exactly', (a, b, order) => {
    expect(compareDecimal(d(a), d(b))).toBe(order);
  });
});
