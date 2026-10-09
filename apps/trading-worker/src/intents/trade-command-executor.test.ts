import { createBrokerRestClient, MAX_DETAIL_LENGTH } from '@binarius/broker-rest';
import { hashToken, type TradeIntentRow } from '@binarius/db';
import {
  MockSocketPayload,
  startMockBroker,
  type MockBroker,
  type MockScript,
} from '@binarius/mock-broker';
import { logOptions, TradeAction, TradeMode } from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import pino from 'pino';
import { io } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccessTokenOptions,
  AccessTokenOutcome,
  AccessTokenSource,
} from '../broker/access-token';
import { BrokerEventType } from '../broker/events';
import {
  BrokerSocketState,
  createBrokerSocketClient,
  type BrokerSocket,
  type BrokerSocketClient,
  type BrokerSocketClientOptions,
} from '../broker/socket';
import type { TradeSessionSource } from '../broker/trade-session';
import { observeExecutor } from '../circuit-breaker/observe-executor';
import { createTradeCommandExecutor } from './trade-command-executor';

const TOKEN = 'SECRET-TOKEN-of-user-1';
const ACCOUNT = 'acc-1';
const EURUSD = 101;
const TIMING = {
  connectTimeoutMs: 1_000,
  authTimeoutMs: 200,
  reconnectDelayMs: 20,
  reconnectDelayMaxMs: 40,
  jitter: 0,
};
const LONG_TEXT = `${'refused because '.repeat(40)}end`;

type LogEntry = Record<string, unknown> & { level: number; msg: string };

let broker: MockBroker;
let lines: string[];
const clients: BrokerSocketClient[] = [];

beforeEach(async () => {
  broker = await startMockBroker({ socketPayload: MockSocketPayload.Bytes });
  broker.users.register({ id: 1, accessToken: TOKEN });
  lines = [];
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  await broker.close();
});

const logger = () => pino(logOptions('debug'), { write: (line: string) => void lines.push(line) });

const logs = (msg: string): LogEntry[] =>
  lines.map((line) => JSON.parse(line) as LogEntry).filter((entry) => entry.msg === msg);

const intentOf = (amount = '10.00000000') =>
  ({
    id: 'intent-1',
    brokerAccountId: ACCOUNT,
    mode: TradeMode.Demo,
    assetId: EURUSD,
    action: TradeAction.Up,
    durationSec: 60,
    amount,
  }) as TradeIntentRow;

function tokenSource(outcome: () => Promise<AccessTokenOutcome>) {
  const source = {
    calls: [] as { brokerAccountId: string; options: AccessTokenOptions }[],
    accessToken: async (brokerAccountId: string, options: AccessTokenOptions) => {
      source.calls.push({ brokerAccountId, options });
      return outcome();
    },
  } satisfies AccessTokenSource & { calls: unknown[] };
  return source;
}

const grantingTokens = () => tokenSource(async () => ({ ok: true, accessToken: TOKEN }));

// a started socket client for the account, ready unless `until` says otherwise
async function sessionFor(
  state: BrokerSocketState = BrokerSocketState.Ready,
  openSocket?: BrokerSocketClientOptions['openSocket'],
  timing: BrokerSocketClientOptions['timing'] = TIMING,
) {
  const client = createBrokerSocketClient({
    url: broker.url,
    logger: logger(),
    timing,
    ...(openSocket === undefined ? {} : { openSocket }),
  });
  clients.push(client);
  client.start({ brokerUserId: '1', accessToken: TOKEN });
  await until(state, () => client.state === state);
  return client;
}

const sessionsOf = (client?: BrokerSocketClient): TradeSessionSource => ({
  sessionFor: (id) => (id === ACCOUNT ? client : undefined),
});

function executor(client?: BrokerSocketClient, tokens: AccessTokenSource = grantingTokens()) {
  return createTradeCommandExecutor({
    sessions: sessionsOf(client),
    rest: createBrokerRestClient({ baseUrl: broker.url }),
    tokens,
    logger: logger(),
  });
}

