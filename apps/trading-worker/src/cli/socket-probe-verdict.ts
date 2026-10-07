import type { DecimalString } from '@binarius/shared';
import type { SocketOpenTradeResult } from '../broker/socket';

// The two-socket probe's verdict (socket-probe.ts, docs/broker-socket.md → Observed live), pure so
// every path is tested. B's silence means something only when A was answered both ways: the safe
// verdict needs command 1 → success, command 2 sent → fail, A having heard both answers, and B
// none. Anything B heard is a broadcast whatever A did; every other run is inconclusive.

export type ProbeCommandOutcome = SocketOpenTradeResult['outcome'] | 'skipped' | 'not_run';

export interface ProbeOutcomes {
  command1: ProbeCommandOutcome;
  command2: ProbeCommandOutcome;
  // "reason, state" of a not_sent/unknown answer, for the message only
  detail?: { command1?: string; command2?: string };
}

export interface HeardAnswers {
  openTradeSuccess: number;
  openTradeFail: number;
}

export type ProbeVerdict =
  | { kind: 'sender_only' }
  | { kind: 'broadcast'; onB: HeardAnswers }
  | { kind: 'inconclusive'; missing: string[] };

const withDetail = (head: string, detail: string | undefined) =>
  detail === undefined ? head : `${head}, ${detail}`;

function command1Missing(outcome: ProbeCommandOutcome, detail?: string): string | undefined {
  switch (outcome) {
    case 'success':
      return undefined;
    case 'not_sent':
      return `command 1 was not sent (${withDetail(outcome, detail)})`;
    case 'not_run':
    case 'skipped':
      return 'command 1 was not run';
    default:
      return `command 1 did not succeed (${withDetail(outcome, detail)})`;
  }
}

function command2Missing(outcome: ProbeCommandOutcome, detail?: string): string | undefined {
  switch (outcome) {
    case 'fail':
      return undefined;
    case 'skipped':
      return 'command 2 skipped: min_trade_amount <= 0.01';
    case 'not_sent':
      return `command 2 was not sent (${withDetail(outcome, detail)})`;
    case 'not_run':
      return 'command 2 was not run';
    default:
      return `command 2 did not fail (${withDetail(outcome, detail)})`;
  }
}

export function verdict(
  outcomes: ProbeOutcomes,
  heardA: HeardAnswers,
  heardB: HeardAnswers,
): ProbeVerdict {
  if (heardB.openTradeSuccess > 0 || heardB.openTradeFail > 0) {
    return { kind: 'broadcast', onB: heardB };
  }
  const missing = [
    command1Missing(outcomes.command1, outcomes.detail?.command1),
    command2Missing(outcomes.command2, outcomes.detail?.command2),
    heardA.openTradeSuccess < 1 ? 'A heard no open_trade_success' : undefined,
    heardA.openTradeFail < 1 ? 'A heard no open_trade_fail' : undefined,
  ].filter((reason): reason is string => reason !== undefined);
  return missing.length === 0 ? { kind: 'sender_only' } : { kind: 'inconclusive', missing };
}

export function renderVerdict(result: ProbeVerdict): string {
  switch (result.kind) {
    case 'sender_only':
      return 'verdict: answers go to the sender; BROKER_WS_URL may be set';
    case 'broadcast':
      return `verdict: the broker broadcasts answers (B heard success=${result.onB.openTradeSuccess} fail=${result.onB.openTradeFail}); keep BROKER_WS_URL unset`;
    case 'inconclusive':
      return `verdict: inconclusive: ${result.missing.join('; ')}; keep BROKER_WS_URL unset`;
  }
}

function magnitude(value: string): { negative: boolean; integer: bigint; fraction: string } {
  const negative = value.startsWith('-');
  const [integer = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return { negative, integer: BigInt(integer), fraction: fraction.replace(/0+$/, '') };
}

function compareMagnitude(a: ReturnType<typeof magnitude>, b: ReturnType<typeof magnitude>) {
  if (a.integer !== b.integer) return a.integer < b.integer ? -1 : 1;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const fa = BigInt(a.fraction.padEnd(width, '0') || '0');
  const fb = BigInt(b.fraction.padEnd(width, '0') || '0');
  if (fa === fb) return 0;
  return fa < fb ? -1 : 1;
}

// exact, at any scale: no float and no truncation
export function compareDecimal(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  const ma = magnitude(a);
  const mb = magnitude(b);
  const zeroA = ma.integer === 0n && ma.fraction === '';
  const zeroB = mb.integer === 0n && mb.fraction === '';
  const negativeA = ma.negative && !zeroA;
  const negativeB = mb.negative && !zeroB;
  if (negativeA !== negativeB) return negativeA ? -1 : 1;
  const order = compareMagnitude(ma, mb);
  return negativeA ? ((-order || 0) as -1 | 0 | 1) : order;
}
