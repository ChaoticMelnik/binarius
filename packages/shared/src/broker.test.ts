import { describe, expect, it } from 'vitest';
import {
  CHART_INTERVAL_PATTERN,
  chartRequestWireSchema,
  isClosedTrade,
  openTradeRequestWireSchema,
  parseBinaryPair,
  parseBinaryPairs,
  parseBrokerError,
  parseBrokerUser,
  parseCandles,
  parseClosedTrade,
  parseOpenTrade,
  parseTradesList,
  safeParseBinaryPair,
  safeParseBinaryPairs,
  safeParseBrokerBalance,
  safeParseBrokerUser,
  safeParseCandles,
  safeParseOpenTrade,
  safeParseTradesList,
  toChartRequestWire,
  toOpenTradeRequestWire,
} from './broker';
import { isDecimalString, type DecimalString } from './money';

const pairWire = {
  id: 91,
  symbol: 'EUR/USD',
  type: 'currency',
  digits: 5,
  payout: 85,
  max_payout: 92,
  min_timeframe: 60,
  max_timeframe: 3600,
  scheduled_until: 0,
};

const balanceWire = { available: '9990.00', held: '10.00', total: '10000.00' };

const userWire = {
  id: 1001,
  level: { code: 'standard', rank: 1, badge: 'ignored-extra' },
  min_trade_amount: '1.00',
  real: balanceWire,
  demo: balanceWire,
};

const openTradeWire = {
  id: 'trade-1',
  asset_id: 91,
  action: 'up',
  amount: '10.00',
  payout: 85,
  potential_profit: '8.50',
  open_price: 1.08765,
  open_timestamp: 1790028496624,
  is_demo: true,
  source: 'api',
  broker_client_id: null,
};

const closedTradeWire = {
  id: 7,
  asset_id: 91,
  action: 'down',
  amount: '10.00',
  payout: 85,
  open_price: 1.08765,
  open_timestamp: 1790028496624,
  is_demo: false,
  close_price: 1.0871,
  close_timestamp: 1790028556624,
  profit: '8.50',
};

describe('BinaryPair', () => {
  it('maps snake_case to camelCase and keeps scheduled_until untouched', () => {
    expect(parseBinaryPair({ ...pairWire, is_otc: true })).toEqual({
      id: 91,
      symbol: 'EUR/USD',
      isOtc: true,
      type: 'currency',
      digits: 5,
      payout: 85,
      maxPayout: 92,
      minTimeframe: 60,
      maxTimeframe: 3600,
      scheduledUntil: 0,
    });
  });

  it('omits isOtc when the wire omits is_otc', () => {
    expect(parseBinaryPair(pairWire)).not.toHaveProperty('isOtc');
  });

  it('parses a list', () => {
    expect(parseBinaryPairs([pairWire, pairWire])).toHaveLength(2);
    expect(safeParseBinaryPairs([pairWire, { ...pairWire, id: 'x' }]).success).toBe(false);
  });

  it.each([
    ['id', '91'],
    ['digits', 5.5],
    ['scheduled_until', -1],
    ['payout', '85'],
  ])('rejects %s=%j', (field, value) => {
    expect(safeParseBinaryPair({ ...pairWire, [field]: value }).success).toBe(false);
  });
});

