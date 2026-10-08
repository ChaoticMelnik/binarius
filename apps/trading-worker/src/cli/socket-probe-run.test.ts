import { BrokerRestError } from '@binarius/broker-rest';
import {
  BrokerRestErrorCode,
  decimalStringSchema,
  TradeMode,
  type BinaryPair,
  type BrokerUser,
  type OpenTrade,
  type OpenTradeRequest,
  type SocketOpenTradeRequest,
} from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { BrokerEventType, type BrokerEvent } from '../broker/events';
import {
  BrokerSocketState,
  type BrokerSocketClient,
  type BrokerSocketStateChange,
  type SocketOpenTradeResult,
} from '../broker/socket';
import { PROBE_PRECONDITIONS, runProbe, type ProbeDeps, type ProbeRun } from './socket-probe-run';
import { PROBE_PHASES, verdict, type ProbeSocket, type VerdictInput } from './socket-probe-verdict';

const d = (value: string) => decimalStringSchema.parse(value);
const BROKER_USER_ID = 'SECRET-user-7';
const ACCESS_TOKEN = 'SECRET-token';
const WINDOW_MS = 15;
const READY_TIMEOUT_MS = 1_000;

const pair = (id: number, fields: Partial<BinaryPair> = {}): BinaryPair => ({
  id,
  symbol: `PAIR${id}`,
  type: 'currency',
  digits: 5,
  payout: 85,
  maxPayout: 90,
  minTimeframe: 5,
  maxTimeframe: 3600,
  scheduledUntil: 0,
  ...fields,
});
// the first tradable pair is 103: 101 is scheduled, 102 pays nothing
const PAIRS = [pair(101, { scheduledUntil: 1_790_000_000 }), pair(102, { payout: 0 }), pair(103)];

const user = (id: string, minTradeAmount = '1.00'): BrokerUser => ({
  id,
  level: { code: 'standard', rank: 1 },
  minTradeAmount: d(minTradeAmount),
  real: { available: d('0'), held: d('0'), total: d('0') },
  demo: { available: d('100.00'), held: d('0'), total: d('100.00') },
});

const openTrade = (id: string, request: SocketOpenTradeRequest): OpenTrade => ({
  id,
  assetId: request.assetId,
  action: request.action,
  amount: request.amount,
  payout: 85,
  openPrice: 1.1,
  openTimestamp: 1_790_028_496_624 as OpenTrade['openTimestamp'],
  isDemo: true,
  potentialProfit: d('0.85'),
});

const successEvent = (trade: OpenTrade): BrokerEvent => ({
  type: BrokerEventType.OpenTradeSuccess,
  mode: TradeMode.Demo,
  trade,
});
const failEvent = (message: string): BrokerEvent => ({
  type: BrokerEventType.OpenTradeFail,
  mode: TradeMode.Demo,
  failures: [{ message }],
});

interface Call {
  mode: TradeMode;
  request: SocketOpenTradeRequest;
  signal: AbortSignal;
}

interface FakeClient extends BrokerSocketClient {
  calls: Call[];
  connections: number;
  fire(to: BrokerSocketState, reason?: string): void;
  hear(event: BrokerEvent): void;
}

type Respond = (
  label: ProbeSocket,
  call: Call,
  h: Harness,
) => SocketOpenTradeResult | Promise<SocketOpenTradeResult>;

// the broker answering each command to its sender only: a success at the minimum, a fail below it
const senderOnly: Respond = (label, call, h) => {
  if (call.request.amount === d('0.01')) {
    h.clients[label].hear(failEvent('amount below the minimum'));
    return { outcome: 'fail', failures: [{ message: 'amount below the minimum' }] };
  }
  const trade = openTrade(`${label}${h.clients[label].calls.length}`, call.request);
  h.clients[label].hear(successEvent(trade));
  return { outcome: 'success', trade };
};

interface Options {
  burst?: (label: ProbeSocket) => BrokerEvent[];
  respond?: Respond;
  rest?: (request: OpenTradeRequest) => Promise<OpenTrade>;
  // runs while the probe sleeps: `sent` counts the commands and the REST order sent so far
  onSleep?: (ms: number, sent: number, h: Harness) => void;
  manualSleep?: boolean;
}

interface Harness {
  clients: Record<ProbeSocket, FakeClient>;
  restCalls: OpenTradeRequest[];
  lines: string[];
  timeline: string[];
  sleeps: { ms: number; resolve: (advance: number) => void }[];
  clock: number;
  sent(): number;
  run(): Promise<ProbeRun>;
}

const defaultBurst = (label: ProbeSocket): BrokerEvent[] => [
  { type: BrokerEventType.UserData, user: user(BROKER_USER_ID) },
  ...(label === 'A' ? [{ type: BrokerEventType.AssetsList, pairs: PAIRS } as BrokerEvent] : []),
];

