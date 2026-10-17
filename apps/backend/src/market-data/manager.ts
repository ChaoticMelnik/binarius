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
  isTerminalBrokerSocketState,
  type BrokerEvent,
  type BrokerSocketClient,
  type BrokerSocketStateChange,
} from '@binarius/broker-socket';
import { assertDigits } from '@binarius/signal';
import type { AccessTokenOptions, AccessTokenResult } from '../auth/token-service';
import type { CandleRing } from './ring';
import type { PendingRequests } from './source';

// The data socket of the backend (#404, docs/market-data.md). At most two broker socket clients,
// both on service accounts (#391): the active one, subscribed to every pair of the fresh catalog,
// whose ticks build the ring, and a warm reserve, authenticated and subscribed to nothing. The
// reserve takes over at once on a terminal state of the active, and after the grace on its
// reconnection. No trade command is ever sent on these sockets.

export interface MarketDataConfig {
  tickMs: number;
  logMs: number;
  failoverGraceMs: number;
  accountRetryMs: number;
}

export interface MarketDataAccount {
  id: string;
  brokerUserId: string;
}

export interface MarketDataManagerDeps {
  // the working service accounts, in the order they are tried
  listAccounts: () => Promise<readonly MarketDataAccount[]>;
  accessToken: (accountId: string, options: AccessTokenOptions) => Promise<AccessTokenResult>;
  catalog: Pick<PairsCatalog, 'read'>;
  // a new, idle client; label: the account it is opened for
  openClient: (label: string) => BrokerSocketClient;
  ring: CandleRing;
  requests: Pick<PendingRequests, 'size'>;
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
}

type Role = 'active' | 'reserve';

interface Live {
  account: MarketDataAccount;
  client: BrokerSocketClient;
  token: string;
  detach: () => void;
}

// starting and refreshing wait on accessToken; the tick fills only an empty slot, so there are
// never more than two clients. I1: no handler ends with the active empty and the reserve ready
// (promote()). I2: every start and exchange ends by writing its own slot, or by stopped
type Slot =
  | { kind: 'empty' }
  | { kind: 'starting'; accountId: string }
  | { kind: 'running'; live: Live }
  | { kind: 'refreshing'; live: Live };

const EMPTY: Slot = { kind: 'empty' };

interface Refused {
  account: MarketDataAccount;
  // hashToken of the token the broker refused
  hash: string;
}

const liveOf = (slot: Slot): Live | undefined =>
  slot.kind === 'running' || slot.kind === 'refreshing' ? slot.live : undefined;

const accountOf = (slot: Slot): string | undefined =>
  slot.kind === 'starting' ? slot.accountId : liveOf(slot)?.account.id;

