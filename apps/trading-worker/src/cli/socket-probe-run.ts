import { BrokerRestError, MAX_DETAIL_LENGTH, type BrokerRestClient } from '@binarius/broker-rest';
import {
  decimalStringSchema,
  TradeAction,
  TradeMode,
  type BinaryPair,
  type DecimalString,
  type SocketOpenTradeRequest,
} from '@binarius/shared';
import { BrokerEventType, type BrokerEvent } from '../broker/events';
import {
  BrokerSocketState,
  type BrokerCredentials,
  type BrokerSocketClient,
  type SocketOpenTradeResult,
} from '../broker/socket';
import {
  compareDecimal,
  PHASE_SENDER,
  PROBE_PHASES,
  PROBE_SOCKETS,
  type HeardAnswers,
  type Phase,
  type PhaseRecord,
  type ProbeSocket,
  type SocketContinuity,
  type VerdictInput,
} from './socket-probe-verdict';

// The wiring of the two-socket probe (#285, docs/broker-socket.md -> Observed live): two sockets
// A and B of one account, verified by user.data, then five phases one after another: A at
// min_trade_amount, A below it, B at it, B below it, and one REST order at it. After each answer
// the probe listens for a window; whatever a socket hears is counted into the phase in progress.
// Writes nothing to the database. Prints event types, counts, trade ids, outcomes and the
// broker's fail messages only: never the token, a URL or a payload.

export interface ProbeTiming {
  readyTimeoutMs: number;
  commandTimeoutMs: number;
  windowMs: number;
}

export interface ProbeDeps {
  openClient(label: ProbeSocket): BrokerSocketClient;
  rest: Pick<BrokerRestClient, 'openTrade'>;
  credentials: BrokerCredentials;
  now(): number;
  sleep(ms: number): Promise<void>;
  say(line: string): void;
  timing: ProbeTiming;
}

export type ProbeRun =
  { kind: 'setup_failed'; what: string } | { kind: 'ran'; input: VerdictInput };

const BELOW_MINIMUM = decimalStringSchema.parse('0.01');
const WAIT_STEP_MS = 50;

export const PROBE_PRECONDITIONS = [
  'preconditions (a step of the operator, not checked by the probe):',
  '- broker-web of this account is closed and no trade is opened by hand during the run',
  '- the worker keeps no socket session of this account (BROKER_WS_URL unset in its .env)',
  '- the account has no active intent and no running trading session',
  'the probe opens up to three demo trades of min_trade_amount (not_ours for the catch-up)',
];

type Row = 'setup' | Phase;

interface Recorder {
  // event type -> count, per row of the table
  counts: Map<Row, Map<string, number>>;
  tradeIds: string[];
  user?: { id: string; minTradeAmount: DecimalString };
  mismatch: boolean;
  pairs?: BinaryPair[];
  leftReady: string[];
}

const cut = (text: string) => text.slice(0, MAX_DETAIL_LENGTH);

function describeResult(result: SocketOpenTradeResult): string {
  switch (result.outcome) {
    case 'success':
      return `success, trade ${result.trade.id}`;
    case 'fail':
      return `fail: ${result.failures.map((failure) => cut(failure.message)).join('; ')}`;
    case 'not_sent':
    case 'unknown':
      return `${result.outcome} (${result.reason}, ${result.state})`;
  }
}

