import {
  isDecimalString,
  safeParseBinaryPairs,
  safeParseBrokerUser,
  safeParseClosedTrade,
  safeParseOpenTrade,
  type DecimalString,
  type OpenTradeRequestWire,
} from '@binarius/shared';
import { describe, expect, it, vi } from 'vitest';
import { createBrokerState, DEFAULT_PAIRS, type MockChange, type MockOpenTradeWire } from './state';

const EURUSD = 101;
const AAPL = 202;
const GBPUSD = 404;

const amount = (value: string) => value as DecimalString;

function request(overrides: Partial<OpenTradeRequestWire> = {}): OpenTradeRequestWire {
  return {
    asset_id: EURUSD,
    amount: amount('10.00'),
    action: 'up',
    duration: 60,
    is_demo: true,
    ...overrides,
  };
}

function stateWithUser(
  seed: Partial<Parameters<ReturnType<typeof createBrokerState>['registerUser']>[0]> = {},
) {
  const state = createBrokerState();
  state.registerUser({ id: 1, accessToken: 'token-1', ...seed });
  return state;
}

function open(
  state: ReturnType<typeof createBrokerState>,
  overrides: Partial<OpenTradeRequestWire> = {},
) {
  const result = state.openTrade(1, request(overrides));
  if (!result.ok) throw new Error(result.message);
  return result.trade;
}

function moneyFields(user: ReturnType<ReturnType<typeof createBrokerState>['getUser']>) {
  return [user.min_trade_amount, ...Object.values(user.demo), ...Object.values(user.real)];
}

describe('users', () => {
  it('registers with the documented defaults, in the shared contract shape', () => {
    const user = stateWithUser().getUser(1);
    expect(user).toEqual({
      id: 1,
      level: { code: 'standard', rank: 1 },
      min_trade_amount: '1.00',
      demo: { available: '10000.00', held: '0.00', total: '10000.00' },
      real: { available: '0.00', held: '0.00', total: '0.00' },
    });
    expect(safeParseBrokerUser(user).success).toBe(true);
    for (const value of moneyFields(user)) expect(isDecimalString(value)).toBe(true);
  });

  it('takes the seed over the defaults', () => {
    const user = stateWithUser({
      level: { code: 'vip', rank: 3 },
      minTradeAmount: '5',
      demo: { available: '1.5' },
      real: { available: '250.25' },
    }).getUser(1);
    expect(user).toMatchObject({
      level: { code: 'vip', rank: 3 },
      min_trade_amount: '5.00',
      demo: { available: '1.50', total: '1.50' },
      real: { available: '250.25', total: '250.25' },
    });
  });

  it('refuses a duplicate id, a taken or empty token and an amount it cannot hold', () => {
    const state = stateWithUser();
    expect(() => state.registerUser({ id: 1, accessToken: 'other' })).toThrow(/already exists/);
    expect(() => state.registerUser({ id: 2, accessToken: 'token-1' })).toThrow(/taken/);
    expect(() => state.registerUser({ id: 3, accessToken: '' })).toThrow(/empty/);
    expect(() =>
      state.registerUser({ id: 4, accessToken: 't4', demo: { available: '1.001' } }),
    ).toThrow(RangeError);
    expect(() => state.getUser(99)).toThrow(/unknown mock user/);
  });

  it('authenticates by token until the token is revoked', () => {
    const state = stateWithUser();
    expect(state.authenticate('token-1')).toBe(1);
    expect(state.authenticate('nope')).toBeUndefined();
    state.revokeToken('token-1');
    expect(state.authenticate('token-1')).toBeUndefined();
  });
});

