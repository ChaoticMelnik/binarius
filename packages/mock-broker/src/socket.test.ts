import {
  BrokerSocketEvent,
  decodeSocketPayload,
  modeEvent,
  safeParseAssetsList,
  safeParseAssetsUpdate,
  safeParseCloseTradeSuccess,
  safeParseOpenTradeFail,
  safeParsePriceUpdate,
  safeParseSocketOpenTradeSuccess,
  safeParseUpdateBalance,
  safeParseUserAuthError,
  safeParseUserData,
  type BrokerServerToClientEvents,
  type ModeScopedEvent,
  type TradeMode,
} from '@binarius/shared';
import { UNIT_WAIT_CEILING_MS, until } from '@binarius/shared/testing';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockSocketPayload } from './encoding';
import { FIXTURE_MESSAGES, LIVE_MESSAGES } from './messages';
import { startMockBroker, type MockBroker } from './server';
import { MockSocketOutcome, OBSERVED_EXTRA_EVENTS } from './socket';
import type { MockOpenTradeScript } from './socket-faults';

const TOKEN = 'access-token-of-user-1';
const OTHER_TOKEN = 'access-token-of-user-2';
const EURUSD = 101;
const AAPL = 202;
const BTCUSD = 303;
const GBPUSD = 404;
const QUIET_MS = 100;

const BURST = [
  BrokerSocketEvent.UserAuthSuccess,
  BrokerSocketEvent.UserData,
  BrokerSocketEvent.CommonAssetsList,
  'user.real.close_trade.recent',
  'user.demo.close_trade.recent',
  'user.real.futures.positions',
  'user.real.futures.closed.recent',
  'user.demo.futures.positions',
  'user.demo.futures.closed.recent',
];
const BURST_END = 'user.demo.futures.closed.recent';

interface Received {
  event: string;
  args: unknown[];
}

interface Client {
  socket: ClientSocket;
  received: Received[];
  // every payload of the event so far, decoded
  payloads(event: string): unknown[];
  waitFor(event: string, count?: number): Promise<unknown[]>;
  // the event has not arrived (beyond the count already seen) within QUIET_MS
  expectQuiet(event: string, count?: number): Promise<void>;
  disconnected: Promise<string>;
}

let broker: MockBroker;
const clients: ClientSocket[] = [];