export async function runProbe(deps: ProbeDeps): Promise<ProbeRun> {
  const { timing, say } = deps;
  let row: Row = 'setup';
  const recorders = {} as Record<ProbeSocket, Recorder>;
  const clients = {} as Record<ProbeSocket, BrokerSocketClient>;

  for (const socket of PROBE_SOCKETS) {
    const client = deps.openClient(socket);
    const recorder: Recorder = { counts: new Map(), tradeIds: [], mismatch: false, leftReady: [] };
    client.onState((change) => {
      if (change.from === BrokerSocketState.Ready && change.to !== BrokerSocketState.Ready) {
        const reason = change.reason === undefined ? '' : ` (${change.reason})`;
        recorder.leftReady.push(`ready -> ${change.to}${reason}`);
      }
    });
    client.onEvent((event: BrokerEvent) => {
      const counts = recorder.counts.get(row) ?? new Map<string, number>();
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
      recorder.counts.set(row, counts);
      if (event.type === BrokerEventType.OpenTradeSuccess) recorder.tradeIds.push(event.trade.id);
      if (event.type === BrokerEventType.CloseTradeSuccess) {
        for (const trade of event.trades) recorder.tradeIds.push(trade.id);
      }
      if (event.type === BrokerEventType.UserData && recorder.user === undefined) {
        if (event.user.id === deps.credentials.brokerUserId) {
          recorder.user = { id: event.user.id, minTradeAmount: event.user.minTradeAmount };
        } else {
          recorder.mismatch = true;
        }
      }
      if (event.type === BrokerEventType.AssetsList) recorder.pairs = event.pairs;
    });
    clients[socket] = client;
    recorders[socket] = recorder;
  }
  for (const socket of PROBE_SOCKETS) clients[socket].start(deps.credentials);

  const deadline = deps.now() + timing.readyTimeoutMs;
  for (;;) {
    const mismatched = PROBE_SOCKETS.find((socket) => recorders[socket].mismatch);
    if (mismatched !== undefined) {
      return { kind: 'setup_failed', what: `user.data id mismatch on ${mismatched}` };
    }
    const missing = [
      ...PROBE_SOCKETS.flatMap((socket) => [
        clients[socket].state === BrokerSocketState.Ready ? undefined : `${socket} ready`,
        recorders[socket].user === undefined ? `user.data on ${socket}` : undefined,
      ]),
      recorders.A.pairs === undefined ? 'assets_list on A' : undefined,
    ].filter((fact): fact is string => fact !== undefined);
    if (missing.length === 0) break;
    if (deps.now() >= deadline) {
      return {
        kind: 'setup_failed',
        what: `not within ${timing.readyTimeoutMs} ms: ${missing.join(', ')}`,
      };
    }
    await deps.sleep(WAIT_STEP_MS);
  }

  const connectionsBefore = {
    A: clients.A.connections,
    B: clients.B.connections,
  } satisfies Record<ProbeSocket, number>;
  const userDataVerified = {
    A: recorders.A.user !== undefined,
    B: recorders.B.user !== undefined,
  } satisfies Record<ProbeSocket, boolean>;
  const minimum = recorders.A.user?.minTradeAmount;
  const pair = recorders.A.pairs?.find((p) => p.scheduledUntil === 0 && p.payout > 0);
  if (minimum === undefined || pair === undefined) {
    return { kind: 'setup_failed', what: 'no tradable pair in common.assets_list' };
  }
  for (const line of PROBE_PRECONDITIONS) say(line);

  const request = (amount: DecimalString): SocketOpenTradeRequest => ({
    assetId: pair.id,
    action: TradeAction.Up,
    durationSec: pair.minTimeframe,
    amount,
  });
  const records = {} as Record<Phase, Omit<PhaseRecord, 'heard'>>;

  async function listen(phase: Phase) {
    const answeredAt = deps.now();
    for (let left = timing.windowMs; left > 0; left = timing.windowMs - (deps.now() - answeredAt)) {
      await deps.sleep(left);
    }
    records[phase].windowCompleted = deps.now() - answeredAt >= timing.windowMs;
  }

  for (const phase of PROBE_PHASES) {
    const sender = PHASE_SENDER[phase];
    row = phase;
    if (sender === 'rest') {
      records[phase] = { command: 'not_run', windowCompleted: false };
      try {
        const trade = await deps.rest.openTrade(
          { accessToken: deps.credentials.accessToken },
          { ...request(minimum), isDemo: true },
          { signal: AbortSignal.timeout(timing.commandTimeoutMs) },
        );
        records[phase].command = 'success';
        say(`${phase} (REST, demo, min_trade_amount): success, trade ${trade.id}`);
      } catch (error) {
        if (error instanceof BrokerRestError) {
          records[phase].command = error.code;
          const detail = error.detail === undefined ? '' : `: ${cut(error.detail)}`;
          say(`${phase} (REST, demo, min_trade_amount): ${error.code}${detail}`);
        } else {
          records[phase].command = 'threw';
          say(`${phase} (REST, demo, min_trade_amount): threw`);
        }
      }
      await listen(phase);
      continue;
    }

    const below = phase.endsWith('_below');
    const label = `${phase} (${sender}, demo, ${below ? 'below the minimum' : 'min_trade_amount'})`;
    if (below && compareDecimal(minimum, BELOW_MINIMUM) <= 0) {
      records[phase] = { command: 'skipped', windowCompleted: false };
      say(`${label}: skipped, min_trade_amount <= 0.01`);
    } else {
      const result = await clients[sender].openTrade(
        TradeMode.Demo,
        request(below ? BELOW_MINIMUM : minimum),
        AbortSignal.timeout(timing.commandTimeoutMs),
      );
      records[phase] = {
        command: result.outcome,
        windowCompleted: false,
        ...(result.outcome === 'not_sent' || result.outcome === 'unknown'
          ? { detail: `${result.reason}, ${result.state}` }
          : {}),
      };
      say(`${label}: ${describeResult(result)}`);
    }
    await listen(phase);
  }

  const answers = (phase: Phase, socket: ProbeSocket): HeardAnswers => {
    const counts = recorders[socket].counts.get(phase);
    return {
      openTradeSuccess: counts?.get(BrokerEventType.OpenTradeSuccess) ?? 0,
      openTradeFail: counts?.get(BrokerEventType.OpenTradeFail) ?? 0,
    };
  };
  const continuity = (socket: ProbeSocket): SocketContinuity => ({
    state: clients[socket].state,
    connectionsBefore: connectionsBefore[socket],
    connectionsAfter: clients[socket].connections,
    leftReady: [...recorders[socket].leftReady],
  });
  const phases = Object.fromEntries(
    PROBE_PHASES.map((phase) => [
      phase,
      { ...records[phase], heard: { A: answers(phase, 'A'), B: answers(phase, 'B') } },
    ]),
  ) as Record<Phase, PhaseRecord>;

  say('phase | event type | A | B');
  for (const tableRow of ['setup', ...PROBE_PHASES] as const) {
    const a = recorders.A.counts.get(tableRow);
    const b = recorders.B.counts.get(tableRow);
    const types = [...new Set([...(a?.keys() ?? []), ...(b?.keys() ?? [])])].sort();
    for (const type of types) {
      say(`${tableRow} | ${type} | ${a?.get(type) ?? 0} | ${b?.get(type) ?? 0}`);
    }
  }
  say(
    `trade ids heard: A [${recorders.A.tradeIds.join(', ')}], B [${recorders.B.tradeIds.join(', ')}]`,
  );

  return {
    kind: 'ran',
    input: {
      userDataVerified,
      phases,
      sockets: { A: continuity('A'), B: continuity('B') },
    },
  };
}
