import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { BrokerRestError, type TradeListFilter } from '@binarius/broker-rest';
import {
  TradeIntentFailureReason,
  TradeIntentStatus,
  type BrokerTrade,
  type DecimalString,
  type OpenTrade,
  type UnixMs,
} from '@binarius/shared';
import { closedTradeFor, openTradeFor } from '@binarius/shared/testing';
import type { TradeIntentRow } from '@binarius/db';
import type { AccessTokenOutcome, AccessTokenOptions } from '../broker/access-token';
import { createRestReconciler, ReconcilerInputError, type RestReconcilerConfig } from './rest-reconciler';

const SUBMITTED = Date.UTC(2026, 9, 6, 12, 0, 0);
const BEFORE = 60_000;
const AFTER = 90_000;
const PAGE = 4;
const config: RestReconcilerConfig = {
  windowBeforeMs: BEFORE,
  windowAfterMs: AFTER,
  pageSize: PAGE,
  maxPages: 2,
};

const intent = (patch: Partial<TradeIntentRow> = {}): TradeIntentRow => ({
  id: 'intent-1',
  brokerAccountId: 'account-1',
  userId: 'user-1',
  tradingSessionId: null,
  mode: 'demo',
  assetId: 101,
  amount: '10.00000000' as DecimalString,
  action: 'up',
  durationSec: 60,
  clientRequestId: 'req-1',
  status: TradeIntentStatus.Reconciling,
  version: 3,
  tokensReserved: 1n,
  transport: null,
  submittedAt: new Date(SUBMITTED),
  lastError: 'executor_timeout',
  // the window closed by the database clock unless a case says otherwise
  reconcileClaimedAt: new Date(SUBMITTED + AFTER + 1_000),
  createdAt: new Date(SUBMITTED - 1_000),
  updatedAt: new Date(SUBMITTED),
  ...patch,
});

const at = (offsetMs: number, patch: Partial<OpenTrade> = {}): OpenTrade =>
  openTradeFor(
    { mode: 'demo', assetId: 101, action: 'up', amount: '10' as DecimalString },
    { openTimestamp: (SUBMITTED + offsetMs) as UnixMs, ...patch },
  );

// far older than the window: what a full first page of history ends with
const old = (index = 0) => at(-10 * 60_000 - index * 1_000);

interface Lists {
  open?: BrokerTrade[];
  closed?: BrokerTrade[];
}

// pages are cut from the lists by (status, offset, limit), as the broker would
function harness(
  lists: Lists,
  {
    token = { ok: true, accessToken: 'tok' },
    linked = new Set<string>(),
    failOn,
    cap,
    maxPages = config.maxPages,
    ignoreOffset = false,
    offsetSkew = 0,
    shrinkAfterFirstPage = 0,
  }: {
    token?: AccessTokenOutcome;
    linked?: Set<string>;
    failOn?: { status: 'open' | 'closed'; error: unknown };
    // the broker answers at most this many rows whatever the limit
    cap?: number;
    maxPages?: number;
    ignoreOffset?: boolean;
    // a page at offset > 0 starts this much further
    offsetSkew?: number;
    // this many trades leave the list after its first page is served (open trades closing)
    shrinkAfterFirstPage?: number;
  } = {},
) {
  const requests: { filter: TradeListFilter; signal: AbortSignal | undefined }[] = [];
  const current = { open: lists.open ?? [], closed: lists.closed ?? [] };
  const served = { open: 0, closed: 0 };
  const tokenCalls: { accountId: string; options: AccessTokenOptions | undefined }[] = [];
  const linkedCalls: string[][] = [];
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'trace' },
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const reconciler = createRestReconciler({
    rest: {
      listTrades: (_auth, filter = {}, options) => {
        requests.push({ filter, signal: options?.signal });
        if (failOn !== undefined && failOn.status === filter.status) {
          return Promise.reject(failOn.error);
        }
        const key = filter.status === 'open' ? 'open' : 'closed';
        const all = current[key];
        const offset = filter.offset ?? 0;
        const start = ignoreOffset ? 0 : offset + (offset > 0 ? offsetSkew : 0);
        const limit = filter.limit ?? 20;
        const page = all.slice(start, start + Math.min(limit, cap ?? limit));
        served[key] += 1;
        if (served[key] === 1 && shrinkAfterFirstPage > 0) {
          current[key] = all.slice(shrinkAfterFirstPage);
        }
        return Promise.resolve(page);
      },
    },
    tokens: {
      accessToken: (accountId, options) => {
        tokenCalls.push({ accountId, options });
        return Promise.resolve(token);
      },
    },
    linkedTradeIds: (_accountId, ids) => {
      linkedCalls.push([...ids]);
      return Promise.resolve(linked);
    },
    logger,
    config: { ...config, maxPages },
  });
  const signal = new AbortController().signal;
  return {
    run: (row: TradeIntentRow = intent()) => reconciler.reconcile(row, signal),
    requests,
    tokenCalls,
    linkedCalls,
    lines,
    signal,
    line: (msg: string) => lines.find((entry) => entry.msg === msg),
  };
}

