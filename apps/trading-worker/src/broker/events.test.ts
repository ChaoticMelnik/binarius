import pino from 'pino';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  BrokerSocketEvent,
  modeEvent,
  TradeMode,
  type BrokerServerToClientEvents,
  type ModeScopedEvent,
} from '@binarius/shared';
import {
  BrokerEventProblemKind,
  BrokerEventType,
  MAX_EVENT_NAME_LENGTH,
  MAX_REPORTED_ISSUES,
  describeShape,
  normalizeBrokerEvent,
  SHAPE_MAX_KEY_LENGTH,
  SHAPE_MAX_KEYS,
  SHAPE_MAX_LENGTH,
  type BrokerEvent,
  type BrokerEventProblem,
  type NormalizedBrokerEvent,
} from './events';

type ServerEvent = keyof BrokerServerToClientEvents;

const pairWire = {
  id: 91,
  symbol: 'EUR/USD',
  is_otc: false,
  type: 'forex',
  digits: 5,
  payout: 85,
  max_payout: 90,
  min_timeframe: 5,
  max_timeframe: 3600,
  scheduled_until: 0,
};
const pair = {
  id: 91,
  symbol: 'EUR/USD',
  isOtc: false,
  type: 'forex',
  digits: 5,
  payout: 85,
  maxPayout: 90,
  minTimeframe: 5,
  maxTimeframe: 3600,
  scheduledUntil: 0,
};
const pairWithoutOtcWire = {
  id: 92,
  symbol: 'BTC/USD',
  type: 'crypto',
  digits: 2,
  payout: 80,
  max_payout: 88,
  min_timeframe: 60,
  max_timeframe: 600,
  scheduled_until: 1790028496,
};
const pairWithoutOtc = {
  id: 92,
  symbol: 'BTC/USD',
  type: 'crypto',
  digits: 2,
  payout: 80,
  maxPayout: 88,
  minTimeframe: 60,
  maxTimeframe: 600,
  scheduledUntil: 1790028496,
};
const balanceWire = { available: '1.00', held: '0', total: '1.00' };
const userWire = {
  id: 1,
  level: { code: 'c', rank: 0, extra: true },
  min_trade_amount: '1',
  real: balanceWire,
  demo: { available: '10000.00', held: '10.00', total: '10010.00' },
};
const user = {
  id: '1',
  level: { code: 'c', rank: 0 },
  minTradeAmount: '1',
  real: balanceWire,
  demo: { available: '10000.00', held: '10.00', total: '10010.00' },
};
// the live socket form (#354): no is_demo, the mode is the event's
const tradeBaseWire = {
  id: 1,
  asset_id: 91,
  action: 'up',
  amount: '10.00',
  payout: 85,
  open_price: 1.1,
  open_timestamp: 1790028496624,
};
const tradeBase = {
  id: '1',
  assetId: 91,
  action: 'up',
  amount: '10.00',
  payout: 85,
  openPrice: 1.1,
  openTimestamp: 1790028496624,
};
const openTradeWire = { ...tradeBaseWire, potential_profit: '8.50', broker_client_id: 'c-1' };
const openTrade = { ...tradeBase, potentialProfit: '8.50', brokerClientId: 'c-1' };
const closedTradeWire = {
  ...tradeBaseWire,
  source: 'api',
  close_price: 1.2,
  close_timestamp: 1790028556624,
  profit: '8.50',
};
const closedTrade = {
  ...tradeBase,
  source: 'api',
  closePrice: 1.2,
  closeTimestamp: 1790028556624,
  profit: '8.50',
};

interface PayloadCase {
  name: ServerEvent;
  wire: unknown;
  event: BrokerEvent;
}

const modeCases = (mode: TradeMode): PayloadCase[] => [
  {
    name: modeEvent(mode, 'open_trade.success'),
    wire: openTradeWire,
    event: {
      type: BrokerEventType.OpenTradeSuccess,
      mode,
      trade: { ...openTrade, isDemo: mode === TradeMode.Demo },
    } as BrokerEvent,
  },
  {
    name: modeEvent(mode, 'open_trade.fail'),
    wire: [{ message: 'too small', field: 'amount', extra: 1 }, { message: 'x' }],
    event: {
      type: BrokerEventType.OpenTradeFail,
      mode,
      failures: [{ message: 'too small', field: 'amount' }, { message: 'x' }],
    },
  },
  {
    name: modeEvent(mode, 'close_trade.success'),
    wire: { trades: [closedTradeWire] },
    event: {
      type: BrokerEventType.CloseTradeSuccess,
      mode,
      trades: [{ ...closedTrade, isDemo: mode === TradeMode.Demo }],
    } as BrokerEvent,
  },
  {
    name: modeEvent(mode, 'update_balance'),
    wire: balanceWire,
    event: { type: BrokerEventType.BalanceUpdate, mode, balance: balanceWire } as BrokerEvent,
  },
];