describe('BrokerUser', () => {
  it('maps the user with balances and normalizes the id to a string', () => {
    expect(parseBrokerUser(userWire)).toEqual({
      id: '1001',
      level: { code: 'standard', rank: 1 },
      minTradeAmount: '1.00',
      real: { available: '9990.00', held: '10.00', total: '10000.00' },
      demo: { available: '9990.00', held: '10.00', total: '10000.00' },
    });
  });

  it('accepts a string id', () => {
    expect(parseBrokerUser({ ...userWire, id: 'u-1' }).id).toBe('u-1');
  });

  it('exposes a safe balance parser', () => {
    expect(safeParseBrokerBalance(balanceWire).success).toBe(true);
    expect(safeParseBrokerBalance({ ...balanceWire, held: 0.30000000000000004 }).success).toBe(
      false,
    );
  });

  // the shape GET /v1/broker/user answered live on 2026-10-02: every money field a JSON integer
  it('converts the live all-integer user to decimal strings', () => {
    const live = {
      id: 1001,
      level: { code: 'standard', rank: 1 },
      min_trade_amount: 1,
      real: { available: 0, held: 0, total: 0 },
      demo: { available: 9990, held: 10, total: 10000 },
    };
    const user = parseBrokerUser(live);
    expect(user).toEqual({
      id: '1001',
      level: { code: 'standard', rank: 1 },
      minTradeAmount: '1',
      real: { available: '0', held: '0', total: '0' },
      demo: { available: '9990', held: '10', total: '10000' },
    });
    const money = [user.minTradeAmount, ...Object.values(user.real), ...Object.values(user.demo)];
    expect(money.every(isDecimalString)).toBe(true);
  });

  // the live probe of 2026-10-03 after a 1.5 demo stake: available/held fractions, total an integer
  it('converts the mixed-form user of the live probe to decimal strings', () => {
    const user = parseBrokerUser({
      ...userWire,
      min_trade_amount: 1,
      demo: { available: 9998.5, held: 1.5, total: 10000 },
    });
    expect(user.minTradeAmount).toBe('1');
    expect(user.demo).toEqual({ available: '9998.5', held: '1.5', total: '10000' });
  });

  it.each([
    ['min_trade_amount', 1e-7],
    ['demo', { ...balanceWire, held: 0.30000000000000004 }],
    ['demo', { ...balanceWire, available: 2 ** 53 }],
    ['level', { code: 'standard' }],
  ])('rejects %s=%j', (field, value) => {
    expect(safeParseBrokerUser({ ...userWire, [field]: value }).success).toBe(false);
  });
});

describe('Candles', () => {
  it('maps five- and six-element tuples', () => {
    expect(
      parseCandles([
        [1790028496624, 1.1, 1.2, 1.0, 1.15],
        [1790028556624, 1.15, 1.3, 1.1, 1.25, 1200],
      ]),
    ).toEqual([
      { timestamp: 1790028496624, open: 1.1, high: 1.2, low: 1.0, close: 1.15 },
      { timestamp: 1790028556624, open: 1.15, high: 1.3, low: 1.1, close: 1.25, volume: 1200 },
    ]);
  });

  it.each([[[1790028496624, 1.1, 1.2, 1.0]], [[1790028496.5, 1.1, 1.2, 1.0, 1.15]], [['x']]])(
    'rejects %j',
    (candle) => {
      expect(safeParseCandles([candle]).success).toBe(false);
    },
  );
});

describe('Trades', () => {
  it('maps an open trade', () => {
    expect(parseOpenTrade(openTradeWire)).toEqual({
      id: 'trade-1',
      assetId: 91,
      action: 'up',
      amount: '10.00',
      payout: 85,
      potentialProfit: '8.50',
      openPrice: 1.08765,
      openTimestamp: 1790028496624,
      isDemo: true,
      source: 'api',
      brokerClientId: null,
    });
  });

  it('maps a closed trade and normalizes a numeric id', () => {
    const trade = parseClosedTrade(closedTradeWire);
    expect(trade.id).toBe('7');
    expect(trade).toMatchObject({
      closePrice: 1.0871,
      closeTimestamp: 1790028556624,
      profit: '8.50',
    });
    expect(trade).not.toHaveProperty('potentialProfit');
    expect(trade).not.toHaveProperty('source');
    expect(trade).not.toHaveProperty('brokerClientId');
  });

  // the trade response shapes of 2026-10-03 were not recorded: money as JSON numbers is assumed
  it('converts fractional JSON-number money of an open and a lost closed trade', () => {
    expect(
      parseOpenTrade({ ...openTradeWire, amount: 1.5, potential_profit: 1.275 }),
    ).toMatchObject({ amount: '1.5', potentialProfit: '1.275' });
    expect(parseClosedTrade({ ...closedTradeWire, amount: 1.5, profit: -1.5 })).toMatchObject({
      amount: '1.5',
      profit: '-1.5',
    });
  });

  it.each([
    ['amount', 0.30000000000000004],
    ['potential_profit', 1e-7],
    ['action', 'UP'],
    ['source', 5],
    ['open_timestamp', 1790028496.6],
  ])('rejects %s=%j on an open trade', (field, value) => {
    expect(safeParseOpenTrade({ ...openTradeWire, [field]: value }).success).toBe(false);
  });

  it('keeps an unknown source label instead of dropping the trade', () => {
    expect(parseOpenTrade({ ...openTradeWire, source: 'manual' }).source).toBe('manual');
  });

  it('encodes an open-trade request for REST with is_demo', () => {
    expect(
      toOpenTradeRequestWire({
        assetId: 91,
        amount: '10.00' as DecimalString,
        action: 'up',
        durationSec: 60,
        isDemo: true,
      }),
    ).toEqual({ asset_id: 91, amount: '10.00', action: 'up', duration: 60, is_demo: true });
  });

  it.each(['0', '0.00', '-1'])('rejects the request amount %j', (amount) => {
    const wire = { asset_id: 91, amount: '10.00', action: 'up', duration: 60, is_demo: true };
    expect(openTradeRequestWireSchema.safeParse(wire).success).toBe(true);
    expect(openTradeRequestWireSchema.safeParse({ ...wire, amount }).success).toBe(false);
  });
});