describe('createRestReconciler: matching (#90)', () => {
  it('finds the one open trade in the window', async () => {
    const trade = at(2_000);
    expect(await harness({ open: [trade] }).run()).toEqual({ outcome: 'found', trade });
  });

  it('finds the one closed trade in the window', async () => {
    const trade = closedTradeFor(at(2_000));
    expect(await harness({ closed: [trade] }).run()).toEqual({ outcome: 'found', trade });
  });

  it('takes the closed form of a trade that is in both lists', async () => {
    const open = at(2_000);
    const closed = closedTradeFor(open);
    expect(await harness({ open: [open], closed: [closed] }).run()).toEqual({
      outcome: 'found',
      trade: closed,
    });
  });

  it('answers ambiguous for two candidates', async () => {
    const h = harness({ open: [at(3_000)], closed: [closedTradeFor(at(1_000))] });
    expect(await h.run()).toEqual({ outcome: 'ambiguous' });
    expect(h.line('reconciliation is ambiguous')).toMatchObject({
      intentId: 'intent-1',
      brokerAccountId: 'account-1',
      candidates: 2,
    });
  });

  it('drops a candidate already linked to an intent of the account before counting', async () => {
    const earlier = closedTradeFor(at(-30_000));
    const ours = at(2_000);
    const h = harness({ open: [ours], closed: [earlier] }, { linked: new Set([earlier.id]) });
    expect(await h.run()).toEqual({ outcome: 'found', trade: ours });
    expect(h.linkedCalls).toEqual([[ours.id, earlier.id]]);
  });

  it.each([
    ['asset', { assetId: 102 }],
    ['action', { action: 'down' as const }],
    ['mode', { isDemo: false }],
  ])('does not count a trade of another %s', async (_name, patch) => {
    expect(await harness({ open: [at(2_000, patch)] }).run()).toEqual({ outcome: 'unresolved' });
  });

  // review m1: the amount is the one key the broker may round
  it('answers ambiguous, not unresolved, for a trade that differs only in amount', async () => {
    const h = harness({ closed: [closedTradeFor(at(2_000, { amount: '10.5' as DecimalString }))] });
    expect(await h.run()).toEqual({ outcome: 'ambiguous' });
    expect(h.line('reconciliation is ambiguous')).toMatchObject({
      candidates: 0,
      nearMatches: 1,
      ackMismatch: false,
    });
  });

  it('prefers the exact trade over a near match', async () => {
    const ours = at(3_000);
    const near = closedTradeFor(at(2_000, { amount: '10.5' as DecimalString }));
    expect(await harness({ open: [ours], closed: [near] }).run()).toEqual({
      outcome: 'found',
      trade: ours,
    });
  });

  it('waits for the window to close before a near match decides', async () => {
    const near = at(2_000, { amount: '10.5' as DecimalString });
    expect(
      await harness({ open: [near] }).run(
        intent({ reconcileClaimedAt: new Date(SUBMITTED + AFTER - 1) }),
      ),
    ).toEqual({ outcome: 'unavailable', reason: 'window_open' });
  });

  it('drops a near match already linked to an intent of the account', async () => {
    const near = closedTradeFor(at(-20_000, { amount: '5' as DecimalString }));
    const h = harness({ closed: [near] }, { linked: new Set([near.id]) });
    expect(await h.run()).toEqual({ outcome: 'unresolved' });
    expect(h.linkedCalls).toEqual([[near.id]]);
  });

  it('answers ambiguous, not unresolved, for an intent the executor saw mismatch', async () => {
    const h = harness({ open: [], closed: [] });
    expect(await h.run(intent({ lastError: TradeIntentFailureReason.TradeMismatch }))).toEqual({
      outcome: 'ambiguous',
    });
    expect(h.line('reconciliation is ambiguous')).toMatchObject({
      candidates: 0,
      nearMatches: 0,
      ackMismatch: true,
    });
  });

  it('compares the amount as a decimal, not as a spelling', async () => {
    const trade = at(2_000, { amount: '10' as DecimalString });
    expect(await harness({ open: [trade] }).run(intent({ amount: '10.00000000' as DecimalString })))
      .toEqual({ outcome: 'found', trade });
  });

  it.each([
    ['the window start', -BEFORE, true],
    ['the window end', AFTER, true],
    ['1 ms before the start', -BEFORE - 1, false],
    ['1 ms after the end', AFTER + 1, false],
  ])('treats a trade opened at %s as a candidate: %s', async (_name, offset, inside) => {
    const trade = at(offset);
    const result = await harness({ open: [trade] }).run(
      intent({ reconcileClaimedAt: new Date(SUBMITTED + AFTER + 2) }),
    );
    expect(result).toEqual(inside ? { outcome: 'found', trade } : { outcome: 'unresolved' });
  });
});

