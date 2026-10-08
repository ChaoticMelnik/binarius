import type { BrokerRestErrorCode, DecimalString } from '@binarius/shared';
import { BrokerSocketState, type SocketOpenTradeResult } from '../broker/socket';

// The two-socket probe's verdict (#285, docs/broker-socket.md -> Observed live), a pure function
// of what socket-probe-run.ts observed. Any open_trade answer heard by a socket that did not send
// the phase's command (both sockets in the REST phase) is a broadcast, whatever else happened.
// Otherwise the run is safe only when every condition held; each one that did not is named.

export const PROBE_SOCKETS = ['A', 'B'] as const;
export type ProbeSocket = (typeof PROBE_SOCKETS)[number];

// in run order
export const PROBE_PHASES = ['a_min', 'a_below', 'b_min', 'b_below', 'rest_min'] as const;
export type Phase = (typeof PROBE_PHASES)[number];

export const PHASE_SENDER = {
  a_min: 'A',
  a_below: 'A',
  b_min: 'B',
  b_below: 'B',
  rest_min: 'rest',
} as const satisfies Record<Phase, ProbeSocket | 'rest'>;

const EXPECTED_OUTCOME = {
  a_min: 'success',
  a_below: 'fail',
  b_min: 'success',
  b_below: 'fail',
  rest_min: 'success',
} as const satisfies Record<Phase, 'success' | 'fail'>;

export type SocketCommandOutcome = SocketOpenTradeResult['outcome'] | 'skipped' | 'not_run';
export type RestCommandOutcome = 'success' | BrokerRestErrorCode | 'threw' | 'not_run';

export interface HeardAnswers {
  openTradeSuccess: number;
  openTradeFail: number;
}

export interface PhaseRecord {
  command: SocketCommandOutcome | RestCommandOutcome;
  // "reason, state" of a not_sent/unknown answer, for the message only
  detail?: string;
  heard: Record<ProbeSocket, HeardAnswers>;
  windowCompleted: boolean;
}

export interface SocketContinuity {
  state: BrokerSocketState;
  // taken once both sockets were verified, before command 1
  connectionsBefore: number;
  connectionsAfter: number;
  // every transition out of ready during the run, as "ready -> <state> (<reason>)"
  leftReady: string[];
}

export interface VerdictInput {
  userDataVerified: Record<ProbeSocket, boolean>;
  phases: Record<Phase, PhaseRecord>;
  sockets: Record<ProbeSocket, SocketContinuity>;
}

export interface CrossSocketAnswer {
  phase: Phase;
  socket: ProbeSocket;
  answers: HeardAnswers;
}

export type ProbeVerdict =
  | { kind: 'sender_only' }
  | { kind: 'broadcast'; heard: CrossSocketAnswer[] }
  | { kind: 'inconclusive'; missing: string[] };

const REST_FAILURE = {
  unauthorized: 'the token was refused',
  rate_limited: 'rate limited',
  rejected: 'the broker refused the order',
  unavailable: 'no answer, the order may be open',
  contract_violation: 'the answer failed the schema, the order may be open',
  aborted: 'aborted, the order may be open',
} as const satisfies Record<BrokerRestErrorCode, string>;

const isRestFailure = (outcome: string): outcome is BrokerRestErrorCode =>
  Object.hasOwn(REST_FAILURE, outcome);

const heardAny = (answers: HeardAnswers) =>
  answers.openTradeSuccess > 0 || answers.openTradeFail > 0;

function outcomeMissing(phase: Phase, record: PhaseRecord): string | undefined {
  const expected = EXPECTED_OUTCOME[phase];
  const { command, detail } = record;
  if (command === expected) return undefined;
  if (command === 'skipped') return `${phase}: skipped, min_trade_amount <= 0.01`;
  if (command === 'not_run') return `${phase}: not run`;
  const why = isRestFailure(command) ? REST_FAILURE[command] : detail;
  return `${phase}: expected ${expected}, got ${command}${why === undefined ? '' : ` (${why})`}`;
}

function senderMissing(phase: Phase, record: PhaseRecord): string | undefined {
  const sender = PHASE_SENDER[phase];
  if (sender === 'rest') return undefined;
  const heard = record.heard[sender];
  if (EXPECTED_OUTCOME[phase] === 'success') {
    return heard.openTradeSuccess > 0
      ? undefined
      : `${phase}: ${sender} heard no open_trade_success`;
  }
  return heard.openTradeFail > 0 ? undefined : `${phase}: ${sender} heard no open_trade_fail`;
}

function continuityMissing(socket: ProbeSocket, continuity: SocketContinuity): string | undefined {
  const deviations = [
    continuity.state === BrokerSocketState.Ready ? undefined : `state ${continuity.state}`,
    continuity.connectionsAfter === continuity.connectionsBefore
      ? undefined
      : `connections ${continuity.connectionsBefore} -> ${continuity.connectionsAfter}`,
    ...continuity.leftReady,
  ].filter((deviation): deviation is string => deviation !== undefined);
  return deviations.length === 0
    ? undefined
    : `${socket} was not connected throughout (${deviations.join('; ')})`;
}

export function verdict(input: VerdictInput): ProbeVerdict {
  const heard: CrossSocketAnswer[] = [];
  for (const phase of PROBE_PHASES) {
    for (const socket of PROBE_SOCKETS) {
      const answers = input.phases[phase].heard[socket];
      if (socket !== PHASE_SENDER[phase] && heardAny(answers)) {
        heard.push({ phase, socket, answers });
      }
    }
  }
  if (heard.length > 0) return { kind: 'broadcast', heard };

  const missing = [
    ...PROBE_SOCKETS.map((socket) =>
      input.userDataVerified[socket]
        ? undefined
        : `user.data on ${socket} did not match the account before command 1`,
    ),
    ...PROBE_PHASES.flatMap((phase) => {
      const record = input.phases[phase];
      return [
        outcomeMissing(phase, record),
        senderMissing(phase, record),
        record.windowCompleted ? undefined : `${phase}: the window did not complete`,
      ];
    }),
    ...PROBE_SOCKETS.map((socket) => continuityMissing(socket, input.sockets[socket])),
  ].filter((reason): reason is string => reason !== undefined);
  return missing.length === 0 ? { kind: 'sender_only' } : { kind: 'inconclusive', missing };
}

export function renderVerdict(result: ProbeVerdict): string {
  switch (result.kind) {
    case 'sender_only':
      return 'verdict: no cross-socket answer within the window; BROKER_WS_URL may be set';
    case 'broadcast': {
      const heard = result.heard
        .map(
          ({ phase, socket, answers }) =>
            `${phase}: ${socket} heard success=${answers.openTradeSuccess} fail=${answers.openTradeFail}`,
        )
        .join('; ');
      return `verdict: the broker sends answers to another socket (${heard}); keep BROKER_WS_URL unset`;
    }
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