const payloadCases: PayloadCase[] = [
  {
    name: 'user.auth.error',
    wire: { message: 'bad token', token: 'leaked' },
    event: { type: BrokerEventType.AuthError, message: 'bad token' },
  },
  {
    name: 'price.update',
    wire: [91, 1.10234, 1790028496],
    event: {
      type: BrokerEventType.PriceUpdate,
      update: { assetId: 91, price: 1.10234, timestamp: 1790028496 },
    },
  },
  {
    name: 'common.assets_list',
    wire: [pairWire, pairWithoutOtcWire],
    event: { type: BrokerEventType.AssetsList, pairs: [pair, pairWithoutOtc] },
  },
  {
    name: 'common.assets_update',
    wire: { asset_id: 91, payout: 80 },
    event: { type: BrokerEventType.AssetsUpdate, update: { assetId: 91, payout: 80 } },
  },
  {
    name: 'user.data',
    wire: userWire,
    event: { type: BrokerEventType.UserData, user } as BrokerEvent,
  },
  ...modeCases(TradeMode.Demo),
  ...modeCases(TradeMode.Real),
];

// the live money form (2026-10-03): whole amounts JSON integers, fractions JSON fractions, in one
// object; the trade shapes were not recorded, so their money as numbers is assumed
const liveBalanceWire = { available: 9998.5, held: 1.5, total: 10000 };
const liveBalance = { available: '9998.5', held: '1.5', total: '10000' };
const liveTradeWire = { ...tradeBaseWire, amount: 1.5 };
const liveTrade = { ...tradeBase, amount: '1.5' };
const liveModeCases = (mode: TradeMode): PayloadCase[] => [
  {
    name: modeEvent(mode, 'open_trade.success'),
    wire: { ...liveTradeWire, potential_profit: 1.275 },
    event: {
      type: BrokerEventType.OpenTradeSuccess,
      mode,
      trade: { ...liveTrade, potentialProfit: '1.275', isDemo: mode === TradeMode.Demo },
    } as BrokerEvent,
  },
  {
    name: modeEvent(mode, 'close_trade.success'),
    wire: {
      trades: [
        { ...liveTradeWire, close_price: 1.0, close_timestamp: 1790028556624, profit: -1.5 },
      ],
    },
    event: {
      type: BrokerEventType.CloseTradeSuccess,
      mode,
      trades: [
        {
          ...liveTrade,
          closePrice: 1.0,
          closeTimestamp: 1790028556624,
          profit: '-1.5',
          isDemo: mode === TradeMode.Demo,
        },
      ],
    } as BrokerEvent,
  },
  {
    name: modeEvent(mode, 'update_balance'),
    wire: liveBalanceWire,
    event: { type: BrokerEventType.BalanceUpdate, mode, balance: liveBalance } as BrokerEvent,
  },
];
const liveNumberCases: PayloadCase[] = [
  {
    name: 'user.data',
    wire: {
      id: 1,
      level: { code: 'c', rank: 0 },
      min_trade_amount: 1,
      real: { available: 0, held: 0, total: 0 },
      demo: liveBalanceWire,
    },
    event: {
      type: BrokerEventType.UserData,
      user: {
        id: '1',
        level: { code: 'c', rank: 0 },
        minTradeAmount: '1',
        real: { available: '0', held: '0', total: '0' },
        demo: liveBalance,
      },
    } as BrokerEvent,
  },
  ...liveModeCases(TradeMode.Demo),
  ...liveModeCases(TradeMode.Real),
];

const PAYLOADLESS = ['user.auth.success', 'user.disconnect_token_expired'] as const;
const payloadlessType = {
  'user.auth.success': BrokerEventType.AuthSuccess,
  'user.disconnect_token_expired': BrokerEventType.TokenExpired,
} as const;