describe('createRestReconciler: when absence is certain (#90)', () => {
  it('answers unresolved once both lists are read and the window has closed', async () => {
    const h = harness({ open: [], closed: [old()] });
    expect(await h.run()).toEqual({ outcome: 'unresolved' });
    expect(h.line('reconciliation unresolved; parked for manual review')).toMatchObject({
      intentId: 'intent-1',
      brokerAccountId: 'account-1',
      covered: true,
      openPages: 1,
      closedPages: 1,
    });
  });

  it('answers window_open while the claim is before the window end', async () => {
    const h = harness({ open: [], closed: [] });
    expect(await h.run(intent({ reconcileClaimedAt: new Date(SUBMITTED + AFTER - 1) }))).toEqual({
      outcome: 'unavailable',
      reason: 'window_open',
    });
  });

  it('concludes unresolved at a claim exactly at the window end', async () => {
    const h = harness({ open: [], closed: [] });
    expect(await h.run(intent({ reconcileClaimedAt: new Date(SUBMITTED + AFTER) }))).toEqual({
      outcome: 'unresolved',
    });
  });

  it('finds a trade while the window is still open', async () => {
    const trade = at(2_000);
    expect(
      await harness({ open: [trade] }).run(intent({ reconcileClaimedAt: new Date(SUBMITTED) })),
    ).toEqual({ outcome: 'found', trade });
  });

  it('reads a second page when the first is full and still inside the window', async () => {
    const closed = [at(4_000), at(3_000), at(2_000, { assetId: 102 }), at(1_000, { assetId: 103 }), old()];
    const h = harness({ open: [], closed });
    expect(await h.run()).toEqual({ outcome: 'ambiguous' });
    expect(h.requests.map((r) => r.filter)).toEqual([
      { status: 'open', isDemo: true, limit: PAGE, offset: 0 },
      { status: 'closed', isDemo: true, limit: PAGE, offset: 0 },
      { status: 'closed', isDemo: true, limit: PAGE, offset: PAGE - 1 },
    ]);
  });

  it('reads past the window start before answering unresolved', async () => {
    const closed = [at(4_000, { assetId: 102 }), at(3_000, { assetId: 102 }), at(2_000, { assetId: 102 }), at(-BEFORE, { assetId: 102 }), old()];
    const h = harness({ open: [], closed });
    expect(await h.run()).toEqual({ outcome: 'unresolved' });
    expect(h.requests.filter((r) => r.filter.status === 'closed').map((r) => r.filter.offset)).toEqual([0, 3]);
  });

  // review M1: a broker that caps the page below the limit must not make a short page the end
  it('finds the trade behind pages the broker cut short', async () => {
    const ours = at(3_000);
    const closed = [at(5_000, { assetId: 102 }), at(4_000, { assetId: 102 }), ours, at(2_000, { assetId: 102 }), old()];
    expect(await harness({ open: [], closed }, { cap: 2, maxPages: 4 }).run()).toEqual({
      outcome: 'found',
      trade: ours,
    });
    // the same pages, too few of them: retried while the window is open, parked once it closed
    expect(
      await harness({ open: [], closed }, { cap: 2, maxPages: 2 }).run(
        intent({ reconcileClaimedAt: new Date(SUBMITTED) }),
      ),
    ).toEqual({ outcome: 'unavailable', reason: 'window_not_covered' });
    expect(await harness({ open: [], closed }, { cap: 2, maxPages: 2 }).run()).toEqual({
      outcome: 'ambiguous',
    });
  });

  it('finds the trade behind a page answered one short of the limit', async () => {
    const ours = at(1_000);
    const closed = [at(4_000, { assetId: 102 }), at(3_000, { assetId: 102 }), at(2_000, { assetId: 102 }), ours, old()];
    const h = harness({ open: [], closed }, { cap: PAGE - 1 });
    expect(await h.run()).toEqual({ outcome: 'found', trade: ours });
    expect(h.requests.filter((r) => r.filter.status === 'closed')).toHaveLength(2);
  });

  it('confirms a one-trade open list with an empty page', async () => {
    const ours = at(2_000);
    const h = harness({ open: [ours], closed: [] });
    expect(await h.run()).toEqual({ outcome: 'found', trade: ours });
    expect(h.requests.map((r) => `${r.filter.status}@${r.filter.offset}`)).toEqual([
      'open@0',
      'open@1',
      'closed@0',
    ]);
  });

  it('stops after one full page whose oldest trade is older than the window', async () => {
    const closed = [at(2_000, { assetId: 102 }), old(0), old(1), old(2), old(3), old(4)];
    const h = harness({ open: [], closed });
    expect(await h.run()).toEqual({ outcome: 'unresolved' });
    expect(h.requests.filter((r) => r.filter.status === 'closed')).toHaveLength(1);
  });

  it('answers window_not_covered while the window is open and the page cap runs out', async () => {
    const closed = Array.from({ length: 2 * PAGE + 1 }, (_, i) => at(80_000 - i * 1_000, { assetId: 102 }));
    const h = harness({ open: [], closed });
    expect(await h.run(intent({ reconcileClaimedAt: new Date(SUBMITTED) }))).toEqual({
      outcome: 'unavailable',
      reason: 'window_not_covered',
    });
    expect(h.requests.filter((r) => r.filter.status === 'closed')).toHaveLength(2);
    // once the window has closed the same uncovered pages park the intent
    expect(await harness({ open: [], closed }).run()).toEqual({ outcome: 'unresolved' });
  });

  it('does not answer found for one candidate in a window the pages did not cover', async () => {
    const closed = [at(80_000), ...Array.from({ length: 2 * PAGE }, (_, i) => at(70_000 - i * 1_000, { assetId: 102 }))];
    expect(
      await harness({ open: [], closed }).run(intent({ reconcileClaimedAt: new Date(SUBMITTED) })),
    ).toEqual({ outcome: 'unavailable', reason: 'window_not_covered' });
    const h = harness({ open: [], closed });
    expect(await h.run()).toEqual({ outcome: 'ambiguous' });
    expect(h.line('reconciliation is ambiguous')).toMatchObject({ candidates: 1, covered: false });
  });

  // The invariant of #90: whatever the broker's pages look like, absence is never concluded here,
  // so no answer releases the reserve (#274 proves absence after the live probe).
  it.each([
    ['honest pages', {}],
    ['a capped limit', { cap: 2 }],
    ['a limit answered one short', { cap: PAGE - 1 }],
    ['an ignored offset', { ignoreOffset: true }],
    ['a skewed offset', { offsetSkew: 1 }],
    ['an open list that shrinks between pages', { shrinkAfterFirstPage: 2 }],
  ] as const)('never answers not_found: %s, no trade of ours, window closed', async (_name, broker) => {
    const others = Array.from({ length: 2 * PAGE + 1 }, (_, i) => at(80_000 - i * 1_000, { assetId: 102 }));
    for (const lists of [{}, { open: others }, { closed: [...others, old()] }, { open: others, closed: [old()] }]) {
      const result = await harness(lists, broker).run();
      expect(result.outcome).not.toBe('not_found');
      expect(['unresolved', 'ambiguous', 'unavailable']).toContain(result.outcome);
    }
  });

  // every violation kind is trade-pages.test.ts's; here the one mapping
  it('answers broker_contract when the pages are inconsistent', async () => {
    const h = harness({ open: [], closed: [old(), at(2_000, { assetId: 102 })] });
    expect(await h.run()).toEqual({ outcome: 'unavailable', reason: 'broker_contract' });
    expect(h.line('broker trade pages are inconsistent; nothing concluded')).toMatchObject({
      intentId: 'intent-1',
      brokerAccountId: 'account-1',
      violation: 'order',
    });
  });

  it('asks in the intent mode', async () => {
    const h = harness({ open: [], closed: [] });
    await h.run(intent({ mode: 'real' }));
    expect(h.requests.map((r) => r.filter.isDemo)).toEqual([false, false]);
  });
});