describe('Trades list', () => {
  it('parses the empty list the live broker answered', () => {
    expect(parseTradesList({ trades: [] })).toEqual([]);
  });

  it('tells an open trade from a closed one', () => {
    const [open, closed] = parseTradesList({ trades: [openTradeWire, closedTradeWire] });
    expect(open && isClosedTrade(open)).toBe(false);
    expect(open).toEqual(parseOpenTrade(openTradeWire));
    expect(closed && isClosedTrade(closed)).toBe(true);
    expect(closed).toEqual(parseClosedTrade(closedTradeWire));
  });

  it('reads an open trade that carries its expiry as close_timestamp as open', () => {
    const [trade] = parseTradesList({
      trades: [{ ...openTradeWire, close_timestamp: 1790028556624 }],
    });
    expect(trade && isClosedTrade(trade)).toBe(false);
  });

  it('reads a closed trade that also carries potential_profit as closed', () => {
    const [trade] = parseTradesList({
      trades: [{ ...closedTradeWire, potential_profit: '8.50' }],
    });
    expect(trade && isClosedTrade(trade)).toBe(true);
  });

  it('converts integer trade money', () => {
    const [trade] = parseTradesList({ trades: [{ ...closedTradeWire, amount: 10, profit: -10 }] });
    expect(trade).toMatchObject({ amount: '10', profit: '-10' });
  });

  it.each([
    { trades: 'x' },
    [],
    { trades: [{ ...openTradeWire, amount: 0.30000000000000004 }] },
    { trades: [{ ...closedTradeWire, potential_profit: undefined, profit: undefined }] },
  ])('rejects %j', (input) => {
    expect(safeParseTradesList(input).success).toBe(false);
  });
});

describe('ChartRequest', () => {
  it('encodes all four query keys', () => {
    expect(
      toChartRequestWire({ assetId: 91, interval: '1m', limit: 100, startTime: 1790028496624 }),
    ).toEqual({ asset_id: 91, interval: '1m', limit: 100, start_time: 1790028496624 });
  });

  it.each(['250ms', '5s', '1m', '1h', '1d', '1w', '1M'])(
    'accepts the live interval %j',
    (value) => {
      expect(CHART_INTERVAL_PATTERN.test(value)).toBe(true);
    },
  );

  const wire = { asset_id: 91, interval: '1m', limit: 100, start_time: 1790028496624 };

  it.each([
    ['limit', 0],
    ['interval', ''],
    ['interval', 60],
    ['interval', '60'],
    ['interval', '1y'],
    ['start_time', -1],
    ['start_time', undefined],
  ])('rejects %s=%j', (field, value) => {
    expect(chartRequestWireSchema.safeParse(wire).success).toBe(true);
    expect(chartRequestWireSchema.safeParse({ ...wire, [field]: value }).success).toBe(false);
  });
});

describe('BrokerError', () => {
  it('maps the envelope with optional details', () => {
    expect(parseBrokerError({ error: { message: 'nope' } })).toEqual({ message: 'nope' });
    expect(parseBrokerError({ error: { message: 'nope', details: { field: 'amount' } } })).toEqual({
      message: 'nope',
      details: { field: 'amount' },
    });
  });
});
