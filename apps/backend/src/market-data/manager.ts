import type { FastifyBaseLogger } from 'fastify';
import {
  AccessTokenRefusal,
  SIGNAL_SCAN_INTERVALS,
  assertExhausted,
  errorLogFields,
  type ScanInterval,
} from '@binarius/shared';
import { hashToken } from '@binarius/db';
import type { PairsCatalog } from '@binarius/broker-rest';
import {
  BrokerEventType,
  BrokerSocketState,
  type BrokerEvent,
  type BrokerSocketClient,
  type BrokerSocketStateChange,
} from '@binarius/broker-socket';
import { assertDigits } from '@binarius/signal';
import type { AccessTokenOptions, AccessTokenResult } from '../auth/token-service';
import type { BackfillCounters, CandleBackfill } from './backfill';
import type { CandleRing } from './ring';
import type { SecondSeries, SecondSeriesCounters } from './seconds';
import type { TickStore } from './ticks';
import type { PendingRequests } from './source';

type BackfillTotal = Exclude<keyof BackfillCounters, 'queued'>;

// The data socket of the backend (#404, docs/market-data.md → The state machine). At most two
// broker socket clients, both on service accounts (#391): the active one, subscribed to every pair
// of the fresh catalog, whose ticks build the ring, and a warm reserve, authenticated and
// subscribed to nothing. No trade command is ever sent on these sockets. Every handler changes
// only its own slot and ends in reconcile(), which applies, in order:
// R1 a slot whose account left the list is vacated, without a hold-back;
// R2 a reserve not ready for reserveReadyMs gives way, held back, when another account can take it;
// R3 a ready reserve becomes the active when the active is empty, or not ready past the grace;
// R4 an empty active starts on the first candidate; R5 an empty reserve likewise;
// R6 the active subscribes the fresh catalog's new ids;
// R7 one timer, at the nearest deadline of R2 or R3.
// The REST backfill (#590, backfill.ts) reads streaming(), and the `market data` line carries its
// counters.

export interface MarketDataConfig {
  tickMs: number;
  logMs: number;
  failoverGraceMs: number;
  reserveReadyMs: number;
  accountRetryMs: number;
}

export interface MarketDataAccount {
  id: string;
  brokerUserId: string;
}

export interface MarketDataManagerDeps {
  // the in-service service accounts, in the order they are tried
  listAccounts: () => Promise<readonly MarketDataAccount[]>;
  accessToken: (accountId: string, options: AccessTokenOptions) => Promise<AccessTokenResult>;
  catalog: Pick<PairsCatalog, 'read'>;
  // a new, idle client; label: the account it is opened for
  openClient: (label: string) => BrokerSocketClient;
  ring: CandleRing;
  // the newest tick per pair (#666): the active client's ticks, next to the ring
  ticks: Pick<TickStore, 'push'>;
  // the 1s closes of the H1 shadow (#669): the active client's ticks too, with the ring's holes
  seconds: Pick<SecondSeries, 'push' | 'onDrop' | 'counters'>;
  requests: Pick<PendingRequests, 'size'>;
  backfill: Pick<CandleBackfill, 'counters'>;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  now?: () => number;
  config: MarketDataConfig;
}

export interface MarketDataManager {
  // a first tick now, then one every tickMs, and the log line every logMs
  start(): void;
  tick(): Promise<void>;
  // the `market data` line, for the period since the last one
  report(): void;
  stop(): Promise<void>;
  // the active socket is ready: its ticks build the ring
  streaming(): boolean;
}

type Role = 'active' | 'reserve';
const ROLES: readonly Role[] = ['active', 'reserve'];

interface Live {
  account: MarketDataAccount;
  client: BrokerSocketClient;
  token: string;
  // the start of the current period out of ready; undefined while the client is ready
  since: number | undefined;
  detach: () => void;
}

// waits on accessToken; only the slot that still holds this object takes its answer
interface Job {
  kind: 'starting';
  account: MarketDataAccount;
  since: number;
}

type Slot = { kind: 'empty' } | Job | { kind: 'running'; live: Live };

const EMPTY: Slot = { kind: 'empty' };

const accountOf = (slot: Slot): MarketDataAccount | undefined =>
  slot.kind === 'starting' ? slot.account : slot.kind === 'running' ? slot.live.account : undefined;

const isReady = (slot: Slot): boolean =>
  slot.kind === 'running' && slot.live.client.state === BrokerSocketState.Ready;