async function connectClient(target: MockBroker = broker): Promise<Client> {
  const socket = io(target.url, { transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(socket);
  const received: Received[] = [];
  socket.onAny((event: string, ...args: unknown[]) => received.push({ event, args }));
  const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const of = (event: string) => received.filter((entry) => entry.event === event);
  return {
    socket,
    received,
    disconnected,
    payloads: (event) => of(event).map((entry) => decodeSocketPayload(entry.args[0])),
    async waitFor(event, count = 1) {
      await until(`${count} × ${event}`, () => of(event).length >= count);
      return of(event).map((entry) => decodeSocketPayload(entry.args[0]));
    },
    async expectQuiet(event, count = 0) {
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
      expect(of(event)).toHaveLength(count);
    },
  };
}

async function authed(target: MockBroker = broker, id = 1, token = TOKEN): Promise<Client> {
  const client = await connectClient(target);
  client.socket.emit(BrokerSocketEvent.UserAuth, { id, token });
  await client.waitFor(BURST_END);
  return client;
}

const tradeCommand = (overrides: Record<string, unknown> = {}) => ({
  asset_id: EURUSD,
  amount: '10.00',
  action: 'up',
  duration: 60,
  ...overrides,
});

const ev = (mode: TradeMode, event: ModeScopedEvent) => modeEvent(mode, event);

async function rest(path: string, token = TOKEN) {
  const response = await fetch(`${broker.url}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

beforeEach(async () => {
  broker = await startMockBroker();
  broker.users.register({ id: 1, accessToken: TOKEN, real: { available: '100.00' } });
  broker.users.register({ id: 2, accessToken: OTHER_TOKEN });
});

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.disconnect();
  await broker.close();
});

describe('handshake', () => {
  it('answers user.auth with [null], then pushes the observed burst in order, from the store', async () => {
    const client = await authed();
    expect(client.received.map((entry) => entry.event)).toEqual(BURST);
    expect(client.received[0]?.args).toEqual([null]);
    const [user] = client.payloads(BrokerSocketEvent.UserData);
    expect(safeParseUserData(user).success).toBe(true);
    expect(user).toEqual(broker.users.get(1));
    const [pairs] = client.payloads(BrokerSocketEvent.CommonAssetsList);
    expect(safeParseAssetsList(pairs).success).toBe(true);
    expect(pairs).toEqual(broker.pairs.list());
    expect(client.payloads('user.real.close_trade.recent')).toEqual([{ trades: [] }]);
    expect(client.payloads('user.demo.futures.positions')).toEqual([{ positions: [], orders: [] }]);
    expect(client.payloads('user.real.futures.closed.recent')).toEqual([{ orders: [] }]);
    expect(broker.socket.sockets()).toEqual([
      { id: client.socket.id, userId: 1, subscriptions: [] },
    ]);
    expect(broker.socket.journal).toEqual([
      {
        socketId: client.socket.id,
        event: BrokerSocketEvent.UserAuth,
        argc: 1,
        userId: 1,
        outcome: MockSocketOutcome.Handled,
      },
    ]);
  });

  it('accepts the id as a string and lists every connected socket in connection order', async () => {
    const first = await authed();
    const anonymous = await connectClient();
    const second = await connectClient();
    second.socket.emit(BrokerSocketEvent.UserAuth, { id: '1', token: TOKEN });
    await second.waitFor(BURST_END);
    expect(broker.socket.sockets().map(({ id, userId }) => ({ id, userId }))).toEqual([
      { id: first.socket.id, userId: 1 },
      { id: anonymous.socket.id },
      { id: second.socket.id, userId: 1 },
    ]);
  });

  it('handles a repeated user.auth as the first one, keeping the subscriptions', async () => {
    const client = await authed();
    client.socket.emit(BrokerSocketEvent.PriceSubscribe, { assets: [EURUSD] });
    await client.waitFor(OBSERVED_EXTRA_EVENTS.PriceSubscribed);
    client.socket.emit(BrokerSocketEvent.UserAuth, { id: 2, token: OTHER_TOKEN });
    await client.waitFor(BURST_END, 2);
    expect(broker.socket.sockets()).toEqual([
      { id: client.socket.id, userId: 2, subscriptions: [EURUSD] },
    ]);
    // the room of user 1 was left: a trade of user 1 no longer reaches this socket
    const other = await authed(broker, 1, TOKEN);
    other.socket.emit(ev('demo', 'open_trade'), tradeCommand());
    await other.waitFor(ev('demo', 'open_trade.success'));
    await client.expectQuiet(ev('demo', 'update_balance'));
  });

  it('leaves an authenticated socket its user when a later user.auth fails', async () => {
    const client = await authed();
    client.socket.emit(BrokerSocketEvent.UserAuth, { id: 1, token: 'nope' });
    await client.waitFor(BrokerSocketEvent.UserAuthError);
    expect(broker.socket.sockets()[0]?.userId).toBe(1);
    broker.pairs.update(EURUSD, { payout: 70 });
    await client.waitFor(BrokerSocketEvent.CommonAssetsUpdate);
  });

  it('refuses a websocket-less client', async () => {
    const socket = io(broker.url, { transports: ['polling'], reconnection: false, forceNew: true });
    clients.push(socket);
    await expect(
      new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      }),
    ).rejects.toThrow();
  });
});

describe('user.auth refusals', () => {
  it.each([
    ['an unknown token', [{ id: 1, token: 'nope' }], LIVE_MESSAGES.invalidToken, 'auth_failed'],
    ["another user's id", [{ id: 2, token: TOKEN }], LIVE_MESSAGES.invalidToken, 'auth_failed'],
    ['no token', [{ id: 1 }], FIXTURE_MESSAGES.required('token'), 'invalid'],
    ['an empty token', [{ id: 1, token: '' }], FIXTURE_MESSAGES.invalid('token'), 'invalid'],
    ['an empty payload', [{}], FIXTURE_MESSAGES.required('id'), 'invalid'],
    ['no argument at all', [], FIXTURE_MESSAGES.required('id'), 'invalid'],
  ])('answers %s with user.auth.error', async (_name, args, message, outcome) => {
    const client = await connectClient();
    client.socket.emit(BrokerSocketEvent.UserAuth, ...args);
    const [error] = await client.waitFor(BrokerSocketEvent.UserAuthError);
    expect(safeParseUserAuthError(error).success).toBe(true);
    expect(error).toEqual({ message });
    await client.expectQuiet(BrokerSocketEvent.UserAuthSuccess);
    expect(broker.socket.sockets()[0]?.userId).toBeUndefined();
    expect(broker.socket.journal.map((record) => record.outcome)).toEqual([outcome]);
  });
});

describe('auth scripts', () => {
  it('plays error, silent and disconnect once each, in order', async () => {
    broker.socket.failNext('auth', { error: { message: 'scripted refusal' } });
    broker.socket.failNext('auth', { silent: true });
    broker.socket.failNext('auth', { disconnect: true });
    const client = await connectClient();

    client.socket.emit(BrokerSocketEvent.UserAuth, { id: 1, token: TOKEN });
    expect(await client.waitFor(BrokerSocketEvent.UserAuthError)).toEqual([
      { message: 'scripted refusal' },
    ]);
    client.socket.emit(BrokerSocketEvent.UserAuth, { id: 1, token: TOKEN });
    await client.expectQuiet(BrokerSocketEvent.UserAuthSuccess);
    expect(client.received).toHaveLength(1);
    client.socket.emit(BrokerSocketEvent.UserAuth, { id: 1, token: TOKEN });
    expect(await client.disconnected).toBe('io server disconnect');
    expect(client.received).toHaveLength(1);
    expect(broker.socket.journal.map((record) => record.outcome)).toEqual([
      MockSocketOutcome.Scripted,
      MockSocketOutcome.Scripted,
      MockSocketOutcome.Scripted,
    ]);

    const next = await authed();
    expect(next.received[0]?.event).toBe(BrokerSocketEvent.UserAuthSuccess);
  });

  it('a connect script refuses the next connection in the middleware, before any event', async () => {
    broker.socket.failNext('connect', { error: { message: 'scripted refusal' } });
    const socket = io(broker.url, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    clients.push(socket);
    const error = await new Promise<Error>((resolve) => socket.once('connect_error', resolve));
    expect(error.message).toBe('scripted refusal');
    expect(socket.active).toBe(false);
    expect(broker.socket.sockets()).toEqual([]);
    expect(broker.socket.journal).toEqual([]);

    const next = await authed();
    expect(next.received[0]?.event).toBe(BrokerSocketEvent.UserAuthSuccess);
  });

  it('plays before validation', async () => {
    broker.socket.failNext('auth', { error: { message: 'scripted' } });
    const client = await connectClient();
    client.socket.emit(BrokerSocketEvent.UserAuth, 'not an object');
    expect(await client.waitFor(BrokerSocketEvent.UserAuthError)).toEqual([
      { message: 'scripted' },
    ]);
  });
});

describe('before user.auth', () => {
  it('answers neither price.subscribe nor open_trade, and opens nothing', async () => {
    const client = await connectClient();
    client.socket.emit(BrokerSocketEvent.PriceSubscribe, { assets: [EURUSD] });
    client.socket.emit(ev('demo', 'open_trade'), tradeCommand());
    await client.expectQuiet(ev('demo', 'open_trade.fail'));
    expect(client.received).toEqual([]);
    expect(broker.trades.list(1)).toEqual([]);
    expect(broker.socket.sockets()[0]?.subscriptions).toEqual([]);
    expect(broker.socket.journal.map((record) => record.outcome)).toEqual([
      MockSocketOutcome.Unauthenticated,
      MockSocketOutcome.Unauthenticated,
    ]);
  });
});

describe('price.subscribe and price.update', () => {
  it('echoes the request and adds to the subscriptions', async () => {
    const client = await authed();
    client.socket.emit(BrokerSocketEvent.PriceSubscribe, { assets: [AAPL, EURUSD] });
    client.socket.emit(BrokerSocketEvent.PriceSubscribe, { assets: [EURUSD, BTCUSD] });
    expect(await client.waitFor(OBSERVED_EXTRA_EVENTS.PriceSubscribed, 2)).toEqual([
      { assets: [AAPL, EURUSD] },
      { assets: [EURUSD, BTCUSD] },
    ]);
    expect(broker.socket.sockets()[0]?.subscriptions).toEqual([EURUSD, AAPL, BTCUSD]);
  });

  it.each([
    ['no assets', { assets: [] }],
    ['41 assets', { assets: Array.from({ length: 41 }, (_, index) => index + 1) }],
    ['a string id', { assets: ['1'] }],
    ['no payload', undefined],
  ])('ignores %s', async (_name, payload) => {
    const client = await authed();
    client.socket.emit(BrokerSocketEvent.PriceSubscribe, payload);
    await client.expectQuiet(OBSERVED_EXTRA_EVENTS.PriceSubscribed);
    expect(broker.socket.sockets()[0]?.subscriptions).toEqual([]);
    expect(broker.socket.journal.at(-1)?.outcome).toBe(MockSocketOutcome.Invalid);
  });

  it('pushes a price only to the authenticated subscribers of that asset', async () => {
    const eur = await authed();
    const btc = await authed(broker, 2, OTHER_TOKEN);
    const anonymous = await connectClient();
    expect(broker.socket.pushPrice(EURUSD)).toBe(0);
    eur.socket.emit(BrokerSocketEvent.PriceSubscribe, { assets: [EURUSD] });
    btc.socket.emit(BrokerSocketEvent.PriceSubscribe, { assets: [BTCUSD] });
    await eur.waitFor(OBSERVED_EXTRA_EVENTS.PriceSubscribed);
    await btc.waitFor(OBSERVED_EXTRA_EVENTS.PriceSubscribed);

    const atMs = 1_790_000_000_000;
    expect(broker.socket.pushPrice(EURUSD, atMs)).toBe(1);
    const [update] = await eur.waitFor(BrokerSocketEvent.PriceUpdate);
    expect(safeParsePriceUpdate(update).success).toBe(true);
    expect(update).toEqual([EURUSD, broker.priceAt(EURUSD, atMs), atMs]);
    await btc.expectQuiet(BrokerSocketEvent.PriceUpdate);
    expect(anonymous.received).toEqual([]);
  });

  it('pushes every subscription at once, skipping ids without a pair', async () => {
    const client = await authed();
    client.socket.emit(BrokerSocketEvent.PriceSubscribe, { assets: [EURUSD, 999, AAPL] });
    await client.waitFor(OBSERVED_EXTRA_EVENTS.PriceSubscribed);
    expect(broker.socket.sockets()[0]?.subscriptions).toEqual([EURUSD, AAPL, 999]);
    expect(broker.socket.pushPrices(5_000)).toBe(2);
    const updates = await client.waitFor(BrokerSocketEvent.PriceUpdate, 2);
    expect(updates).toEqual([
      [EURUSD, broker.priceAt(EURUSD, 5_000), 5_000],
      [AAPL, broker.priceAt(AAPL, 5_000), 5_000],
    ]);
    expect(() => broker.socket.pushPrice(999)).toThrow(RangeError);
  });
});

// the live socket trade (#354): the REST record without is_demo
const withoutIsDemo = (trade: object | undefined) =>
  Object.fromEntries(Object.entries(trade ?? {}).filter(([key]) => key !== 'is_demo'));

describe('open_trade', () => {
  it.each(['demo', 'real'] as const)(
    'opens a %s trade: update_balance to every socket of the user, then success to the sender only',
    async (mode) => {
      const sender = await authed();
      const sibling = await authed();
      const stranger = await authed(broker, 2, OTHER_TOKEN);
      sender.socket.emit(ev(mode, 'open_trade'), tradeCommand());

      const [trade] = await sender.waitFor(ev(mode, 'open_trade.success'));
      expect(safeParseSocketOpenTradeSuccess(trade).success).toBe(true);
      // #354: the live socket form is the REST record without is_demo; the store keeps it
      expect(trade).toEqual(withoutIsDemo(broker.trades.list(1)[0]));
      expect(trade).not.toHaveProperty('is_demo');
      expect(broker.trades.list(1)[0]).toMatchObject({ is_demo: mode === 'demo' });
      expect(trade).toMatchObject({ symbol: 'EUR/USD' });
      expect(trade).toHaveProperty('close_timestamp');
      const events = sender.received.map((entry) => entry.event);
      expect(events.indexOf(ev(mode, 'update_balance'))).toBeLessThan(
        events.indexOf(ev(mode, 'open_trade.success')),
      );

      const { body } = await rest('/v1/broker/user');
      for (const client of [sender, sibling]) {
        const [balance] = await client.waitFor(ev(mode, 'update_balance'));
        expect(safeParseUpdateBalance(balance).success).toBe(true);
        expect(balance).toEqual((body as Record<TradeMode, unknown>)[mode]);
      }
      await sibling.expectQuiet(ev(mode, 'open_trade.success'));
      await stranger.expectQuiet(ev(mode, 'update_balance'));
    },
  );

  it.each([
    ['a missing duration', tradeCommand({ duration: undefined }), 'duration', 'required'],
    ['a numeric amount', tradeCommand({ amount: 10.5 }), 'amount', 'invalid'],
    ['a bad action', tradeCommand({ action: 'sideways' }), 'action', 'invalid'],
    ['no payload', undefined, 'asset_id', 'required'],
  ] as const)('refuses %s with a field', async (_name, payload, field, kind) => {
    const client = await authed();
    client.socket.emit(ev('real', 'open_trade'), payload);
    const [failures] = await client.waitFor(ev('real', 'open_trade.fail'));
    expect(safeParseOpenTradeFail(failures).success).toBe(true);
    expect(failures).toEqual([{ message: FIXTURE_MESSAGES[kind](field), field }]);
    expect(broker.trades.list(1)).toEqual([]);
    expect(broker.socket.journal.at(-1)?.outcome).toBe(MockSocketOutcome.Invalid);
  });

  it.each([
    ['too many decimals', { amount: '10.001' }, 'demo', FIXTURE_MESSAGES.amountPrecision],
    ['an unknown asset', { asset_id: 999 }, 'demo', LIVE_MESSAGES.unknownAsset],
    ['an unavailable asset', { asset_id: GBPUSD }, 'demo', FIXTURE_MESSAGES.assetUnavailable],
    ['a short duration', { duration: 1 }, 'demo', FIXTURE_MESSAGES.unsupportedDuration],
    ['a small amount', { amount: '0.50' }, 'demo', FIXTURE_MESSAGES.belowMinimum],
    ['an empty balance', { amount: '100.01' }, 'real', FIXTURE_MESSAGES.insufficientBalance],
  ] as const)('refuses %s with the REST text', async (_name, overrides, mode, message) => {
    const client = await authed();
    client.socket.emit(ev(mode, 'open_trade'), tradeCommand(overrides));
    expect(await client.waitFor(ev(mode, 'open_trade.fail'))).toEqual([[{ message }]]);
    expect(broker.trades.list(1)).toEqual([]);
    expect(broker.socket.journal.at(-1)?.outcome).toBe(MockSocketOutcome.Handled);
  });
});

describe('open_trade scripts', () => {
  it('fail answers the script and opens nothing, before validation', async () => {
    broker.socket.failNext('openTrade', { fail: [{ message: 'scripted', field: 'amount' }] });
    const client = await authed();
    client.socket.emit(ev('demo', 'open_trade'), 'not a command');
    expect(await client.waitFor(ev('demo', 'open_trade.fail'))).toEqual([
      [{ message: 'scripted', field: 'amount' }],
    ]);
    expect(broker.trades.list(1)).toEqual([]);
    expect(broker.socket.journal.at(-1)?.outcome).toBe(MockSocketOutcome.Scripted);
  });

  it.each<['fail' | 'delayMs', MockOpenTradeScript]>([
    ['fail', { fail: [{ message: 'scripted' }] }],
    ['delayMs', { delayMs: 50 }],
  ])('an unauthenticated open_trade consumes no %s script', async (kind, script) => {
    broker.socket.failNext('openTrade', script);
    const client = await connectClient();
    client.socket.emit(ev('demo', 'open_trade'), tradeCommand());
    await client.expectQuiet(ev('demo', 'open_trade.fail'));
    await client.expectQuiet(ev('demo', 'open_trade.success'));
    expect(broker.socket.pendingDelays).toBe(0);
    expect(broker.trades.list(1)).toEqual([]);
    expect(broker.socket.journal.at(-1)?.outcome).toBe(MockSocketOutcome.Unauthenticated);

    client.socket.emit(BrokerSocketEvent.UserAuth, { id: 1, token: TOKEN });
    await client.waitFor(BURST_END);
    client.socket.emit(ev('demo', 'open_trade'), tradeCommand());
    if (kind === 'fail') {
      expect(await client.waitFor(ev('demo', 'open_trade.fail'))).toEqual([
        [{ message: 'scripted' }],
      ]);
    } else {
      await until('the delayed open_trade', () => broker.socket.pendingDelays === 1);
      await client.waitFor(ev('demo', 'open_trade.success'));
    }
    expect(broker.socket.journal.at(-1)?.outcome).toBe(MockSocketOutcome.Scripted);
  });

  it.each([false, true])('silent with open: %s answers nothing', async (open) => {
    broker.socket.failNext('openTrade', { silent: true, open });
    const client = await authed();
    client.socket.emit(ev('demo', 'open_trade'), tradeCommand());
    await client.expectQuiet(ev('demo', 'open_trade.success'));
    expect(client.received.some((entry) => entry.event === ev('demo', 'open_trade.fail'))).toBe(
      false,
    );
    expect(broker.trades.list(1)).toHaveLength(open ? 1 : 0);
    // the balance moves with the store, so the sender still hears it: a balance is no answer
    expect(client.payloads(ev('demo', 'update_balance'))).toHaveLength(open ? 1 : 0);
  });

  it.each([false, true])('disconnect with open: %s drops the sender first', async (open) => {
    broker.socket.failNext('openTrade', { disconnect: true, open });
    const sender = await authed();
    const sibling = await authed();
    sender.socket.emit(ev('demo', 'open_trade'), tradeCommand());
    expect(await sender.disconnected).toBe('io server disconnect');
    if (open) await sibling.waitFor(ev('demo', 'update_balance'));
    else await sibling.expectQuiet(ev('demo', 'update_balance'));
    expect(broker.trades.list(1)).toHaveLength(open ? 1 : 0);
    expect(sender.received.map((entry) => entry.event)).toEqual(BURST);
  });

  it('disconnect with open: true opens nothing the store refuses, and tells no one', async () => {
    broker.socket.failNext('openTrade', { disconnect: true, open: true });
    const sender = await authed();
    sender.socket.emit(ev('real', 'open_trade'), tradeCommand({ amount: '500.00' }));
    await sender.disconnected;
    expect(broker.trades.list(1)).toEqual([]);
  });

  it('delayMs handles the command once the delay is over', async () => {
    broker.socket.failNext('openTrade', { delayMs: 300 });
    const client = await authed();
    client.socket.emit(ev('demo', 'open_trade'), tradeCommand());
    await until('the delayed open_trade', () => broker.socket.pendingDelays === 1);
    await client.expectQuiet(ev('demo', 'open_trade.success'));
    await client.waitFor(ev('demo', 'open_trade.success'));
    expect(broker.socket.pendingDelays).toBe(0);
    expect(broker.socket.journal.at(-1)?.outcome).toBe(MockSocketOutcome.Scripted);
  });

  it.each(['disconnect', 'revokeToken'] as const)(
    'delayMs still opens the trade after the sender left (%s)',
    async (trigger) => {
      broker.socket.failNext('openTrade', { delayMs: 50 });
      const client = await authed();
      client.socket.emit(ev('demo', 'open_trade'), tradeCommand());
      await until('the delayed open_trade', () => broker.socket.pendingDelays === 1);
      if (trigger === 'disconnect') {
        client.socket.disconnect();
      } else {
        broker.users.revokeToken(TOKEN);
        await client.waitFor(BrokerSocketEvent.UserDisconnectTokenExpired);
        await client.disconnected;
      }
      await until('the trade to open', () => broker.trades.list(1).length === 1);
      expect(broker.socket.pendingDelays).toBe(0);
      expect(broker.state.listenerErrors).toEqual([]);
    },
  );

  it('delayMs opens for the user who sent it when the socket re-authenticates as another', async () => {
    broker.socket.failNext('openTrade', { delayMs: 300 });
    const client = await authed();
    client.socket.emit(ev('demo', 'open_trade'), tradeCommand());
    await until('the delayed open_trade', () => broker.socket.pendingDelays === 1);
    client.socket.emit(BrokerSocketEvent.UserAuth, { id: 2, token: OTHER_TOKEN });
    await client.waitFor(BrokerSocketEvent.UserAuthSuccess, 2);
    await until('the trade to open', () => broker.trades.list(1).length === 1);
    expect(broker.trades.list(2)).toEqual([]);
    await client.expectQuiet(ev('demo', 'open_trade.success'));
  });

  it('is one queue for both modes', async () => {
    broker.socket.failNext('openTrade', { fail: [{ message: 'first' }] });
    const client = await authed();
    client.socket.emit(ev('real', 'open_trade'), tradeCommand());
    await client.waitFor(ev('real', 'open_trade.fail'));
    client.socket.emit(ev('demo', 'open_trade'), tradeCommand());
    await client.waitFor(ev('demo', 'open_trade.success'));
  });
});

describe('fan-out from the store', () => {
  it('a REST trade moves the balance on the socket', async () => {
    const client = await authed();
    const response = await fetch(`${broker.url}/v1/broker/user/trades`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...tradeCommand(), is_demo: true }),
    });
    expect(response.status).toBe(200);
    expect(await client.waitFor(ev('demo', 'update_balance'))).toEqual([broker.users.get(1).demo]);
  });

  it('settle sends close_trade.success, then update_balance, to every socket of the user', async () => {
    const first = await authed();
    const second = await authed();
    const stranger = await authed(broker, 2, OTHER_TOKEN);
    first.socket.emit(ev('real', 'open_trade'), tradeCommand());
    const [opened] = await first.waitFor(ev('real', 'open_trade.success'));
    const closed = broker.trades.settle((opened as { id: number }).id, { outcome: 'win' });

    for (const client of [first, second]) {
      const [success] = await client.waitFor(ev('real', 'close_trade.success'));
      expect(safeParseCloseTradeSuccess(success).success).toBe(true);
      expect(success).toEqual({ trades: [withoutIsDemo(closed)] });
      const balances = await client.waitFor(ev('real', 'update_balance'), 2);
      expect(balances.at(-1)).toEqual(broker.users.get(1).real);
      const events = client.received.map((entry) => entry.event);
      expect(events.indexOf(ev('real', 'close_trade.success'))).toBeLessThan(
        events.lastIndexOf(ev('real', 'update_balance')),
      );
    }
    await stranger.expectQuiet(ev('real', 'close_trade.success'));
  });

  it('pairs.update reaches the authenticated sockets only', async () => {
    const client = await authed();
    const anonymous = await connectClient();
    broker.pairs.update(EURUSD, { payout: 70 });
    const [update] = await client.waitFor(BrokerSocketEvent.CommonAssetsUpdate);
    expect(safeParseAssetsUpdate(update).success).toBe(true);
    expect(update).toEqual({ asset_id: EURUSD, payout: 70, scheduled_until: 0 });
    await anonymous.expectQuiet(BrokerSocketEvent.CommonAssetsUpdate);
  });

  it('revokeToken expires every socket of the user, and the token stops working everywhere', async () => {
    const first = await authed();
    const second = await authed();
    const stranger = await authed(broker, 2, OTHER_TOKEN);
    broker.users.revokeToken(TOKEN);
    for (const client of [first, second]) {
      expect(await client.waitFor(BrokerSocketEvent.UserDisconnectTokenExpired)).toEqual([null]);
      expect(await client.disconnected).toBe('io server disconnect');
    }
    expect((await rest('/v1/broker/user')).status).toBe(401);
    const again = await connectClient();
    again.socket.emit(BrokerSocketEvent.UserAuth, { id: 1, token: TOKEN });
    expect(await again.waitFor(BrokerSocketEvent.UserAuthError)).toEqual([
      { message: LIVE_MESSAGES.invalidToken },
    ]);
    expect(stranger.socket.connected).toBe(true);
  });
});

describe('the journal', () => {
  it('records an unknown event and counts an ack it never calls', async () => {
    const client = await authed();
    const ack = vi.fn();
    client.socket.emit('user.demo.something', { secret: 1 }, ack);
    client.socket.emit(BrokerSocketEvent.PriceSubscribe, { assets: [EURUSD] }, ack);
    await client.waitFor(OBSERVED_EXTRA_EVENTS.PriceSubscribed);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    expect(ack).not.toHaveBeenCalled();
    expect(broker.socket.journal.slice(1)).toEqual([
      {
        socketId: client.socket.id,
        event: 'user.demo.something',
        argc: 2,
        userId: 1,
        outcome: MockSocketOutcome.Unknown,
      },
      {
        socketId: client.socket.id,
        event: BrokerSocketEvent.PriceSubscribe,
        argc: 2,
        userId: 1,
        outcome: MockSocketOutcome.Handled,
      },
    ]);
    broker.socket.clearJournal();
    expect(broker.socket.journal).toEqual([]);
  });

  it('holds no token and no money', async () => {
    const client = await authed();
    client.socket.emit(ev('demo', 'open_trade'), tradeCommand());
    await client.waitFor(ev('demo', 'open_trade.success'));
    const text = JSON.stringify(broker.socket.journal);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('10.00');
  });
});

describe('disconnect', () => {
  it('drops the sockets of a user or one socket by id', async () => {
    const first = await authed();
    const second = await authed();
    const other = await authed(broker, 2, OTHER_TOKEN);
    expect(broker.socket.disconnect({ socketId: 'nope' })).toBe(0);
    expect(broker.socket.disconnect({ socketId: other.socket.id ?? '' })).toBe(1);
    expect(await other.disconnected).toBe('io server disconnect');
    expect(broker.socket.disconnect({ userId: 1 })).toBe(2);
    expect(await first.disconnected).toBe('io server disconnect');
    expect(await second.disconnected).toBe('io server disconnect');
    await until('every socket to close', () => broker.socket.sockets().length === 0);
  });
});

describe('cutTransport', () => {
  it('closes the transport without a DISCONNECT packet, so a reconnecting client comes back', async () => {
    const plain = await authed();
    const other = await authed(broker, 2, OTHER_TOKEN);
    // a socket's id is cleared on disconnect
    const ids = [plain.socket.id, other.socket.id];
    expect(broker.socket.cutTransport({ socketId: 'nope' })).toBe(0);
    expect(broker.socket.cutTransport({ userId: 1 })).toBe(1);
    expect(await plain.disconnected).toBe('transport close');
    expect(other.socket.connected).toBe(true);

    const socket = io(broker.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnectionDelay: 10,
      reconnectionDelayMax: 20,
    });
    clients.push(socket);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    const firstId = socket.id;
    expect(broker.socket.cutTransport({ socketId: firstId ?? '' })).toBe(1);
    await until('the reconnection', () => socket.connected && socket.id !== firstId);
    expect(broker.socket.journal.map((record) => record.socketId)).toEqual(ids);
  });
});

describe('emitRaw', () => {
  it('sends exactly the given arguments, outside the payload form, and journals nothing', async () => {
    const bytes = await startMockBroker({ socketPayload: MockSocketPayload.Bytes });
    bytes.users.register({ id: 1, accessToken: TOKEN });
    bytes.users.register({ id: 2, accessToken: OTHER_TOKEN });
    try {
      const client = await authed(bytes);
      const other = await authed(bytes, 2, OTHER_TOKEN);
      bytes.socket.clearJournal();
      expect(bytes.socket.emitRaw({ socketId: 'nope' }, 'price.update', 'x')).toBe(0);
      expect(
        bytes.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.PriceUpdate, '[1,2', { extra: 1 }),
      ).toBe(1);
      expect(bytes.socket.emitRaw({ socketId: client.socket.id ?? '' }, 'user.unheard.of')).toBe(1);
      await client.waitFor('user.unheard.of');
      expect(client.received.slice(BURST.length)).toEqual([
        { event: BrokerSocketEvent.PriceUpdate, args: ['[1,2', { extra: 1 }] },
        { event: 'user.unheard.of', args: [] },
      ]);
      await other.expectQuiet(BrokerSocketEvent.PriceUpdate);
      expect(bytes.socket.journal).toEqual([]);
    } finally {
      await bytes.close();
    }
  });
});

describe('close()', () => {
  it('returns at once with a client connected, a socket delay, a REST delay and a REST hang', async () => {
    const client = await authed();
    // both delays outlive the ceiling: a close() that waits for them is red
    broker.socket.failNext('openTrade', { delayMs: 2 * UNIT_WAIT_CEILING_MS });
    client.socket.emit(ev('demo', 'open_trade'), tradeCommand());
    await until('the delayed open_trade', () => broker.socket.pendingDelays === 1);
    broker.rest.failNext('user', { delayMs: 2 * UNIT_WAIT_CEILING_MS });
    broker.rest.failNext('pairs', { hang: true });
    const delayedRest = fetch(`${broker.url}/v1/broker/user`).catch(() => 'cut');
    const hungRest = fetch(`${broker.url}/v1/broker/pairs/binary`).then((r) => r.status);
    await until('the hanging request', () => broker.rest.pendingHangs === 1);

    const started = Date.now();
    await broker.close();
    expect(Date.now() - started).toBeLessThan(UNIT_WAIT_CEILING_MS);
    expect(await client.disconnected).toBe('io server disconnect');
    expect(await hungRest).toBe(503);
    expect(await delayedRest).toBe('cut');
    expect(broker.socket.pendingDelays).toBe(0);
    expect(broker.trades.list(1)).toEqual([]);
    expect(broker.rest.journal.some((record) => record.bearer === 'pending')).toBe(false);
    // a second close() (afterEach) does not throw
    await expect(broker.close()).resolves.toBeUndefined();
  });
});

describe.each(Object.values(MockSocketPayload))('socketPayload %s', (form) => {
  let encoded: MockBroker;

  beforeEach(async () => {
    encoded = await startMockBroker({ socketPayload: form });
    encoded.users.register({ id: 1, accessToken: TOKEN });
  });

  afterEach(async () => {
    for (const socket of clients.splice(0)) socket.disconnect();
    await encoded.close();
  });

  const rawMatches = (raw: unknown) => {
    switch (form) {
      case MockSocketPayload.Object:
        return typeof raw === 'object' && raw !== null && !Buffer.isBuffer(raw) && !('data' in raw);
      case MockSocketPayload.Json:
        return typeof raw === 'string';
      case MockSocketPayload.Bytes:
        return Buffer.isBuffer(raw);
      case MockSocketPayload.Envelope:
        return (
          typeof raw === 'object' && raw !== null && Array.isArray((raw as { data?: unknown }).data)
        );
    }
  };

  it('delivers every payload in the form and decodes to the same objects; null stays null', async () => {
    const client = await authed(encoded);
    expect(client.received[0]?.args).toEqual([null]);
    for (const entry of client.received.slice(1)) expect(rawMatches(entry.args[0])).toBe(true);
    expect(client.payloads(BrokerSocketEvent.UserData)).toEqual([encoded.users.get(1)]);
    expect(client.payloads(BrokerSocketEvent.CommonAssetsList)).toEqual([encoded.pairs.list()]);

    client.socket.emit(BrokerSocketEvent.PriceSubscribe, { assets: [EURUSD] });
    await client.waitFor(OBSERVED_EXTRA_EVENTS.PriceSubscribed);
    encoded.socket.pushPrice(EURUSD, 1_000);
    expect(await client.waitFor(BrokerSocketEvent.PriceUpdate)).toEqual([
      [EURUSD, encoded.priceAt(EURUSD, 1_000), 1_000],
    ]);

    client.socket.emit(ev('demo', 'open_trade'), tradeCommand());
    const [trade] = await client.waitFor(ev('demo', 'open_trade.success'));
    expect(trade).toEqual(withoutIsDemo(encoded.trades.list(1)[0]));
    for (const entry of client.received.slice(1)) expect(rawMatches(entry.args[0])).toBe(true);
  });
});

it('refuses an unknown socketPayload before listening', async () => {
  // @ts-expect-error not a MockSocketPayload
  await expect(startMockBroker({ socketPayload: 'x' })).rejects.toThrow(RangeError);
});

// Every server->client event of shared's contract, emitted by the fixture within one test, so a
// filtered run cannot make it pass or fail by the order of the tests above.
const CONTRACT_EVENTS = [
  BrokerSocketEvent.UserAuthSuccess,
  BrokerSocketEvent.UserAuthError,
  BrokerSocketEvent.UserDisconnectTokenExpired,
  BrokerSocketEvent.PriceUpdate,
  BrokerSocketEvent.CommonAssetsList,
  BrokerSocketEvent.CommonAssetsUpdate,
  BrokerSocketEvent.UserData,
  ...(['demo', 'real'] as const).flatMap((mode) =>
    (
      ['open_trade.success', 'open_trade.fail', 'close_trade.success', 'update_balance'] as const
    ).map((event) => modeEvent(mode, event)),
  ),
];
type Uncovered = Exclude<keyof BrokerServerToClientEvents, (typeof CONTRACT_EVENTS)[number]>;
const everyContractEventListed: [Uncovered] extends [never] ? true : never = true;

it('emits every server->client event of the shared contract', async () => {
  expect(everyContractEventListed).toBe(true);
  const failing = await connectClient();
  failing.socket.emit(BrokerSocketEvent.UserAuth, { id: 1, token: 'nope' });
  await failing.waitFor(BrokerSocketEvent.UserAuthError);

  const client = await authed();
  client.socket.emit(BrokerSocketEvent.PriceSubscribe, { assets: [EURUSD] });
  await client.waitFor(OBSERVED_EXTRA_EVENTS.PriceSubscribed);
  broker.socket.pushPrice(EURUSD);
  broker.pairs.update(EURUSD, { payout: 80 });
  for (const mode of ['demo', 'real'] as const) {
    client.socket.emit(ev(mode, 'open_trade'), tradeCommand({ amount: '0.01' }));
    client.socket.emit(ev(mode, 'open_trade'), tradeCommand());
    const [trade] = await client.waitFor(ev(mode, 'open_trade.success'));
    broker.trades.settle((trade as { id: number }).id, { outcome: 'loss' });
    await client.waitFor(ev(mode, 'close_trade.success'));
  }
  broker.users.revokeToken(TOKEN);
  await client.disconnected;

  const seen = new Set([...failing.received, ...client.received].map((entry) => entry.event));
  expect(CONTRACT_EVENTS.filter((event) => !seen.has(event))).toEqual([]);
  expect(new Set(CONTRACT_EVENTS).size).toBe(15);
});