function harness(options: Options = {}): Harness {
  const burst = options.burst ?? defaultBurst;
  const respond = options.respond ?? senderOnly;
  const h = {} as Harness;

  const fakeClient = (label: ProbeSocket): FakeClient => {
    const stateListeners = new Set<(change: BrokerSocketStateChange) => void>();
    const eventListeners = new Set<(event: BrokerEvent) => void>();
    let state: BrokerSocketState = BrokerSocketState.Idle;
    const client: FakeClient = {
      calls: [],
      connections: 0,
      fire(to, reason) {
        const change = reason === undefined ? { from: state, to } : { from: state, to, reason };
        state = to;
        for (const listener of [...stateListeners]) listener(change);
      },
      hear(event) {
        for (const listener of [...eventListeners]) listener(event);
      },
      start() {
        client.connections += 1;
        client.fire(BrokerSocketState.Ready);
        for (const event of burst(label)) client.hear(event);
      },
      stop: () => undefined,
      subscribe: () => undefined,
      subscriptions: () => [],
      openTrade(mode, request, signal) {
        const call = { mode, request, signal };
        client.calls.push(call);
        h.timeline.push(`call ${label}`);
        return Promise.resolve(respond(label, call, h));
      },
      get state() {
        return state;
      },
      onEvent(listener) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      onState(listener) {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
    };
    return client;
  };

  Object.assign(h, {
    clients: { A: fakeClient('A'), B: fakeClient('B') },
    restCalls: [],
    lines: [],
    timeline: [],
    sleeps: [],
    clock: 0,
    sent: () => h.clients.A.calls.length + h.clients.B.calls.length + h.restCalls.length,
  });

  const deps: ProbeDeps = {
    openClient: (label) => h.clients[label],
    rest: {
      openTrade(_auth, request) {
        h.restCalls.push(request);
        h.timeline.push('call rest');
        return options.rest === undefined
          ? Promise.resolve(openTrade('R1', request))
          : options.rest(request);
      },
    },
    credentials: { brokerUserId: BROKER_USER_ID, accessToken: ACCESS_TOKEN },
    now: () => h.clock,
    sleep(ms) {
      options.onSleep?.(ms, h.sent(), h);
      if (!options.manualSleep) {
        h.clock += ms;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        h.sleeps.push({
          ms,
          resolve: (advance) => {
            h.clock += advance;
            resolve();
          },
        });
      });
    },
    say(line) {
      h.lines.push(line);
      h.timeline.push(`say ${line}`);
    },
    timing: { readyTimeoutMs: READY_TIMEOUT_MS, commandTimeoutMs: 1_000, windowMs: WINDOW_MS },
  };
  h.run = () => runProbe(deps);
  return h;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function ran(h: Harness): Promise<VerdictInput> {
  const result = await h.run();
  if (result.kind !== 'ran') throw new Error(`expected a run, got ${result.what}`);
  return result.input;
}

describe('runProbe', () => {
  it('R0 a clean run: four commands from their senders, one REST order, every window, safe', async () => {
    const h = harness();
    const input = await ran(h);

    expect(verdict(input)).toEqual({ kind: 'sender_only' });
    const terms = { assetId: 103, action: 'up', durationSec: 5 };
    expect(h.clients.A.calls.map((call) => [call.mode, call.request])).toEqual([
      [TradeMode.Demo, { ...terms, amount: '1.00' }],
      [TradeMode.Demo, { ...terms, amount: '0.01' }],
    ]);
    expect(h.clients.B.calls.map((call) => [call.mode, call.request])).toEqual([
      [TradeMode.Demo, { ...terms, amount: '1.00' }],
      [TradeMode.Demo, { ...terms, amount: '0.01' }],
    ]);
    expect(h.restCalls).toEqual([{ ...terms, amount: '1.00', isDemo: true }]);
    expect(PROBE_PHASES.map((phase) => input.phases[phase].windowCompleted)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    // taken after the wait: the start() handshake is not a change
    expect(input.sockets.A.connectionsBefore).toBe(1);
    expect(input.sockets.B.connectionsBefore).toBe(1);
  });

  it('R1 the recorders are on before start(): B leaving ready during the wait reaches the verdict', async () => {
    const h = harness({
      burst: (label) => (label === 'A' ? defaultBurst('A') : []),
      onSleep: (_ms, sent, harnessed) => {
        if (sent > 0 || harnessed.clients.B.calls.length > 0) return;
        const b = harnessed.clients.B;
        if (b.state !== BrokerSocketState.Ready) return;
        b.fire(BrokerSocketState.Reconnecting, 'transport close');
        b.fire(BrokerSocketState.Ready);
        b.hear({ type: BrokerEventType.UserData, user: user(BROKER_USER_ID) });
      },
    });
    const input = await ran(h);

    expect(input.sockets.B.leftReady).toEqual(['ready -> reconnecting (transport close)']);
    expect(verdict(input).kind).toBe('inconclusive');
  });

  describe('R2 command 1 waits for user.data of the account on both sockets', () => {
    it('B never sends user.data: setup failed at the timeout, naming B, and no command', async () => {
      const h = harness({ burst: (label) => (label === 'A' ? defaultBurst('A') : []) });
      const result = await h.run();

      expect(result).toEqual({
        kind: 'setup_failed',
        what: `not within ${READY_TIMEOUT_MS} ms: user.data on B`,
      });
      expect(h.clock).toBeGreaterThanOrEqual(READY_TIMEOUT_MS);
      expect(h.clients.A.calls).toEqual([]);
    });

    it('B sends the user.data of another user: setup failed at once, and no command', async () => {
      const h = harness({
        burst: (label) =>
          label === 'A' ? defaultBurst('A') : [{ type: BrokerEventType.UserData, user: user('8') }],
      });
      const result = await h.run();

      expect(result).toEqual({ kind: 'setup_failed', what: 'user.data id mismatch on B' });
      expect(h.clock).toBe(0);
      expect(h.clients.A.calls).toEqual([]);
    });
  });

  it('R3 B drops and reconnects in the window of a_below: inconclusive', async () => {
    const h = harness({
      onSleep: (ms, sent, harnessed) => {
        if (ms !== WINDOW_MS || sent !== 2) return;
        const b = harnessed.clients.B;
        b.fire(BrokerSocketState.Reconnecting, 'transport close');
        b.connections = 2;
        b.fire(BrokerSocketState.Ready);
      },
    });
    const input = await ran(h);

    expect(input.sockets.B).toEqual({
      state: BrokerSocketState.Ready,
      connectionsBefore: 1,
      connectionsAfter: 2,
      leftReady: ['ready -> reconnecting (transport close)'],
    });
    expect(verdict(input).kind).toBe('inconclusive');
  });

  describe('R4 events are counted into the phase in progress', () => {
    it('a fail on A in the window of b_min is a broadcast of b_min', async () => {
      const h = harness({
        onSleep: (ms, sent, harnessed) => {
          if (ms === WINDOW_MS && sent === 3) harnessed.clients.A.hear(failEvent('late'));
        },
      });
      const input = await ran(h);

      expect(input.phases.b_min.heard.A.openTradeFail).toBe(1);
      expect(verdict(input)).toEqual({
        kind: 'broadcast',
        heard: [
          { phase: 'b_min', socket: 'A', answers: { openTradeSuccess: 0, openTradeFail: 1 } },
        ],
      });
    });

    it('a success on B while command 1 is pending counts for a_min, not a_below', async () => {
      const h = harness({
        respond: (label, call, harnessed) => {
          if (harnessed.sent() === 1) {
            harnessed.clients.B.hear(successEvent(openTrade('X1', call.request)));
          }
          return senderOnly(label, call, harnessed);
        },
      });
      const input = await ran(h);

      expect(input.phases.a_min.heard.B.openTradeSuccess).toBe(1);
      expect(input.phases.a_below.heard.B.openTradeSuccess).toBe(0);
    });
  });

  it('R5 each next command waits for the window, measured by the clock', async () => {
    const h = harness({ manualSleep: true });
    let settled = false;
    const result = h.run().then((run) => {
      settled = true;
      return run;
    });

    await flush();
    expect(h.sent()).toBe(1);
    expect(h.sleeps.map((sleep) => sleep.ms)).toEqual([WINDOW_MS]);
    // woken early: the probe sleeps the rest of the window before command 2
    h.sleeps[0]!.resolve(5);
    await flush();
    expect(h.sent()).toBe(1);
    expect(h.sleeps[1]!.ms).toBe(WINDOW_MS - 5);

    h.sleeps[1]!.resolve(WINDOW_MS - 5);
    for (let phase = 2; phase <= PROBE_PHASES.length; phase += 1) {
      await flush();
      expect(h.sent()).toBe(phase);
      const pending = h.sleeps.at(-1)!;
      expect(pending.ms).toBe(WINDOW_MS);
      await flush();
      expect(h.sent()).toBe(phase);
      expect(settled).toBe(false);
      pending.resolve(WINDOW_MS);
    }
    const run = await result;
    expect(run.kind).toBe('ran');
    if (run.kind === 'ran') {
      expect(PROBE_PHASES.every((phase) => run.input.phases[phase].windowCompleted)).toBe(true);
    }
  });

  describe('R7 the REST phase', () => {
    it('is sent once, after the window of b_below', async () => {
      const h = harness({
        onSleep: (ms, sent, harnessed) => {
          if (ms === WINDOW_MS && sent === 4) expect(harnessed.restCalls).toEqual([]);
        },
      });
      await ran(h);
      expect(h.restCalls).toHaveLength(1);
    });

    it('a refusal is its code, inconclusive', async () => {
      const h = harness({
        rest: () => Promise.reject(new BrokerRestError(BrokerRestErrorCode.Rejected)),
      });
      const input = await ran(h);

      expect(input.phases.rest_min.command).toBe('rejected');
      expect(verdict(input)).toEqual({
        kind: 'inconclusive',
        missing: ['rest_min: expected success, got rejected (the broker refused the order)'],
      });
    });

    it('any other throw is threw', async () => {
      const h = harness({ rest: () => Promise.reject(new TypeError('boom')) });
      const input = await ran(h);
      expect(input.phases.rest_min.command).toBe('threw');
    });

    it('a success on A in its window is a broadcast of rest_min', async () => {
      const h = harness({
        onSleep: (ms, sent, harnessed) => {
          if (ms === WINDOW_MS && sent === 5) {
            harnessed.clients.A.hear(successEvent(openTrade('R1', harnessed.restCalls[0]!)));
          }
        },
      });
      const input = await ran(h);

      expect(verdict(input)).toEqual({
        kind: 'broadcast',
        heard: [
          { phase: 'rest_min', socket: 'A', answers: { openTradeSuccess: 1, openTradeFail: 0 } },
        ],
      });
    });
  });

  describe('R8 the below-minimum commands', () => {
    const withMinimum = (minimum: string) =>
      harness({
        burst: (label) => [
          { type: BrokerEventType.UserData, user: user(BROKER_USER_ID, minimum) },
          ...(label === 'A'
            ? [{ type: BrokerEventType.AssetsList, pairs: PAIRS } as BrokerEvent]
            : []),
        ],
      });

    it('are skipped when min_trade_amount is 0.01: inconclusive', async () => {
      const h = withMinimum('0.01');
      const input = await ran(h);

      expect(input.phases.a_below.command).toBe('skipped');
      expect(input.phases.b_below.command).toBe('skipped');
      expect(h.clients.A.calls).toHaveLength(1);
      expect(h.clients.B.calls).toHaveLength(1);
      expect(verdict(input).kind).toBe('inconclusive');
    });

    it('are sent when min_trade_amount is 0.015', async () => {
      const h = withMinimum('0.015');
      await ran(h);
      expect(h.clients.A.calls.map((call) => call.request.amount)).toEqual(['0.015', '0.01']);
    });
  });

  it('R9 the preconditions before command 1; no secret and no long message in the output', async () => {
    const long = 'x'.repeat(500);
    const h = harness({
      respond: (label, call, harnessed) => {
        if (call.request.amount !== d('0.01')) return senderOnly(label, call, harnessed);
        harnessed.clients[label].hear(failEvent(long));
        return { outcome: 'fail', failures: [{ message: long }] };
      },
    });
    await ran(h);

    const lastPrecondition = h.timeline.indexOf(`say ${PROBE_PRECONDITIONS.at(-1)!}`);
    expect(lastPrecondition).toBeGreaterThanOrEqual(0);
    expect(lastPrecondition).toBeLessThan(h.timeline.indexOf('call A'));
    expect(h.lines.filter((line) => line.includes('SECRET-'))).toEqual([]);
    const failLine = h.lines.find((line) => line.startsWith('a_below'))!;
    expect(failLine).toContain('x'.repeat(200));
    expect(failLine).not.toContain('x'.repeat(201));
    expect(h.lines).toContain('trade ids heard: A [A1], B [B1]');
  });

  describe('R10 setup failures', () => {
    it('no tradable pair', async () => {
      const h = harness({
        burst: (label) => [
          { type: BrokerEventType.UserData, user: user(BROKER_USER_ID) },
          ...(label === 'A'
            ? [{ type: BrokerEventType.AssetsList, pairs: PAIRS.slice(0, 2) } as BrokerEvent]
            : []),
        ],
      });
      expect(await h.run()).toEqual({
        kind: 'setup_failed',
        what: 'no tradable pair in common.assets_list',
      });
      expect(h.sent()).toBe(0);
    });

    it('A ready without assets_list: the timeout names it', async () => {
      const h = harness({
        burst: () => [{ type: BrokerEventType.UserData, user: user(BROKER_USER_ID) }],
      });
      expect(await h.run()).toEqual({
        kind: 'setup_failed',
        what: `not within ${READY_TIMEOUT_MS} ms: assets_list on A`,
      });
    });
  });
});