export function createMarketDataManager(deps: MarketDataManagerDeps): MarketDataManager {
  const { listAccounts, accessToken, catalog, openClient, ring, requests, logger, config } = deps;
  const now = deps.now ?? Date.now;
  const slots: Record<Role, Slot> = { active: EMPTY, reserve: EMPTY };
  // account id → when it may be tried again
  const held = new Map<string, number>();
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
  let graceTimer: NodeJS.Timeout | undefined;

  // the period's counters, reset by report()
  let ticks = 0;
  let unknownAsset = 0;
  let failovers = 0;
  let reportedAt = now();
  let reportedCounters = ring.counters();
  const reportedClosedUntil = new Map<ScanInterval, number>();

  const isHeld = (accountId: string) => (held.get(accountId) ?? 0) > now();
  const holdBack = (accountId: string) => held.set(accountId, now() + config.accountRetryMs);
  const other = (role: Role): Role => (role === 'active' ? 'reserve' : 'active');

  function roleOf(live: Live): Role | undefined {
    if (liveOf(slots.active) === live) return 'active';
    if (liveOf(slots.reserve) === live) return 'reserve';
    return undefined;
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

  const settle = (work: Promise<boolean>) => track(work.then(() => undefined));

  // the accounts a role may start on, first the one named (a refused token's own account)
  function candidates(role: Role, first?: MarketDataAccount): MarketDataAccount[] {
    const taken = accountOf(slots[other(role)]);
    const rest = order.filter((account) => account.id !== first?.id && !isHeld(account.id));
    return [...(first === undefined ? [] : [first]), ...rest].filter(
      (account) => account.id !== taken,
    );
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

  function subscribeNew(): void {
    const active = slots.active;
    if (active.kind !== 'running' || !catalogFresh) return;
    const have = new Set(active.live.client.subscriptions());
    const added = [...digitsById.keys()].filter((id) => !have.has(id));
    if (added.length > 0) active.live.client.subscribe(added);
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

  function drop(role: Role): void {
    const live = liveOf(slots[role]);
    slots[role] = EMPTY;
    if (live === undefined) return;
    live.detach();
    live.client.stop();
  }

  function clearGrace(): void {
    clearTimeout(graceTimer);
    graceTimer = undefined;
  }

  // the role's starts, one account after another until one opens a client; every refusal holds
  // its account back. True when the broker's rate limit ended the run
  async function startRole(
    role: Role,
    list: MarketDataAccount[],
    refused?: Refused,
  ): Promise<boolean> {
    let limited = false;
    for (const account of list) {
      if (stopped) break;
      // the roles may have moved while an earlier attempt waited
      if (
        account.id === accountOf(slots[other(role)]) ||
        (isHeld(account.id) && account.id !== refused?.account.id)
      ) {
        continue;
      }
      slots[role] = { kind: 'starting', accountId: account.id };
      const options: AccessTokenOptions = {
        mayRefresh: true,
        serviceOnly: true,
        ...(refused?.account.id === account.id ? { refusedToken: refused.hash } : {}),
      };
      let result: AccessTokenResult;
      try {
        result = await accessToken(account.id, options);
      } catch (error) {
        // a database error carries the statement and the row's values: name and code only
        logger.error(
          { role, accountId: account.id, ...errorLogFields(error) },
          'market data token threw',
        );
        holdBack(account.id);
        continue;
      }
      if (stopped) break;
      if (result.ok) {
        if (open(role, account, result.accessToken)) return false;
        continue;
      }
      holdBack(account.id);
      logRefusal(role, account.id, result);
      // the pair is intact and the limit is per address: the next account would get it too
      if (result.reason === AccessTokenRefusal.RefreshRateLimited) {
        limited = true;
        break;
      }
    }
    slots[role] = EMPTY;
    // a run cut by the rate limit is not continued on the reserve's side either
    if (role === 'active' && !stopped) promoteReserve(!limited);
    return limited;
  }

  // false when the client threw (invalid credentials, a second start): the account is held back
  function open(role: Role, account: MarketDataAccount, token: string): boolean {
    // sent with the pass after user.auth.success; a stale catalog leaves it to a later tick
    const ids = role === 'active' && readCatalog() ? [...digitsById.keys()] : undefined;
    let live: Live | undefined;
    try {
      const client = openClient(account.id);
      const opened: Live = { account, client, token, detach: () => undefined };
      live = opened;
      const offState = client.onState((change) => onState(opened, change));
      const offEvent = client.onEvent((event) => onEvent(opened, event));
      opened.detach = () => {
        offState();
        offEvent();
      };
      // before start(): a client may deliver a state change inside it
      slots[role] = { kind: 'running', live: opened };
      if (role === 'active') noAccountWarned = false;
      if (ids !== undefined) client.subscribe(ids);
      client.start({ brokerUserId: account.brokerUserId, accessToken: token });
    } catch (error) {
      logger.error(
        { role, accountId: account.id, ...errorLogFields(error) },
        'market data socket start threw',
      );
      if (live !== undefined) {
        if (liveOf(slots[role]) === live) slots[role] = EMPTY;
        live.detach();
        live.client.stop();
      }
      holdBack(account.id);
      return false;
    }
    logger.info({ role, accountId: account.id }, 'market data socket started');
    return true;
  }

  // the ready reserve takes the empty active slot; ids: the old active's registry, else the catalog
  function promote(ids?: readonly number[]): Live | undefined {
    const reserve = slots.reserve;
    if (
      slots.active.kind !== 'empty' ||
      reserve.kind !== 'running' ||
      reserve.live.client.state !== BrokerSocketState.Ready
    ) {
      return undefined;
    }
    // a fresh reserve was never subscribed; a stale catalog leaves it to a later tick
    const subscribe = ids ?? (readCatalog() ? [...digitsById.keys()] : []);
    if (subscribe.length > 0) reserve.live.client.subscribe(subscribe);
    slots.active = reserve;
    slots.reserve = EMPTY;
    noAccountWarned = false;
    return reserve.live;
  }

  function startReserve(refused?: Refused): void {
    const list = candidates('reserve', refused?.account);
    if (list.length > 0) settle(startRole('reserve', list, refused));
  }

  // a promotion with no failover: the switch was counted when the active left
  function promoteReserve(thenStartReserve: boolean): void {
    const promoted = promote();
    if (promoted === undefined) return;
    logger.info({ to: promoted.account.id }, 'market data reserve promoted');
    if (thenStartReserve) startReserve();
  }

  function failover(reason: string, refused?: Refused): void {
    clearGrace();
    failovers += 1;
    const old = liveOf(slots.active);
    const subscriptions = old?.client.subscriptions() ?? [];
    if (old !== undefined && old.client.state === BrokerSocketState.Ready) ring.onDrop();
    drop('active');
    // the registry of the old active goes over whole
    const promoted = promote(subscriptions);
    if (promoted !== undefined) {
      logger.warn(
        { from: old?.account.id ?? null, to: promoted.account.id, reason },
        'market data failover',
      );
      startReserve(refused);
      return;
    }
    // a reserve that is not ready keeps its slot; whichever comes first takes the active role
    logger.warn({ from: old?.account.id ?? null, to: null, reason }, 'market data failover');
    const list = candidates('active');
    if (list.length > 0) settle(startRole('active', list));
    if (slots.reserve.kind === 'empty') startReserve();
  }

  // the same client, a new token: the token service marks the refused one expired and exchanges
  function refresh(role: Role, live: Live): void {
    slots[role] = { kind: 'refreshing', live };
    const current = () =>
      !stopped && liveOf(slots[role]) === live && slots[role].kind === 'refreshing';
    const fail = () => {
      holdBack(live.account.id);
      if (role === 'active') failover('token_refused');
      else drop('reserve');
    };
    track(
      (async () => {
        let result: AccessTokenResult;
        try {
          result = await accessToken(live.account.id, {
            mayRefresh: true,
            serviceOnly: true,
            refusedToken: hashToken(live.token),
          });
        } catch (error) {
          if (!current()) return;
          logger.error(
            { role, accountId: live.account.id, ...errorLogFields(error) },
            'market data token threw',
          );
          fail();
          return;
        }
        if (!current()) return;
        if (result.ok) {
          live.token = result.accessToken;
          slots[role] = { kind: 'running', live };
          try {
            live.client.start({ brokerUserId: live.account.brokerUserId, accessToken: live.token });
          } catch (error) {
            logger.error(
              { role, accountId: live.account.id, ...errorLogFields(error) },
              'market data socket start threw',
            );
            fail();
            return;
          }
          logger.info({ role, accountId: live.account.id }, 'market data token refreshed');
          return;
        }
        logRefusal(role, live.account.id, result);
        fail();
      })(),
    );
  }

  function onState(live: Live, change: BrokerSocketStateChange): void {
    const role = roleOf(live);
    if (role === undefined || slots[role].kind !== 'running') return;
    if (role === 'reserve' && change.to === BrokerSocketState.Ready) {
      promoteReserve(true);
      return;
    }
    if (role === 'active') {
      if (change.to === BrokerSocketState.Ready) {
        clearGrace();
        return;
      }
      if (change.from === BrokerSocketState.Ready) ring.onDrop();
      if (change.to === BrokerSocketState.Reconnecting) {
        graceTimer ??= setTimeout(() => {
          graceTimer = undefined;
          if (liveOf(slots.active) === live && live.client.state !== BrokerSocketState.Ready) {
            failover('reconnect_timeout');
          }
        }, config.failoverGraceMs);
        return;
      }
    }
    if (!isTerminalBrokerSocketState(change.to)) return;
    if (role === 'active') clearGrace();
    if (
      change.to === BrokerSocketState.TokenExpired ||
      change.to === BrokerSocketState.AuthFailed
    ) {
      const reserve = slots.reserve;
      // decision 7a: a ready reserve takes over at once, and the old account's refused token is
      // reported by the start of the next reserve on it
      if (
        role === 'active' &&
        reserve.kind === 'running' &&
        reserve.live.client.state === BrokerSocketState.Ready
      ) {
        failover(change.to, { account: live.account, hash: hashToken(live.token) });
        return;
      }
      refresh(role, live);
      return;
    }
    logger.warn(
      { role, accountId: live.account.id, reason: change.reason ?? null },
      'market data socket disconnected by server',
    );
    holdBack(live.account.id);
    if (role === 'active') failover(change.to);
    else drop('reserve');
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
        ring.push(assetId, digits, { price, timestamp }, now());
        return;
      }
      case BrokerEventType.UserData: {
        if (event.user.id === live.account.brokerUserId) return;
        // the other user's id is theirs: not logged
        logger.warn({ role, accountId: live.account.id }, 'market data foreign user');
        holdBack(live.account.id);
        if (role === 'active') failover('foreign_user');
        else drop('reserve');
        return;
      }
      default:
        return;
    }
  }

  async function runTick(): Promise<void> {
    order = await listAccounts();
    if (stopped) return;
    const at = now();
    for (const [accountId, retryAt] of held) {
      if (retryAt <= at) held.delete(accountId);
    }
    readCatalog();
    if (slots.active.kind === 'empty') {
      const list = candidates('active');
      if (list.length === 0) {
        if (!noAccountWarned) {
          logger.warn(
            { accounts: order.length, held: held.size },
            'market data: no working service account',
          );
          noAccountWarned = true;
        }
      } else if (await startRole('active', list)) {
        return;
      }
    }
    if (stopped) return;
    if (slots.reserve.kind === 'empty') {
      const list = candidates('reserve');
      if (list.length > 0 && (await startRole('reserve', list))) return;
    }
    if (stopped) return;
    subscribeNew();
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
    if (slot.kind === 'starting') return { accountId: slot.accountId, socketState: 'starting' };
    const { client, account } = slot.live;
    const socketState = slot.kind === 'refreshing' ? 'refreshing' : client.state;
    return role === 'active'
      ? {
          accountId: account.id,
          socketState,
          connection: client.connections,
          subscriptions: client.subscriptions().length,
        }
      : { accountId: account.id, socketState };
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
      },
      'market data',
    );
    reportedAt = at;
    reportedCounters = counters;
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
    async stop() {
      stopped = true;
      clearInterval(tickTimer);
      clearInterval(logTimer);
      tickTimer = undefined;
      logTimer = undefined;
      clearGrace();
      drop('active');
      drop('reserve');
      await Promise.allSettled([running, ...inflight]);
      slots.active = EMPTY;
      slots.reserve = EMPTY;
    },
  };
}