describe('pairs', () => {
  it('serves DEFAULT_PAIRS in the shared contract shape, with ms scheduled_until', () => {
    const pairs = createBrokerState().listPairs();
    expect(pairs).toEqual(DEFAULT_PAIRS);
    expect(safeParseBinaryPairs(pairs).success).toBe(true);
    expect(pairs.find((pair) => pair.id === GBPUSD)?.scheduled_until).toBeGreaterThan(1e12);
  });

  it('hands out copies, and update changes the store and announces it', () => {
    const state = createBrokerState();
    const changes: MockChange[] = [];
    state.onChange((change) => changes.push(change));
    const copy = state.listPairs()[0];
    if (copy !== undefined) copy.payout = 1;
    expect(state.findPair(EURUSD)?.payout).toBe(85);
    state.updatePair(EURUSD, { payout: 70, scheduled_until: 5 });
    expect(state.findPair(EURUSD)).toMatchObject({ payout: 70, scheduled_until: 5 });
    expect(changes).toEqual([
      { type: 'pair_updated', pair: expect.objectContaining({ id: EURUSD, payout: 70 }) },
    ]);
    expect(() => state.updatePair(999, { payout: 1 })).toThrow(/unknown mock asset/);
  });
});

describe('openTrade', () => {
  it('opens a trade with the documented fields and moves the stake to held', () => {
    const state = stateWithUser();
    const before = Date.now();
    const trade = open(state, { amount: amount('3.33'), duration: 120 });
    const after = Date.now();

    expect(trade).toMatchObject({
      id: 1,
      asset_id: EURUSD,
      action: 'up',
      amount: '3.33',
      payout: 85,
      // floor(333 * 85 / 100) = 283 cents
      potential_profit: '2.83',
      is_demo: true,
      source: 'api',
      broker_client_id: null,
      symbol: 'EUR/USD',
    });
    expect(trade.open_timestamp).toBeGreaterThanOrEqual(before);
    expect(trade.open_timestamp).toBeLessThanOrEqual(after);
    expect(trade.close_timestamp).toBe(trade.open_timestamp + 120_000);
    expect(trade.open_price).toBe(state.priceAt(EURUSD, trade.open_timestamp));
    expect(safeParseOpenTrade(trade).success).toBe(true);
    expect(state.getUser(1).demo).toEqual({
      available: '9996.67',
      held: '3.33',
      total: '10000.00',
    });
    expect(state.getUser(1).real).toEqual({ available: '0.00', held: '0.00', total: '0.00' });
  });

  // documents why the fixture's own tests check these two fields on the raw body: the day shared
  // adds them to its schema this fails, and the separate checks can go
  it('carries close_timestamp and symbol that the shared parse drops', () => {
    const trade = open(stateWithUser());
    const parsed = safeParseOpenTrade(trade);
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('close_timestamp');
    expect(parsed.data).not.toHaveProperty('symbol');
  });

  it('takes the real balance for is_demo false', () => {
    const state = stateWithUser({ real: { available: '20.00' } });
    open(state, { is_demo: false, amount: amount('20') });
    expect(state.getUser(1).real).toEqual({ available: '0.00', held: '20.00', total: '20.00' });
    expect(state.getUser(1).demo.available).toBe('10000.00');
    expect(state.openTrade(1, request({ is_demo: false, amount: amount('1') }))).toEqual({
      ok: false,
      message: 'Insufficient balance',
    });
  });

  it('refuses in the documented order', () => {
    const state = stateWithUser({ demo: { available: '5.00' }, minTradeAmount: '2.00' });
    const refusal = (overrides: Partial<OpenTradeRequestWire>) => {
      const result = state.openTrade(1, request(overrides));
      return result.ok ? 'opened' : result.message;
    };
    // every check after the named one fails too, so the first failing check is the one reported
    expect(refusal({ amount: amount('0.001'), asset_id: 999, duration: 1 })).toBe(
      'Validation failed: "amount" must have at most 2 decimal places',
    );
    expect(refusal({ amount: amount('100'), asset_id: 999, duration: 1 })).toBe('Unknown asset');
    expect(refusal({ amount: amount('100'), asset_id: GBPUSD, duration: 1 })).toBe(
      'Asset is not available',
    );
    expect(refusal({ amount: amount('1'), duration: 1 })).toBe('Unsupported duration');
    expect(refusal({ amount: amount('1') })).toBe('Amount is below the minimum');
    expect(refusal({ amount: amount('5.01') })).toBe('Insufficient balance');
    expect(state.getUser(1).demo).toEqual({ available: '5.00', held: '0.00', total: '5.00' });
  });

  it('accepts the boundaries: amount at the minimum and at the whole balance, both duration ends', () => {
    const state = stateWithUser({ demo: { available: '7.00' }, minTradeAmount: '2.00' });
    open(state, { amount: amount('2.00'), duration: 60 });
    open(state, { amount: amount('5.00'), duration: 3600 });
    expect(state.getUser(1).demo).toEqual({ available: '0.00', held: '7.00', total: '7.00' });
    const longer = state.openTrade(1, request({ amount: amount('2'), duration: 3601 }));
    expect(longer).toEqual({ ok: false, message: 'Unsupported duration' });
    const shorter = state.openTrade(1, request({ amount: amount('2'), duration: 59 }));
    expect(shorter).toEqual({ ok: false, message: 'Unsupported duration' });
  });

  it('reads scheduled_until as "not tradable until": a past value is tradable', () => {
    const state = stateWithUser();
    state.updatePair(GBPUSD, { scheduled_until: Date.now() - 1 });
    expect(state.openTrade(1, request({ asset_id: GBPUSD })).ok).toBe(true);
    state.updatePair(GBPUSD, { scheduled_until: Date.now() + 60_000 });
    expect(state.openTrade(1, request({ asset_id: GBPUSD }))).toEqual({
      ok: false,
      message: 'Asset is not available',
    });
  });

  it('keeps the payout the trade was opened with when the pair changes later', () => {
    const state = stateWithUser();
    const trade = open(state);
    state.updatePair(EURUSD, { payout: 50 });
    expect(state.listTrades(1, { limit: 20, offset: 0 })[0]).toMatchObject({
      id: trade.id,
      payout: 85,
      potential_profit: '8.50',
    });
  });

  it('announces the opened trade', () => {
    const state = stateWithUser();
    const listener = vi.fn();
    const unsubscribe = state.onChange(listener);
    const trade = open(state);
    expect(listener).toHaveBeenCalledWith({ type: 'trade_opened', userId: 1, trade });
    unsubscribe();
    open(state);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('settle', () => {
  it('pays stake plus profit on a win', () => {
    const state = stateWithUser();
    const trade = open(state, { amount: amount('10') });
    const closed = state.settle(Number(trade.id), { outcome: 'win' });
    expect(closed).toMatchObject({ id: trade.id, profit: '8.50', symbol: 'EUR/USD' });
    expect(closed.close_timestamp).toBe(trade.close_timestamp);
    expect(safeParseClosedTrade(closed).success).toBe(true);
    expect(state.getUser(1).demo).toEqual({
      available: '10008.50',
      held: '0.00',
      total: '10008.50',
    });
  });

  it('keeps the stake on a loss and reports a negative profit', () => {
    const state = stateWithUser();
    const trade = open(state, { amount: amount('10') });
    const closed = state.settle(Number(trade.id), { outcome: 'loss' });
    expect(closed.profit).toBe('-10.00');
    expect(isDecimalString(closed.profit)).toBe(true);
    expect(state.getUser(1).demo).toEqual({ available: '9990.00', held: '0.00', total: '9990.00' });
  });

  it.each([
    ['up', 'win', 1],
    ['up', 'loss', -1],
    ['down', 'win', -1],
    ['down', 'loss', 1],
  ] as const)('picks a close price that agrees with %s / %s', (action, outcome, side) => {
    const state = stateWithUser();
    // several trades, so both branches (the curve agrees / it is mirrored) are exercised
    for (let i = 0; i < 6; i += 1) {
      const trade = open(state, { action });
      const closed = state.settle(Number(trade.id), {
        outcome,
        closeTimestamp: trade.open_timestamp + i * 97_000,
      });
      expect(Math.sign(closed.close_price - trade.open_price)).toBe(side);
      expect(String(closed.close_price).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(5);
    }
  });

  it('takes an explicit close price and close timestamp as given', () => {
    const state = stateWithUser();
    const trade = open(state, { action: 'up' });
    const closed = state.settle(Number(trade.id), {
      outcome: 'win',
      closePrice: trade.open_price - 1,
      closeTimestamp: 1_800_000_000_000,
    });
    expect(closed.close_price).toBe(trade.open_price - 1);
    expect(closed.close_timestamp).toBe(1_800_000_000_000);
  });

  it('refuses a second settle and an unknown trade, without touching balances', () => {
    const state = stateWithUser();
    const trade = open(state, { amount: amount('10') });
    state.settle(Number(trade.id), { outcome: 'win' });
    const user = state.getUser(1);
    expect(() => state.settle(Number(trade.id), { outcome: 'win' })).toThrow(/already settled/);
    expect(() => state.settle(999, { outcome: 'loss' })).toThrow(/unknown mock trade/);
    expect(state.getUser(1)).toEqual(user);
  });

  it('announces the closed trade', () => {
    const state = stateWithUser();
    const trade = open(state);
    const changes: MockChange[] = [];
    state.onChange((change) => changes.push(change));
    const closed = state.settle(Number(trade.id), { outcome: 'loss' });
    expect(changes).toEqual([{ type: 'trade_closed', userId: 1, trade: closed }]);
  });
});

describe('listTrades', () => {
  function seeded() {
    const state = stateWithUser({ real: { available: '100' } });
    state.registerUser({ id: 2, accessToken: 'token-2' });
    const opened: MockOpenTradeWire[] = [];
    for (const isDemo of [true, false, true, false, true])
      opened.push(open(state, { is_demo: isDemo }));
    state.openTrade(2, request());
    const [first, second] = opened;
    if (first === undefined || second === undefined) throw new Error('seed failed');
    state.settle(Number(first.id), { outcome: 'win' });
    state.settle(Number(second.id), { outcome: 'loss' });
    return { state, ids: opened.map((trade) => trade.id) };
  }

  const ids = (trades: { id: unknown }[]) => trades.map((trade) => trade.id);

  it('lists only the caller own trades, newest first, open and closed together', () => {
    const { state } = seeded();
    const trades = state.listTrades(1, { limit: 20, offset: 0 });
    expect(ids(trades)).toEqual([5, 4, 3, 2, 1]);
    expect(ids(state.listTrades(2, { limit: 20, offset: 0 }))).toEqual([6]);
    for (const trade of trades) {
      const parsed = 'profit' in trade ? safeParseClosedTrade(trade) : safeParseOpenTrade(trade);
      expect(parsed.success).toBe(true);
      expect(trade.symbol).toBe('EUR/USD');
    }
  });

  it('filters by status and mode', () => {
    const { state } = seeded();
    expect(ids(state.listTrades(1, { status: 'open', limit: 20, offset: 0 }))).toEqual([5, 4, 3]);
    expect(ids(state.listTrades(1, { status: 'closed', limit: 20, offset: 0 }))).toEqual([2, 1]);
    expect(ids(state.listTrades(1, { isDemo: false, limit: 20, offset: 0 }))).toEqual([4, 2]);
    expect(
      ids(state.listTrades(1, { status: 'closed', isDemo: true, limit: 20, offset: 0 })),
    ).toEqual([1]);
  });

  it('pages with limit and offset', () => {
    const { state } = seeded();
    expect(ids(state.listTrades(1, { limit: 2, offset: 0 }))).toEqual([5, 4]);
    expect(ids(state.listTrades(1, { limit: 2, offset: 2 }))).toEqual([3, 2]);
    expect(ids(state.listTrades(1, { limit: 2, offset: 4 }))).toEqual([1]);
    expect(state.listTrades(1, { limit: 2, offset: 6 })).toEqual([]);
  });
});

describe('priceAt', () => {
  it('is deterministic per asset, rounded to the pair digits, and refuses an unknown asset', () => {
    const state = createBrokerState();
    const at = 1_790_000_000_000;
    expect(state.priceAt(AAPL, at)).toBe(createBrokerState().priceAt(AAPL, at));
    expect(state.priceAt(AAPL, at)).not.toBe(state.priceAt(EURUSD, at));
    expect(String(state.priceAt(AAPL, at)).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
    expect(() => state.priceAt(999, at)).toThrow(/unknown mock asset/);
  });
});