const socketOpens = () =>
  broker.socket.journal.filter((record) => record.event.endsWith('.open_trade'));
const restOpens = () => broker.rest.journal.filter((record) => record.endpoint === 'openTrade');
const signal = () => new AbortController().signal;

// the ban on a second open: after an unknown the order went out once and no REST request followed
function expectSentOnceOverSocket() {
  expect(socketOpens()).toHaveLength(1);
  expect(restOpens()).toEqual([]);
}

describe('over the socket', () => {
  it('S1 a ready session opens the trade over the socket and REST is not called', async () => {
    const client = await sessionFor();
    const result = await executor(client).submit(intentOf(), signal());
    const [stored] = broker.trades.list(1);
    expect(result).toEqual({
      outcome: 'accepted',
      transport: 'socket',
      trade: expect.objectContaining({ id: String(stored?.id), assetId: EURUSD, amount: '10' }),
    });
    expect(socketOpens()).toHaveLength(1);
    expect(restOpens()).toEqual([]);
  });

  it('S2 open_trade.fail is rejected with the messages joined and cut', async () => {
    const client = await sessionFor();
    broker.socket.failNext('openTrade', {
      fail: [{ message: LONG_TEXT, field: 'amount' }, { message: 'second' }],
    });
    const result = await executor(client).submit(intentOf(), signal());
    const detail = `${LONG_TEXT}; second`.slice(0, MAX_DETAIL_LENGTH);
    expect(result).toEqual({ outcome: 'rejected', reason: 'broker_rejected', detail });
    expect(logs('trade command refused')).toEqual([
      expect.objectContaining({ transport: 'socket', failures: 2, detail }),
    ]);
    expect(restOpens()).toEqual([]);
  });

  it('S5 disconnect after send: unknown, no REST request, nothing opened', async () => {
    const client = await sessionFor();
    broker.socket.failNext('openTrade', { silent: true });
    const submit = executor(client).submit(intentOf(), signal());
    await until('the command on the broker', () => socketOpens().length === 1);
    expect(broker.socket.cutTransport({ userId: 1 })).toBe(1);
    expect(await submit).toEqual({ outcome: 'unknown', reason: 'broker_unavailable' });
    expect(logs('trade command outcome unknown')).toEqual([
      expect.objectContaining({
        transport: 'socket',
        reason: 'state_changed',
        sessionState: BrokerSocketState.Reconnecting,
      }),
    ]);
    await until('reconnected', () => client.connections === 2);
    expectSentOnceOverSocket();
    expect(broker.trades.list(1)).toEqual([]);
  });

  it('S6 disconnect before success: unknown, the trade is open, no REST request', async () => {
    const client = await sessionFor();
    broker.socket.failNext('openTrade', { disconnect: true, open: true });
    expect(await executor(client).submit(intentOf(), signal())).toEqual({
      outcome: 'unknown',
      reason: 'broker_unavailable',
    });
    expect(broker.trades.list(1)).toHaveLength(1);
    expectSentOnceOverSocket();
  });

  it('S7 disconnect after success: accepted', async () => {
    const client = await sessionFor();
    client.onEvent((event) => {
      if (event.type === BrokerEventType.OpenTradeSuccess) client.stop();
    });
    const result = await executor(client).submit(intentOf(), signal());
    expect(result).toEqual(expect.objectContaining({ outcome: 'accepted', transport: 'socket' }));
    expect(client.state).toBe(BrokerSocketState.Idle);
    expect(restOpens()).toEqual([]);
  });

  it('S8 abort while waiting: unknown, and no REST request afterwards', async () => {
    const client = await sessionFor();
    broker.socket.failNext('openTrade', { delayMs: 100 });
    const controller = new AbortController();
    const submit = executor(client).submit(intentOf(), controller.signal);
    await until('the command on the broker', () => socketOpens().length === 1);
    controller.abort();
    expect(await submit).toEqual({ outcome: 'unknown', reason: 'broker_unavailable' });
    await until('the late trade', () => broker.trades.list(1).length === 1);
    expectSentOnceOverSocket();
  });

  it('S9 the connection an aborted command tainted takes no command: the next one goes over REST', async () => {
    // engine.close() recorded and not run, so the connection stays ready and only the taint
    // keeps the next command off it
    const client = await sessionFor(BrokerSocketState.Ready, (url, options) => {
      const socket: BrokerSocket = io(url, options);
      socket.io.on('open', () => {
        socket.io.engine.close = () => socket.io.engine;
      });
      return socket;
    });
    broker.socket.failNext('openTrade', { delayMs: 50 });
    const controller = new AbortController();
    const first = executor(client).submit(intentOf(), controller.signal);
    await until('the command on the broker', () => socketOpens().length === 1);
    controller.abort();
    expect(await first).toEqual({ outcome: 'unknown', reason: 'broker_unavailable' });
    const second = await executor(client).submit(intentOf(), signal());
    expect(second).toEqual(
      expect.objectContaining({ outcome: 'accepted', transport: 'rest_fallback' }),
    );
    expect(logs('trade command falls back to rest')).toEqual([
      expect.objectContaining({ sessionState: BrokerSocketState.Ready }),
    ]);
    expect(socketOpens()).toHaveLength(1);
    expect(restOpens()).toHaveLength(1);
  });

  // M2 of review round 2: the broker's silence ends on the client's own command timer, before
  // the processor's deadline, so the circuit breaker counts it
  it('S10 a broker silent past the command timeout: unknown before the deadline, counted', async () => {
    const client = await sessionFor(BrokerSocketState.Ready, undefined, {
      ...TIMING,
      commandTimeoutMs: 60,
    });
    broker.socket.failNext('openTrade', { silent: true });
    const records: [string, boolean][] = [];
    const observed = observeExecutor(executor(client), {
      rest: (id, failed) => {
        records.push([id, failed]);
      },
    });
    // the processor's deadline
    const deadline = AbortSignal.timeout(400);
    const result = await observed.submit(intentOf(), deadline);
    expect(deadline.aborted).toBe(false);
    expect(result).toEqual({ outcome: 'unknown', reason: 'broker_unavailable' });
    expect(logs('trade command outcome unknown')).toEqual([
      expect.objectContaining({
        intentId: 'intent-1',
        transport: 'socket',
        reason: 'timeout',
        sessionState: BrokerSocketState.Ready,
      }),
    ]);
    expectSentOnceOverSocket();
    expect(records).toEqual([['intent-1', true]]);
  });

  it('a signal already aborted sends nothing anywhere', async () => {
    const client = await sessionFor();
    const tokens = grantingTokens();
    expect(await executor(client, tokens).submit(intentOf(), AbortSignal.abort())).toEqual({
      outcome: 'unknown',
      reason: 'broker_unavailable',
    });
    expect(socketOpens()).toEqual([]);
    expect(restOpens()).toEqual([]);
    expect(tokens.calls).toEqual([]);
  });
});