const sinceOf = (slot: Slot): number | undefined =>
  slot.kind === 'starting' ? slot.since : slot.kind === 'running' ? slot.live.since : undefined;

export function createMarketDataManager(deps: MarketDataManagerDeps): MarketDataManager {
  const {
    listAccounts,
    accessToken,
    catalog,
    openClient,
    ring,
    ticks: tickStore,
    seconds,
    requests,
    backfill,
    logger,
    config,
  } = deps;
  const now = deps.now ?? Date.now;
  const slots: Record<Role, Slot> = { active: EMPTY, reserve: EMPTY };
  // account id → when it may be tried again
  const held = new Map<string, number>();
  // account id → hashToken of the token the broker refused, until a start reports it
  const refused = new Map<string, string>();
  // account id → its last token refusal by the broker
  const lastRefusal = new Map<string, number>();
  const inflight = new Set<Promise<void>>();
  let order: readonly MarketDataAccount[] = [];
  let digitsById = new Map<number, number>();
  let catalogFresh = false;
  let skippedDigits = 0;
  let staleWarned = false;
  let noAccountWarned = false;
  let stopped = false;
  let running: Promise<void> | undefined;
  let tickTimer: NodeJS.Timeout | undefined;
  let logTimer: NodeJS.Timeout | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;

  // the period's counters, reset by report()
  let ticks = 0;
  let unknownAsset = 0;
  let failovers = 0;
  let reportedAt = now();
  let reportedCounters = ring.counters();
  let reportedBackfill = backfill.counters();
  let reportedSeconds = seconds.counters();
  const reportedClosedUntil = new Map<ScanInterval, number>();

  const isHeld = (accountId: string) => (held.get(accountId) ?? 0) > now();
  const holdBack = (accountId: string) => held.set(accountId, now() + config.accountRetryMs);
  const other = (role: Role): Role => (role === 'active' ? 'reserve' : 'active');

  function roleOf(live: Live): Role | undefined {
    return ROLES.find((role) => {
      const slot = slots[role];
      return slot.kind === 'running' && slot.live === live;
    });
  }

  // every work below catches its own throws; the catch is a backstop against an unhandled rejection
  function track(work: Promise<void>): void {
    const tracked: Promise<void> = work
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'market data work failed');
      })
      .finally(() => inflight.delete(tracked));
    inflight.add(tracked);
  }

  // the accounts a role may start on: listed, not held back, not in the other slot
  function candidates(role: Role): MarketDataAccount[] {
    const taken = accountOf(slots[other(role)])?.id;
    return order.filter((account) => account.id !== taken && !isHeld(account.id));
  }

  function readCatalog(): boolean {
    const view = catalog.read();
    if (view?.fresh !== true) {
      if (!staleWarned) {
        logger.warn({ ageMs: view?.ageMs ?? null }, 'market data catalog not fresh');
        staleWarned = true;
      }
      catalogFresh = false;
      return false;
    }
    staleWarned = false;
    const next = new Map<number, number>();
    let skipped = 0;
    for (const pair of view.pairs) {
      // a pair a builder would refuse is not subscribed (Rule 20)
      try {
        assertDigits(pair.digits);
        next.set(pair.id, pair.digits);
      } catch {
        skipped += 1;
      }
    }
    // a pair keeps the digits of its first tick in the ring; a new map changes only new pairs
    digitsById = next;
    skippedDigits = skipped;
    catalogFresh = true;
    return true;
  }

  // the active only (S4): open('active'), R3 and R6
  function subscribeNew(client: BrokerSocketClient): void {
    if (!catalogFresh) return;
    const have = new Set(client.subscriptions());
    const added = [...digitsById.keys()].filter((id) => !have.has(id));
    if (added.length > 0) client.subscribe(added);
  }

  function logRefusal(role: Role, accountId: string, result: AccessTokenResult & { ok: false }) {
    const fields = { role, accountId, reason: result.reason };
    switch (result.reason) {
      case AccessTokenRefusal.AccountRevoked:
        logger.warn(
          { ...fields, revokedReason: result.revokedReason },
          'market data token refused',
        );
        return;
      // refresh_needed is unreachable with mayRefresh: true
      case AccessTokenRefusal.RefreshRateLimited:
      case AccessTokenRefusal.KeyUnavailable:
      case AccessTokenRefusal.RefreshNeeded:
        logger.warn(fields, 'market data token refused');
        return;
      // the list will not offer the account again once the row says so; held for the race
      case AccessTokenRefusal.NotService:
      case AccessTokenRefusal.UserBlocked:
      case AccessTokenRefusal.AccountPending:
      case AccessTokenRefusal.AccountNotFound:
        logger.info(fields, 'market data token refused');
        return;
      default:
        assertExhausted(result, 'access token refusal');
    }
  }

  // silent: stop() and a client that threw at its start
  function drop(role: Role): void {
    const slot = slots[role];
    slots[role] = EMPTY;
    if (slot.kind !== 'running') return;
    slot.live.detach();
    slot.live.client.stop();
  }

  function vacate(role: Role, reason: string, hold: boolean): void {
    const slot = slots[role];
    const account = accountOf(slot);
    if (account === undefined) return;
    if (role === 'active' && isReady(slot)) {
      ring.onDrop();
      seconds.onDrop();
    }
    drop(role);
    if (hold) holdBack(account.id);
    if (role === 'active') {
      failovers += 1;
      logger.warn({ from: account.id, reason, heldBack: hold }, 'market data failover');
    } else {
      logger.info({ accountId: account.id, reason, heldBack: hold }, 'market data reserve stopped');
    }
  }

  function startJob(role: Role, account: MarketDataAccount): Promise<void> {
    const job: Job = { kind: 'starting', account, since: now() };
    slots[role] = job;
    // reported once: a later call exchanges anyway, the stored token is marked expired by then
    const refusedToken = refused.get(account.id);
    refused.delete(account.id);
    const options: AccessTokenOptions = {
      mayRefresh: true,
      serviceOnly: true,
      ...(refusedToken === undefined ? {} : { refusedToken }),
    };
    const work = (async () => {
      let result: AccessTokenResult;
      try {
        result = await accessToken(account.id, options);
      } catch (error) {
        if (slots[role] !== job) return;
        // a database error carries the statement and the row's values: name and code only
        logger.error(
          { role, accountId: account.id, ...errorLogFields(error) },
          'market data token threw',
        );
        holdBack(account.id);
        slots[role] = EMPTY;
        reconcile();
        return;
      }
      // vacated, promoted over or stopped while it waited: the answer opens nothing
      if (slots[role] !== job) return;
      if (!result.ok) {
        holdBack(account.id);
        logRefusal(role, account.id, result);
        slots[role] = EMPTY;
        reconcile();
        return;
      }
      open(role, job, result.accessToken);
      reconcile();
    })();
    track(work);
    return work;
  }

  // a throw of the client (invalid credentials) is the account's failure: held back
  function open(role: Role, job: Job, token: string): void {
    const { account } = job;
    let live: Live | undefined;
    try {
      const client = openClient(account.id);
      const opened: Live = { account, client, token, since: job.since, detach: () => undefined };
      live = opened;
      const offState = client.onState((change) => onState(opened, change));
      const offEvent = client.onEvent((event) => onEvent(opened, event));
      opened.detach = () => {
        offState();
        offEvent();
      };
      // before start(): a client may deliver a state change inside it
      slots[role] = { kind: 'running', live: opened };
      if (role === 'active') {
        noAccountWarned = false;
        // sent with the pass after user.auth.success; a stale catalog leaves it to a later tick
        readCatalog();
        subscribeNew(client);
      }
      client.start({ brokerUserId: account.brokerUserId, accessToken: token });
    } catch (error) {
      logger.error(
        { role, accountId: account.id, ...errorLogFields(error) },
        'market data socket start threw',
      );
      if (live !== undefined) {
        const at = roleOf(live);
        if (at !== undefined) slots[at] = EMPTY;
        live.detach();
        live.client.stop();
      }
      if (slots[role] === job) slots[role] = EMPTY;
      holdBack(account.id);
      return;
    }
    // start() may have delivered ready, and a nested reconcile() moved the client already
    const at = roleOf(live);
    if (at === undefined) return;
    logger.info({ role: at, accountId: account.id }, 'market data socket started');
  }

  function promote(): void {
    const reserve = slots.reserve;
    if (reserve.kind !== 'running') return;
    vacate('active', 'not_ready', false);
    slots.active = reserve;
    slots.reserve = EMPTY;
    noAccountWarned = false;
    subscribeNew(reserve.live.client);
    logger.info({ to: reserve.live.account.id }, 'market data reserve promoted');
  }

  function armDeadline(at: number): void {
    clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    const deadlines: number[] = [];
    const active = sinceOf(slots.active);
    const reserve = sinceOf(slots.reserve);
    if (active !== undefined) deadlines.push(active + config.failoverGraceMs);
    if (reserve !== undefined) deadlines.push(reserve + config.reserveReadyMs);
    const next = Math.min(...deadlines.filter((deadline) => deadline > at));
    if (!Number.isFinite(next)) return;
    deadlineTimer = setTimeout(() => {
      deadlineTimer = undefined;
      try {
        reconcile();
      } catch (error) {
        logger.error(errorLogFields(error), 'market data work failed');
      }
    }, next - at);
  }

  // synchronous and idempotent; the starts it began, for the tick to wait on
  function reconcile(): Promise<void>[] {
    if (stopped) return [];
    readCatalog();
    const at = now();
    const started: Promise<void>[] = [];
    for (const role of ROLES) {
      const account = accountOf(slots[role]);
      if (account !== undefined && !order.some((listed) => listed.id === account.id)) {
        vacate(role, 'not_working', false);
      }
    }
    const reserveSince = sinceOf(slots.reserve);
    const reserveId = accountOf(slots.reserve)?.id;
    if (
      !isReady(slots.reserve) &&
      reserveSince !== undefined &&
      at >= reserveSince + config.reserveReadyMs &&
      candidates('reserve').some((account) => account.id !== reserveId)
    ) {
      vacate('reserve', 'not_ready', true);
    }
    const activeSince = sinceOf(slots.active);
    if (
      isReady(slots.reserve) &&
      !isReady(slots.active) &&
      (slots.active.kind === 'empty' ||
        (activeSince !== undefined && at >= activeSince + config.failoverGraceMs))
    ) {
      promote();
    }
    if (slots.active.kind === 'empty') {
      const [first] = candidates('active');
      if (first !== undefined) started.push(startJob('active', first));
      else if (slots.reserve.kind === 'empty' && !noAccountWarned) {
        logger.warn(
          { accounts: order.length, held: held.size },
          'market data: no working service account',
        );
        noAccountWarned = true;
      }
    }
    if (slots.reserve.kind === 'empty') {
      const [first] = candidates('reserve');
      if (first !== undefined) started.push(startJob('reserve', first));
    }
    const active = slots.active;
    if (active.kind === 'running') subscribeNew(active.live.client);
    armDeadline(at);
    return started;
  }

  function onState(live: Live, change: BrokerSocketStateChange): void {
    const role = roleOf(live);
    if (role === undefined) return;
    if (change.to === BrokerSocketState.Ready) live.since = undefined;
    else if (change.from === BrokerSocketState.Ready) {
      live.since = now();
      if (role === 'active') {
        ring.onDrop();
        seconds.onDrop();
      }
    }
    if (change.to === BrokerSocketState.DisconnectedByServer) {
      logger.warn(
        { role, accountId: live.account.id, reason: change.reason ?? null },
        'market data socket disconnected by server',
      );
      vacate(role, change.to, true);
    } else if (
      change.to === BrokerSocketState.TokenExpired ||
      change.to === BrokerSocketState.AuthFailed
    ) {
      // the first refusal in the window costs one start; a second one holds the account back
      const id = live.account.id;
      const repeated = now() - (lastRefusal.get(id) ?? -Infinity) < config.accountRetryMs;
      lastRefusal.set(id, now());
      refused.set(id, hashToken(live.token));
      vacate(role, change.to, repeated);
    }
    reconcile();
  }

  function onEvent(live: Live, event: BrokerEvent): void {
    const role = roleOf(live);
    if (role === undefined) return;
    switch (event.type) {
      case BrokerEventType.PriceUpdate: {
        if (role !== 'active') return;
        const { assetId, price, timestamp } = event.update;
        const digits = digitsById.get(assetId);
        if (digits === undefined) {
          unknownAsset += 1;
          return;
        }
        ticks += 1;
        const receivedAtMs = now();
        ring.push(assetId, digits, { price, timestamp }, receivedAtMs);
        tickStore.push(assetId, { price, timestamp }, receivedAtMs);
        seconds.push(assetId, digits, { price, timestamp }, receivedAtMs);
        return;
      }
      case BrokerEventType.UserData: {
        if (event.user.id === live.account.brokerUserId) return;
        // the other user's id is theirs: not logged
        logger.warn({ role, accountId: live.account.id }, 'market data foreign user');
        vacate(role, 'foreign_user', true);
        reconcile();
        return;
      }
      default:
        return;
    }
  }

  async function runTick(): Promise<void> {
    order = await listAccounts();
    const at = now();
    for (const [accountId, retryAt] of held) {
      if (retryAt <= at) held.delete(accountId);
    }
    for (const [accountId, refusedAt] of lastRefusal) {
      if (refusedAt + config.accountRetryMs <= at) lastRefusal.delete(accountId);
    }
    await Promise.allSettled(reconcile());
  }

  // a tick longer than the interval makes the next one a no-op
  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    running ??= runTick()
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'market data tick failed');
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  // `socketState`, not `state`: the logger redacts every `state` key (the OAuth state, Rule 8)
  function roleView(role: Role) {
    const slot = slots[role];
    if (slot.kind === 'empty') return null;
    if (slot.kind === 'starting') return { accountId: slot.account.id, socketState: 'starting' };
    const { client, account } = slot.live;
    return role === 'active'
      ? {
          accountId: account.id,
          socketState: client.state,
          connection: client.connections,
          subscriptions: client.subscriptions().length,
        }
      : { accountId: account.id, socketState: client.state };
  }

  function report(): void {
    if (stopped) return;
    const at = now();
    const counters = ring.counters();
    const since = (key: 'late' | 'invalid' | 'skewed' | 'holed' | 'holes') =>
      counters[key] - reportedCounters[key];
    const closed: Record<string, number> = {};
    for (const interval of SIGNAL_SCAN_INTERVALS) {
      const until = ring.closedUntil(interval, at);
      closed[interval] = ring.closedBetween(
        interval,
        reportedClosedUntil.get(interval) ?? -Infinity,
        until,
      );
      reportedClosedUntil.set(interval, until);
    }
    const filling = backfill.counters();
    const backfillSince = (key: BackfillTotal) => filling[key] - reportedBackfill[key];
    const secondCounts = seconds.counters();
    const secondsSince = (key: Exclude<keyof SecondSeriesCounters, 'pairs'>) =>
      secondCounts[key] - reportedSeconds[key];
    const periodMs = Math.max(at - reportedAt, 1);
    logger.info(
      {
        accounts: order.length,
        held: [...held.values()].filter((retryAt) => retryAt > at).length,
        active: roleView('active'),
        reserve: roleView('reserve'),
        ticks,
        ticksPerSec: Math.round((ticks * 10_000) / periodMs) / 10,
        late: since('late'),
        invalid: since('invalid'),
        skewed: since('skewed'),
        holed: since('holed'),
        unknownAsset,
        skippedDigits,
        holes: since('holes'),
        lateClose: {
          watermark: counters.lateClose.watermark - reportedCounters.lateClose.watermark,
          clock: counters.lateClose.clock - reportedCounters.lateClose.clock,
        },
        failovers,
        watermarkLagMs: ring.watermark === undefined ? null : at - ring.watermark,
        closed,
        pairs: counters.pairs,
        pending: requests.size,
        backfill: {
          queued: filling.queued,
          fetched: backfillSince('fetched'),
          filled: backfillSince('filled'),
          failed: backfillSince('failed'),
          rateLimited: backfillSince('rateLimited'),
          spare: backfillSince('spare'),
        },
        seconds: {
          pairs: secondCounts.pairs,
          late: secondsSince('late'),
          closedByTick: secondsSince('closedByTick'),
          closedByClock: secondsSince('closedByClock'),
          holeSeconds: secondsSince('holeSeconds'),
          resets: secondsSince('resets'),
        },
      },
      'market data',
    );
    reportedAt = at;
    reportedSeconds = secondCounts;
    reportedCounters = counters;
    reportedBackfill = filling;
    ticks = 0;
    unknownAsset = 0;
    failovers = 0;
  }

  return {
    start() {
      if (stopped || tickTimer !== undefined) return;
      void tick();
      tickTimer = setInterval(() => void tick(), config.tickMs);
      logTimer = setInterval(report, config.logMs);
    },
    tick,
    report,
    streaming: () => !stopped && isReady(slots.active),
    async stop() {
      stopped = true;
      clearInterval(tickTimer);
      clearInterval(logTimer);
      tickTimer = undefined;
      logTimer = undefined;
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      drop('active');
      drop('reserve');
      await Promise.allSettled([running, ...inflight]);
    },
  };
}