const bytesOf = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const FORMS: [string, (wire: unknown) => unknown][] = [
  ['JSON string', (wire) => JSON.stringify(wire)],
  [
    'ArrayBuffer',
    (wire) => {
      const bytes = bytesOf(wire);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  ],
  ['Uint8Array', (wire) => bytesOf(wire)],
  // the form observed live (2026-10-02); a small Buffer is a view into a shared pool
  ['Node Buffer', (wire) => Buffer.from(JSON.stringify(wire))],
  ['byte envelope', (wire) => ({ data: Array.from(bytesOf(wire)) })],
  ['already decoded', (wire) => structuredClone(wire)],
];

const expectProblem = (result: NormalizedBrokerEvent): BrokerEventProblem => {
  if (result.ok) throw new Error(`expected a problem, got ${JSON.stringify(result.event)}`);
  return result.problem;
};

describe('normalizeBrokerEvent: live number form × payload forms', () => {
  const matrix = liveNumberCases.flatMap((c) =>
    FORMS.map(([form, encode]) => [c.name, form, encode, c] as const),
  );

  it.each(matrix)('%s as %s', (name, _form, encode, c) => {
    expect(normalizeBrokerEvent(name, [encode(c.wire)])).toEqual({
      ok: true,
      event: c.event,
      extraArgs: 0,
    });
  });
});

describe('normalizeBrokerEvent: payload events × payload forms', () => {
  const matrix = payloadCases.flatMap((c) =>
    FORMS.map(([form, encode]) => [c.name, form, encode, c] as const),
  );

  it.each(matrix)('%s as %s', (name, _form, encode, c) => {
    expect(normalizeBrokerEvent(name, [encode(c.wire)])).toEqual({
      ok: true,
      event: c.event,
      extraArgs: 0,
    });
  });

  it('covers every payload event of the shared map', () => {
    const covered = new Set(payloadCases.map((c) => c.name));
    expect(covered.size).toBe(payloadCases.length);
    expect(covered.size + PAYLOADLESS.length).toBe(15);
  });

  it('decodes a typed-array view over its own byte range only', () => {
    const bytes = bytesOf(balanceWire);
    const padded = new Uint8Array(bytes.length + 4).fill(0x7b);
    padded.set(bytes, 2);
    const view = new Uint8Array(padded.buffer, 2, bytes.length);
    const result = normalizeBrokerEvent('user.real.update_balance', [view]);
    expect(result).toEqual({
      ok: true,
      event: { type: BrokerEventType.BalanceUpdate, mode: TradeMode.Real, balance: balanceWire },
      extraArgs: 0,
    });
  });

  it('keeps only message from a loose user.auth.error', () => {
    const result = normalizeBrokerEvent('user.auth.error', [
      { message: 'bad token', token: 'SECRET-T', nested: { a: 1 } },
    ]);
    expect(result.ok && result.event).toStrictEqual({
      type: BrokerEventType.AuthError,
      message: 'bad token',
    });
  });

  it('passes the price.update timestamp through as received and tolerates extra elements', () => {
    const result = normalizeBrokerEvent('price.update', [[91, 1.1, 1790028496624, 'x']]);
    expect(result).toEqual({
      ok: true,
      event: {
        type: BrokerEventType.PriceUpdate,
        update: { assetId: 91, price: 1.1, timestamp: 1790028496624 },
      },
      extraArgs: 0,
    });
  });

  it.each([
    [
      { id: 91, scheduled_until: 0 },
      { assetId: 91, scheduledUntil: 0 },
    ],
    [{ asset_id: 91, id: 91 }, { assetId: 91 }],
  ])('accepts assets_update %j', (wire, update) => {
    expect(normalizeBrokerEvent('common.assets_update', [wire])).toEqual({
      ok: true,
      event: { type: BrokerEventType.AssetsUpdate, update },
      extraArgs: 0,
    });
  });

  it('accepts an empty open_trade.fail and an empty close_trade.success', () => {
    expect(normalizeBrokerEvent('user.demo.open_trade.fail', [[]])).toEqual({
      ok: true,
      event: { type: BrokerEventType.OpenTradeFail, mode: TradeMode.Demo, failures: [] },
      extraArgs: 0,
    });
    expect(normalizeBrokerEvent('user.real.close_trade.success', [{ trades: [] }])).toEqual({
      ok: true,
      event: { type: BrokerEventType.CloseTradeSuccess, mode: TradeMode.Real, trades: [] },
      extraArgs: 0,
    });
  });
});

describe('normalizeBrokerEvent: event names', () => {
  const scoped = [
    'open_trade.success',
    'open_trade.fail',
    'close_trade.success',
    'update_balance',
  ] as const satisfies readonly ModeScopedEvent[];

  it('takes the mode from the event name for every mode-scoped event', () => {
    for (const mode of Object.values(TradeMode)) {
      for (const name of scoped) {
        const c = payloadCases.find((p) => p.name === modeEvent(mode, name));
        if (c === undefined) throw new Error(`no fixture for ${modeEvent(mode, name)}`);
        const result = normalizeBrokerEvent(c.name, [c.wire]);
        expect(result.ok && result.event).toMatchObject({ mode });
      }
    }
  });

  it('knows exactly the shared server→client names', () => {
    const fixed: ServerEvent[] = [
      BrokerSocketEvent.UserAuthSuccess,
      BrokerSocketEvent.UserAuthError,
      BrokerSocketEvent.UserDisconnectTokenExpired,
      BrokerSocketEvent.PriceUpdate,
      BrokerSocketEvent.CommonAssetsList,
      BrokerSocketEvent.CommonAssetsUpdate,
      BrokerSocketEvent.UserData,
    ];
    const modeScoped: ServerEvent[] = Object.values(TradeMode).flatMap((mode) =>
      scoped.map((e) => modeEvent(mode, e)),
    );
    const all = [...fixed, ...modeScoped];
    expect(new Set(all).size).toBe(15);
    expect(new Set([...payloadCases.map((c) => c.name), ...PAYLOADLESS])).toEqual(new Set(all));
    for (const name of all) {
      const result = normalizeBrokerEvent(name, []);
      if (!result.ok) expect(result.problem.kind).not.toBe(BrokerEventProblemKind.UnknownEvent);
    }
  });

  it.each([
    BrokerSocketEvent.UserAuth,
    BrokerSocketEvent.PriceSubscribe,
    modeEvent(TradeMode.Demo, 'open_trade'),
    modeEvent(TradeMode.Real, 'open_trade'),
  ])('treats the client→server name %s as unknown', (name) => {
    expect(normalizeBrokerEvent(name, [{}])).toEqual({
      ok: false,
      problem: { kind: BrokerEventProblemKind.UnknownEvent, event: name },
      extraArgs: 1,
    });
  });

  // seen live on broker-ws.binodex.app 2026-10-02, absent from shared's map by decision
  it.each([
    'price.subscribed',
    'user.real.close_trade.recent',
    'user.demo.close_trade.recent',
    'user.real.futures.positions',
    'user.demo.futures.positions',
    'user.real.futures.closed.recent',
    'user.demo.futures.closed.recent',
  ])('treats the observed unsolicited %s as unknown', (name) => {
    expect(normalizeBrokerEvent(name, [Buffer.from('[]')])).toEqual({
      ok: false,
      problem: { kind: BrokerEventProblemKind.UnknownEvent, event: name },
      extraArgs: 1,
    });
  });

  it.each(['', 'constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'treats %j as unknown, not as a prototype hit',
    (name) => {
      expect(normalizeBrokerEvent(name, [])).toEqual({
        ok: false,
        problem: { kind: BrokerEventProblemKind.UnknownEvent, event: name },
        extraArgs: 0,
      });
    },
  );

  it('cuts a long event name', () => {
    const problem = expectProblem(normalizeBrokerEvent('x'.repeat(300), []));
    expect(problem.event).toBe('x'.repeat(MAX_EVENT_NAME_LENGTH));
    expect(MAX_EVENT_NAME_LENGTH).toBe(100);
  });
});

describe('normalizeBrokerEvent: payload-less events', () => {
  it.each(
    PAYLOADLESS.flatMap((name) =>
      (
        [
          ['[]', [], 0],
          ['[null]', [null], 0],
          ['[undefined]', [undefined], 0],
          ["[null, 'x']", [null, 'x'], 1],
          ['[{}]', [{}], 1],
          ["['x', 1]", ['x', 1], 2],
        ] as const
      ).map(([label, args, extraArgs]) => [name, label, extraArgs, args] as const),
    ),
  )('%s with %s → extraArgs %i', (name, _label, extraArgs, args) => {
    expect(normalizeBrokerEvent(name, args)).toEqual({
      ok: true,
      event: { type: payloadlessType[name] },
      extraArgs,
    });
  });
});

describe('normalizeBrokerEvent: problems', () => {
  it.each([
    ['no arguments', []],
    ['an undefined first argument', [undefined]],
  ])('reports missing_payload for %s', (_label, args) => {
    expect(normalizeBrokerEvent('user.data', args)).toEqual({
      ok: false,
      problem: { kind: BrokerEventProblemKind.MissingPayload, event: 'user.data' },
      extraArgs: 0,
    });
  });

  it('counts arguments after a missing payload', () => {
    expect(normalizeBrokerEvent('user.data', [undefined, 'x'])).toMatchObject({
      ok: false,
      problem: { kind: BrokerEventProblemKind.MissingPayload },
      extraArgs: 1,
    });
  });

  it('ignores extra arguments and never calls a trailing ack', () => {
    const ack = vi.fn();
    const result = normalizeBrokerEvent('user.demo.update_balance', [balanceWire, 'second', ack]);
    expect(result).toEqual({
      ok: true,
      event: { type: BrokerEventType.BalanceUpdate, mode: TradeMode.Demo, balance: balanceWire },
      extraArgs: 2,
    });
    expect(ack).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', 'SECRET-TOKEN-abc'],
    ['malformed JSON object', '{"token":"SECRET-TOKEN-abc"'],
    ['invalid UTF-8 bytes', new Uint8Array([...new TextEncoder().encode('"SECRET-'), 0xff])],
    ['an invalid UTF-8 envelope', { data: [...new TextEncoder().encode('"SECRET-'), 0xff] }],
  ])('reports decode for %s without any text', (_label, raw) => {
    const result = normalizeBrokerEvent('user.data', [raw]);
    expect(result).toEqual({
      ok: false,
      problem: { kind: BrokerEventProblemKind.Decode, event: 'user.data' },
      extraArgs: 0,
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('message');
    expect(json).not.toContain('stack');
  });

  const schemaCases: [ServerEvent, unknown, { code: string; path: string }][] = [
    ['user.auth.error', { text: 'x' }, { code: 'invalid_type', path: 'message' }],
    ['price.update', [91, 1.1], { code: 'invalid_type', path: '2' }],
    [
      'common.assets_list',
      [pairWire, { ...pairWire, payout: 'x' }],
      { code: 'invalid_type', path: '1.payout' },
    ],
    ['common.assets_update', { payout: 80 }, { code: 'custom', path: '' }],
    ['common.assets_update', { asset_id: 91, id: 92 }, { code: 'custom', path: '' }],
    ['user.data', { ...userWire, id: undefined }, { code: 'invalid_union', path: 'id' }],
    ['user.data', { ...userWire, id: {} }, { code: 'invalid_union', path: 'id' }],
    [
      'user.demo.open_trade.success',
      { ...openTradeWire, action: 'sideways' },
      { code: 'invalid_value', path: 'action' },
    ],
    ['user.real.open_trade.fail', { message: 'x' }, { code: 'invalid_type', path: '' }],
    ['user.demo.close_trade.success', { trades: 'no' }, { code: 'invalid_type', path: 'trades' }],
    [
      'user.real.update_balance',
      { available: '1', total: '1' },
      { code: 'invalid_union', path: 'held' },
    ],
    [
      'user.demo.update_balance',
      { ...liveBalanceWire, available: 0.30000000000000004 },
      { code: 'invalid_union', path: 'available' },
    ],
    ['user.data', null, { code: 'invalid_type', path: '' }],
    ['user.data', () => 1, { code: 'invalid_type', path: '' }],
    ['user.data', [userWire], { code: 'invalid_type', path: '' }],
    ['user.data', { data: [] }, { code: 'invalid_union', path: 'id' }],
    ['user.data', { data: 'x' }, { code: 'invalid_union', path: 'id' }],
    ['user.data', { data: [300, -1] }, { code: 'invalid_union', path: 'id' }],
    ['user.data', { id: 1, real: Buffer.from('{}') }, { code: 'invalid_type', path: 'level' }],
  ];

  it.each(schemaCases)('reports schema for %s %j', (name, wire, issue) => {
    const problem = expectProblem(normalizeBrokerEvent(name, [wire]));
    expect(problem).toMatchObject({ kind: BrokerEventProblemKind.Schema, event: name });
    if (problem.kind !== BrokerEventProblemKind.Schema) throw new Error('not a schema problem');
    expect(problem.issues).toContainEqual(issue);
    expect(problem.issueCount).toBe(problem.issues.length);
  });

  // #354: the shape of a refused payload, keys and types only
  it('T6 describes the refused payload by its keys and types, never a value', () => {
    const problem = expectProblem(
      normalizeBrokerEvent('common.assets_update', [
        [{ token: 'SECRET-TOKEN-abc', id: 91, open: true, at: null, rows: [[1, 'x']] }],
      ]),
    );
    if (problem.kind !== BrokerEventProblemKind.Schema) throw new Error('not a schema problem');
    expect(problem.shape).toBe(
      '[1: {at: null, id: number, open: boolean, rows: [1: [2]], token: string}]',
    );
    expect(JSON.stringify(problem)).not.toContain('SECRET');
    expect(JSON.stringify(problem)).not.toContain('91');
  });

  it('T6 caps the shape: depth, keys an object, key length, total length', () => {
    expect(describeShape({ a: { b: { c: { d: 1 } } } })).toBe('{a: {b: {c: {…}}}}');
    const wide = Object.fromEntries(
      Array.from({ length: SHAPE_MAX_KEYS + 3 }, (_, i) => [`k${String(i).padStart(2, '0')}`, 1]),
    );
    expect(describeShape(wide)).toMatch(/, …\+3\}$/);
    expect(describeShape(wide).match(/: number/g)).toHaveLength(SHAPE_MAX_KEYS);
    const long = 'x'.repeat(SHAPE_MAX_KEY_LENGTH + 10);
    expect(describeShape({ [long]: 1 })).toBe(`{${'x'.repeat(SHAPE_MAX_KEY_LENGTH)}: number}`);
    const huge = Object.fromEntries(
      Array.from({ length: SHAPE_MAX_KEYS }, (_, i) => ['y'.repeat(30) + String(i), 'v']),
    );
    expect(describeShape(huge)).toHaveLength(SHAPE_MAX_LENGTH);
    expect(describeShape([])).toBe('[0]');
    expect(describeShape('SECRET')).toBe('string');
  });

  it('caps the reported issues and keeps the full count', () => {
    const broken = Array.from({ length: 15 }, (_, i) => ({ ...pairWire, id: i, payout: 'x' }));
    const problem = expectProblem(normalizeBrokerEvent('common.assets_list', [broken]));
    if (problem.kind !== BrokerEventProblemKind.Schema) throw new Error('not a schema problem');
    expect(problem.issues).toHaveLength(MAX_REPORTED_ISSUES);
    expect(problem.issueCount).toBe(15);
    expect(problem.issues[0]).toEqual({ code: 'invalid_type', path: '0.payout' });
    expect(MAX_REPORTED_ISSUES).toBe(10);
  });

  it('carries no Error instance and no payload value in any problem', () => {
    const problems = [
      normalizeBrokerEvent('some.unknown', [{ id: 'SECRET-0' }]),
      normalizeBrokerEvent('user.data', []),
      normalizeBrokerEvent('user.data', ['{"id":"SECRET-1"']),
      normalizeBrokerEvent('user.data', [{ id: 'SECRET-2', level: 'SECRET-3' }]),
    ].map(expectProblem);
    const walk = (value: unknown): void => {
      expect(value).not.toBeInstanceOf(Error);
      if (typeof value === 'string') expect(value).not.toMatch(/SECRET-\d/);
      if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
    };
    problems.forEach(walk);
  });
});

describe('a problem written to a pino log', () => {
  it('carries no payload value, no message and no stack', () => {
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
    const results = [
      normalizeBrokerEvent('user.demo.futures.positions', [Buffer.from('"SECRET-A"')]),
      normalizeBrokerEvent('user.data', [undefined, 'SECRET-B']),
      normalizeBrokerEvent('user.data', ['SECRET-C']),
      normalizeBrokerEvent('user.data', [{ id: 'SECRET-D', level: { code: 'SECRET-E' } }]),
    ];
    for (const result of results) {
      const problem = expectProblem(result);
      logger.warn({ problem, extraArgs: result.extraArgs }, 'broker event dropped');
    }
    expect(lines).toHaveLength(4);
    const kinds = lines.map((line) => {
      expect(line).not.toContain('SECRET');
      const logged = JSON.parse(line) as { problem: Record<string, unknown> };
      expect(logged.problem).not.toHaveProperty('message');
      expect(logged.problem).not.toHaveProperty('stack');
      return logged.problem.kind;
    });
    expect(kinds).toEqual(Object.values(BrokerEventProblemKind));
  });
});

describe('types', () => {
  it('ties the unions to their constants', () => {
    expectTypeOf<BrokerEvent['type']>().toEqualTypeOf<BrokerEventType>();
    expectTypeOf<BrokerEventProblem['kind']>().toEqualTypeOf<BrokerEventProblemKind>();
  });
});