describe('createRestReconciler: failures (#90)', () => {
  it.each([
    ['rate_limited', 'rate_limited'],
    ['unauthorized', 'token_unavailable'],
    ['rejected', 'broker_contract'],
    ['contract_violation', 'broker_contract'],
    ['unavailable', 'broker_unavailable'],
    ['aborted', 'timeout'],
  ] as const)('maps a %s list error to %s', async (code, reason) => {
    const error = new BrokerRestError(code, { status: 429, retryAfterSec: 7, detail: 'slow down' });
    const h = harness({}, { failOn: { status: 'closed', error } });
    expect(await h.run()).toEqual({ outcome: 'unavailable', reason });
    expect(h.line('reconciliation trade list failed')).toMatchObject({
      intentId: 'intent-1',
      brokerAccountId: 'account-1',
      err: { name: 'BrokerRestError' },
      status: 429,
      retryAfterSec: 7,
      detail: 'slow down',
    });
  });

  it('lets any other error through', async () => {
    const boom = new Error('boom');
    await expect(harness({}, { failOn: { status: 'open', error: boom } }).run()).rejects.toBe(boom);
  });

  it.each(['user_blocked', 'refresh_needed', 'account_revoked'] as const)(
    'answers token_unavailable when the backend refuses with %s',
    async (refusal) => {
      const h = harness({}, { token: { ok: false, reason: refusal } });
      expect(await h.run()).toEqual({ outcome: 'unavailable', reason: 'token_unavailable' });
      expect(h.line('reconciliation token refused')).toMatchObject({
        intentId: 'intent-1',
        brokerAccountId: 'account-1',
        refusal,
      });
      expect(h.requests).toEqual([]);
    },
  );

  it.each([
    [{ ok: false, reason: 'backend_unreachable' }],
    [{ ok: false, reason: 'backend_status', status: 503 }],
    [{ ok: false, reason: 'contract_violation', status: 200 }],
  ] as const)('answers backend_unavailable when the token route fails: %j', async (token) => {
    const h = harness({}, { token });
    expect(await h.run()).toEqual({ outcome: 'unavailable', reason: 'backend_unavailable' });
    expect(h.line('reconciliation token unavailable')).toMatchObject({
      failure: token.reason,
      ...('status' in token ? { status: token.status } : {}),
    });
  });

  it('asks for the token with mayRefresh and hands the signal to every call', async () => {
    const h = harness({ open: [], closed: [] });
    await h.run();
    expect(h.tokenCalls).toEqual([
      { accountId: 'account-1', options: { mayRefresh: true, signal: h.signal } },
    ]);
    expect(h.requests.every((r) => r.signal === h.signal)).toBe(true);
  });

  it('keeps the token out of the log', async () => {
    const h = harness({}, { failOn: { status: 'open', error: new BrokerRestError('unavailable') } });
    await h.run();
    expect(JSON.stringify(h.lines)).not.toContain('tok"');
  });

  it.each([
    ['submittedAt', { submittedAt: null }],
    ['reconcileClaimedAt', { reconcileClaimedAt: null }],
  ] as const)('throws ReconcilerInputError without %s', async (field, patch) => {
    const error = await harness({}).run(intent(patch)).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ReconcilerInputError);
    expect((error as ReconcilerInputError).field).toBe(field);
  });
});