describe('REST only when nothing was emitted', () => {
  it('S3 no session: one REST POST with the account token, nothing on the socket', async () => {
    const tokens = grantingTokens();
    const abort = signal();
    const result = await executor(undefined, tokens).submit(intentOf(), abort);
    expect(result).toEqual({
      outcome: 'accepted',
      transport: 'rest_fallback',
      trade: expect.objectContaining({ assetId: EURUSD, amount: '10' }),
    });
    expect(restOpens()).toEqual([expect.objectContaining({ bearer: 'known' })]);
    expect(socketOpens()).toEqual([]);
    expect(tokens.calls).toEqual([{ brokerAccountId: ACCOUNT, options: { signal: abort } }]);
    expect(logs('trade command falls back to rest')).toEqual([
      expect.objectContaining({ sessionState: 'none' }),
    ]);
  });

  it('S4 a session that is not ready: REST, nothing emitted', async () => {
    broker.socket.failNext('auth', { silent: true });
    const client = await sessionFor(BrokerSocketState.Authenticating);
    const result = await executor(client).submit(intentOf(), signal());
    expect(result).toEqual(
      expect.objectContaining({ outcome: 'accepted', transport: 'rest_fallback' }),
    );
    expect(logs('trade command falls back to rest')).toEqual([
      expect.objectContaining({ sessionState: BrokerSocketState.Authenticating }),
    ]);
    expect(socketOpens()).toEqual([]);
    expect(restOpens()).toHaveLength(1);
  });

  it.each([
    { name: '401', script: { status: 401 }, code: 'unauthorized' },
    { name: '429', script: { status: 429, retryAfterSec: 7 }, code: 'rate_limited' },
    { name: '400', script: { status: 400 }, code: 'rejected' },
  ])('R1 a REST $name is rejected with the broker detail', async ({ script, code }) => {
    broker.rest.failNext('openTrade', {
      ...script,
      body: { error: { message: LONG_TEXT } },
    } as MockScript);
    const detail = LONG_TEXT.slice(0, MAX_DETAIL_LENGTH);
    const tokens = grantingTokens();
    const abort = signal();
    expect(await executor(undefined, tokens).submit(intentOf(), abort)).toEqual({
      outcome: 'rejected',
      reason: 'broker_rejected',
      detail,
    });
    expect(logs('trade command refused')).toEqual([
      expect.objectContaining({
        transport: 'rest_fallback',
        stage: 'rest',
        code,
        status: script.status,
        detail,
        ...('retryAfterSec' in script ? { retryAfterSec: script.retryAfterSec } : {}),
      }),
    ]);
    // only a 401 reports the token back, with the policy of the trade itself (#281)
    expect(tokens.calls).toEqual([
      { brokerAccountId: ACCOUNT, options: { signal: abort } },
      ...(code === 'unauthorized'
        ? [{ brokerAccountId: ACCOUNT, options: { signal: abort, refusedToken: hashToken(TOKEN) } }]
        : []),
    ]);
  });

  it.each([
    { name: '503', script: { status: 503 } as MockScript, code: 'unavailable' },
    { name: 'a 200 off the schema', script: { status: 200, body: {} }, code: 'contract_violation' },
  ])('R2 a REST $name is unknown', async ({ script, code }) => {
    broker.rest.failNext('openTrade', script);
    expect(await executor().submit(intentOf(), signal())).toEqual({
      outcome: 'unknown',
      reason: 'broker_unavailable',
    });
    expect(logs('trade command outcome unknown')).toEqual([
      expect.objectContaining({ transport: 'rest_fallback', stage: 'rest', code }),
    ]);
    expect(restOpens()).toHaveLength(1);
  });

  it('R2 a REST request aborted while hanging is unknown', async () => {
    broker.rest.failNext('openTrade', { hang: true });
    const controller = new AbortController();
    const submit = executor().submit(intentOf(), controller.signal);
    await until('the request on the broker', () => broker.rest.pendingHangs === 1);
    controller.abort();
    expect(await submit).toEqual({ outcome: 'unknown', reason: 'broker_unavailable' });
    expect(logs('trade command outcome unknown')).toEqual([
      expect.objectContaining({ stage: 'rest', code: 'aborted' }),
    ]);
  });

  it('R3 a token refusal is rejected before any request leaves the worker', async () => {
    const tokens = tokenSource(async () => ({ ok: false, reason: 'account_revoked', status: 409 }));
    expect(await executor(undefined, tokens).submit(intentOf(), signal())).toEqual({
      outcome: 'rejected',
      reason: 'broker_rejected',
    });
    expect(broker.rest.journal).toEqual([]);
    expect(logs('trade command refused')).toEqual([
      expect.objectContaining({
        transport: 'rest_fallback',
        stage: 'token',
        reason: 'account_revoked',
        status: 409,
      }),
    ]);
  });

  // #275: the broker rate-limited the exchange; nothing is sent, the reserve is released
  it('R3 a rate-limited token on the REST path is rejected, nothing sent', async () => {
    const tokens = tokenSource(async () => ({
      ok: false,
      reason: 'refresh_rate_limited',
      status: 409,
    }));
    expect(await executor(undefined, tokens).submit(intentOf(), signal())).toEqual({
      outcome: 'rejected',
      reason: 'broker_rejected',
    });
    expect(restOpens()).toEqual([]);
    expect(logs('trade command refused')).toEqual([
      expect.objectContaining({ stage: 'token', reason: 'refresh_rate_limited' }),
    ]);
  });

  it.each([
    ['10.00000000', '10'],
    ['1.50000000', '1.5'],
  ])('R4 the amount %s goes out as %s', async (amount, sent) => {
    const result = await executor().submit(intentOf(amount), signal());
    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'accepted',
        trade: expect.objectContaining({ amount: sent }),
      }),
    );
  });

  it('R6 a throwing source during the report leaves the rejection as it is', async () => {
    let calls = 0;
    const tokens = tokenSource(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, accessToken: TOKEN };
      throw new TypeError('report broke');
    });
    broker.rest.failNext('openTrade', { status: 401 });
    expect(await executor(undefined, tokens).submit(intentOf(), signal())).toMatchObject({
      outcome: 'rejected',
      reason: 'broker_rejected',
    });
    await until('the failed report', () => logs('refused token report failed').length === 1);
    expect(logs('refused token report failed')).toEqual([
      expect.objectContaining({ intentId: 'intent-1', err: { name: 'TypeError' } }),
    ]);
  });

  it('R7 a report still in flight does not hold the rejection back', async () => {
    let calls = 0;
    const tokens = tokenSource(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, accessToken: TOKEN };
      return new Promise<AccessTokenOutcome>(() => undefined);
    });
    broker.rest.failNext('openTrade', { status: 401 });
    expect(await executor(undefined, tokens).submit(intentOf(), signal())).toMatchObject({
      outcome: 'rejected',
      reason: 'broker_rejected',
    });
    expect(tokens.calls).toHaveLength(2);
  });

  it('R5 a token source that throws rejects the submit (the processor writes unknown)', async () => {
    const tokens = tokenSource(async () => {
      throw new Error('token source bug');
    });
    await expect(executor(undefined, tokens).submit(intentOf(), signal())).rejects.toThrow(
      'token source bug',
    );
    expect(broker.rest.journal).toEqual([]);
  });
});

describe('logs', () => {
  it('L1 never carry the token or the broker host, and name every outcome line', async () => {
    const client = await sessionFor();
    await executor(client).submit(intentOf(), signal());
    broker.socket.failNext('openTrade', { fail: [{ message: LONG_TEXT }] });
    await executor(client).submit(intentOf(), signal());
    broker.socket.failNext('openTrade', { disconnect: true });
    await executor(client).submit(intentOf(), signal());
    await executor().submit(intentOf(), signal());
    broker.rest.failNext('openTrade', { status: 401, body: { error: { message: LONG_TEXT } } });
    await executor().submit(intentOf(), signal());
    broker.rest.failNext('openTrade', { status: 503 });
    await executor().submit(intentOf(), signal());
    await executor(
      undefined,
      tokenSource(async () => ({ ok: false, reason: 'user_blocked' })),
    ).submit(intentOf(), signal());

    for (const line of lines) {
      expect(line).not.toContain('SECRET');
      expect(line).not.toContain(broker.url.replace('http://', ''));
    }
    const messages = new Set(lines.map((line) => (JSON.parse(line) as LogEntry).msg));
    for (const msg of [
      'trade command accepted',
      'trade command refused',
      'trade command outcome unknown',
      'trade command falls back to rest',
      'refused token reported',
    ]) {
      expect(messages, msg).toContain(msg);
    }
  });
});
