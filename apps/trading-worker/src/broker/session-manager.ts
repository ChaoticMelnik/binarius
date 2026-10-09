import {
  hashToken,
  type BalanceEventWrite,
  type BalanceSnapshotWrite,
  type ClosedTradeOutcome,
  type SessionCandidate,
} from '@binarius/db';
import {
  AccessTokenRefusal,
  errorLogFields,
  TradeMode,
  type BrokerBalance,
  type BrokerUser,
  type ClosedTrade,
} from '@binarius/shared';
import type pino from 'pino';
import {
  AccessTokenUnavailable,
  type AccessTokenOutcome,
  type AccessTokenSource,
} from './access-token';
import { BrokerEventType, type BrokerEvent } from './events';
import { DEAD_LETTER_WRITE_TIMEOUT_MS, type SessionManagerConfig } from './session-config';
import {
  BrokerSocketState,
  createBrokerSocketClient,
  type BrokerSocketClient,
  type BrokerSocketClientOptions,
  type BrokerSocketStateChange,
} from './socket';
import type { BrokerSocketTiming } from './socket-config';
import type { TradeSessionSource } from './trade-session';
import {
  deadLetterSessionWrite,
  type DeadLetterSink,
  type SessionDeadLetter,
} from '../dead-letter';

// One BrokerSocketClient per broker account in work (docs/broker-session.md). The manager opens
// no trade and reconciles nothing: it keeps the sessions the executor sends commands over, and
// writes what the sessions hear — the balance and the closed trades — once the connection has
// proven whose it is.

export type SessionLogger = Pick<pino.Logger, 'debug' | 'info' | 'warn' | 'error' | 'child'>;

export interface SessionWriters {
  snapshot(
    accountId: string,
    user: BrokerUser,
    modes: readonly TradeMode[],
  ): Promise<BalanceSnapshotWrite>;
  balanceEvent(
    accountId: string,
    mode: TradeMode,
    balance: BrokerBalance,
  ): Promise<BalanceEventWrite>;
  closedTrades(accountId: string, trades: readonly ClosedTrade[]): Promise<ClosedTradeOutcome[]>;
}

// The account's lease (#93, docs/broker-session.md → The lease), bound to this process's owner id
// by the caller: production is session-lease-ops.ts over the worker's database.
export interface SessionLeases {
  acquire(accountId: string, ttlMs: number): Promise<boolean>;
  // the ids still held; a missing id is a lease lost
  renew(accountIds: readonly string[], ttlMs: number): Promise<string[]>;
  release(): Promise<unknown>;
}

export interface BrokerSessionManagerDeps {
  url: string;
  // production: listSessionCandidates over the worker's database
  candidates: (options: {
    watchWindowMs: number;
    exclude: readonly string[];
  }) => Promise<SessionCandidate[]>;
  tokens: AccessTokenSource;
  writers: SessionWriters;
  // a writer that throws leaves its event here (#92)
  deadLetters: DeadLetterSink;
  leases: SessionLeases;
  // the fence's clock: monotonic, so a wall-clock jump neither extends nor cuts a lease
  monotonicNow?: () => number;
  logger: SessionLogger;
  config: SessionManagerConfig;
  // passed to every client (tests shorten the waits)
  timing?: Partial<BrokerSocketTiming>;
  // default createBrokerSocketClient; a seam for tests
  openClient?: (options: BrokerSocketClientOptions) => BrokerSocketClient;
}

export interface BrokerSessionManager extends TradeSessionSource {
  // one tick at once, then every tickMs
  start(): void;
  // single-flight; the scan and the bookkeeping only, never waits for a start; never rejects
  tick(): Promise<void>;
  // single-flight; one renewal of every lease the entries hold, every leaseRenewMs once started;
  // never rejects
  renewLeases(): Promise<void>;
  // the timer, the start pool, every client, then the write in flight per account within
  // stopBudgetMs; the writes queued behind it are dropped
  stop(): Promise<void>;
  // the running client of the account, verified or not: tests
  clientFor(accountId: string): BrokerSocketClient | undefined;
  // running + starting
  readonly size: number;
}

type WriteSource = SessionDeadLetter['source'];
type WriteRef = Pick<SessionDeadLetter, 'mode' | 'brokerTradeIds'>;

interface StartingEntry {
  kind: 'starting';
  candidate: SessionCandidate;
  // the fence: monotonic time until which the lease is ours; unset until the acquire answered
  leaseUntil?: number;
}

interface RunningEntry {
  kind: 'running';
  candidate: SessionCandidate;
  leaseUntil: number;
  client: BrokerSocketClient;
  token: string;
  // this connection's user.data carried the account's broker user id
  verified: boolean;
  // a token fetch after token_expired/auth_failed is in flight
  refreshing: boolean;
  idleSince?: number;
  // warn-once keys of the current connection
  warned: Set<string>;
}

type Entry = StartingEntry | RunningEntry;

// one per account: the writes of a session land in the order its events came, and a new
// session of the same account queues behind what an earlier one left
interface WriteQueue {
  tasks: (() => Promise<void>)[];
  running?: Promise<void>;
}

export function createBrokerSessionManager(deps: BrokerSessionManagerDeps): BrokerSessionManager {
  const { config, logger, tokens, writers, leases } = deps;
  const openClient = deps.openClient ?? createBrokerSocketClient;
  const now = deps.monotonicNow ?? (() => performance.now());
  const entries = new Map<string, Entry>();
  const heldBack = new Map<string, number>();
  const queues = new Map<string, WriteQueue>();
  const stopping = new AbortController();
  let startQueue: SessionCandidate[] = [];
  let workers = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  let renewing: Promise<void> | undefined;
  let fenceTimer: ReturnType<typeof setTimeout> | undefined;

  const isCurrent = (accountId: string, entry: Entry) => entries.get(accountId) === entry;

  function holdBack(accountId: string, ms: number) {
    heldBack.set(accountId, Date.now() + ms);
  }

  // closes the account's client and forgets it: the account is a plain candidate again once its
  // hold-back is over
  function drop(accountId: string, holdBackMs?: number) {
    const entry = entries.get(accountId);
    entries.delete(accountId);
    if (holdBackMs !== undefined) holdBack(accountId, holdBackMs);
    if (entry?.kind === 'running') entry.client.stop();
  }

  // A lease acquired or renewed by a statement sent at t0 holds in the database until at least
  // t0 + leaseTtlMs (the database's now() is not earlier than the send), so the process trusts it
  // until t0 + leaseFenceMs and closes the socket then, before anyone else may open one.
  function armFence() {
    if (fenceTimer !== undefined) clearTimeout(fenceTimer);
    fenceTimer = undefined;
    if (stopping.signal.aborted) return;
    let earliest = Infinity;
    for (const entry of entries.values()) {
      if (entry.leaseUntil !== undefined) earliest = Math.min(earliest, entry.leaseUntil);
    }
    if (earliest === Infinity) return;
    fenceTimer = setTimeout(fence, Math.max(0, earliest - now()));
  }

  function fence() {
    fenceTimer = undefined;
    const at = now();
    for (const [accountId, entry] of [...entries]) {
      if (entry.leaseUntil === undefined || entry.leaseUntil > at) continue;
      logger.warn({ accountId, lateMs: Math.round(at - entry.leaseUntil) }, 'broker session lease fenced');
      drop(accountId, config.retryMs);
    }
    armFence();
  }

  // Only the entries whose acquire has answered: an acquire still in flight may not have
  // committed, and a renewal that misses its id would drop a lease about to be ours. The answer
  // applies to the same entry objects it was sent for.
  async function runRenewal() {
    const sent = [...entries].filter(([, entry]) => entry.leaseUntil !== undefined);
    if (sent.length === 0) return;
    const t0 = now();
    let held: string[];
    try {
      held = await leases.renew(
        sent.map(([accountId]) => accountId),
        config.leaseTtlMs,
      );
    } catch (error) {
      // the fence decides: one failed renewal leaves every lease trusted (2 × renew < fence)
      logger.error(errorLogFields(error), 'broker session lease renewal failed');
      return;
    }
    if (stopping.signal.aborted) return;
    const kept = new Set(held);
    for (const [accountId, entry] of sent) {
      if (!isCurrent(accountId, entry)) continue;
      if (kept.has(accountId)) {
        entry.leaseUntil = Math.max(entry.leaseUntil ?? 0, t0 + config.leaseFenceMs);
        continue;
      }
      logger.warn({ accountId }, 'broker session lease lost');
      drop(accountId, config.retryMs);
    }
    armFence();
  }

  function renewLeases(): Promise<void> {
    if (stopping.signal.aborted) return Promise.resolve();
    renewing ??= runRenewal()
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'broker session lease renewal failed');
      })
      .finally(() => {
        renewing = undefined;
      });
    return renewing;
  }

  // the hold-back a non-ok answer earns, with its log line; undefined while stopping
  function holdBackFor(
    accountId: string,
    outcome: Extract<AccessTokenOutcome, { ok: false }>,
  ): number | undefined {
    const { reason, status } = outcome;
    switch (reason) {
      case AccessTokenRefusal.RefreshNeeded:
        logger.info({ accountId }, 'broker session waits for a token exchange');
        return config.retryMs;
      case AccessTokenUnavailable.BackendUnreachable:
        if (stopping.signal.aborted) return undefined;
        logger.warn({ accountId, reason, status }, 'broker session token unavailable');
        return config.retryMs;
      // not_configured: index.ts builds the manager only with the backend source;
      // refresh_rate_limited is unreachable with mayRefresh: false, temporary if it ever comes
      // (#275)
      case AccessTokenUnavailable.BackendStatus:
      case AccessTokenUnavailable.ContractViolation:
      case AccessTokenUnavailable.NotConfigured:
      case AccessTokenRefusal.RefreshRateLimited:
        logger.warn({ accountId, reason, status }, 'broker session token unavailable');
        return config.retryMs;
      case AccessTokenRefusal.AccountNotFound:
      case AccessTokenRefusal.AccountPending:
      case AccessTokenRefusal.AccountRevoked:
      case AccessTokenRefusal.UserBlocked:
      case AccessTokenRefusal.KeyUnavailable:
        logger.warn({ accountId, refusal: reason }, 'broker session token refused');
        return config.refusalRetryMs;
      default: {
        const unhandled: never = reason;
        throw new Error(`unhandled access token answer ${String(unhandled)}`);
      }
    }
  }

  function fetchToken(accountId: string, refusedToken?: string) {
    return tokens.accessToken(accountId, {
      mayRefresh: false,
      signal: stopping.signal,
      refusedToken,
    });
  }

  function firstOnConnection(entry: RunningEntry, key: string): boolean {
    if (entry.warned.has(key)) return false;
    entry.warned.add(key);
    return true;
  }

  function pump(accountId: string, queue: WriteQueue) {
    if (queue.running !== undefined) return;
    const task = queue.tasks.shift();
    if (task === undefined) {
      queues.delete(accountId);
      return;
    }
    queue.running = task().finally(() => {
      queue.running = undefined;
      pump(accountId, queue);
    });
  }

  function enqueue(
    accountId: string,
    source: WriteSource,
    ref: WriteRef,
    write: () => Promise<void>,
  ) {
    let queue = queues.get(accountId);
    if (queue === undefined) {
      queue = { tasks: [] };
      queues.set(accountId, queue);
    }
    queue.tasks.push(async () => {
      try {
        await write();
      } catch (error) {
        // the trade ids too: the dead letter keeps only the hour's first event's
        logger.error(
          {
            accountId,
            source,
            ...(ref.brokerTradeIds.length === 0 ? {} : { brokerTradeIds: ref.brokerTradeIds }),
            ...errorLogFields(error),
          },
          'broker session write failed',
        );
        // inside the task: the account's queue and stop()'s wait both include it
        await deadLetterSessionWrite(
          deps.deadLetters,
          logger,
          { source, accountId, ...ref },
          DEAD_LETTER_WRITE_TIMEOUT_MS,
        );
      }
    });
    pump(accountId, queue);
  }

  function noteBalanceWrite(
    entry: RunningEntry,
    source: WriteSource,
    result: BalanceSnapshotWrite | BalanceEventWrite,
  ) {
    if (result.written || !firstOnConnection(entry, `write:${source}`)) return;
    const accountId = entry.candidate.id;
    if ('reason' in result && result.reason === 'no_snapshot') {
      logger.warn({ accountId, source, reason: result.reason }, 'balance snapshot not written');
      return;
    }
    logger.warn(
      { accountId, source, reason: 'out_of_domain', field: result.field },
      'balance snapshot not written',
    );
  }

  function noteClosedTrades(accountId: string, outcomes: readonly ClosedTradeOutcome[]) {
    for (const outcome of outcomes) {
      if (outcome.result === 'settled') {
        logger.info(
          { accountId, intentId: outcome.intentId, brokerTradeId: outcome.brokerTradeId },
          'intent settled from close_trade.success',
        );
      } else {
        logger.debug(
          { accountId, brokerTradeId: outcome.brokerTradeId, result: outcome.result },
          'closed trade not applied',
        );
      }
    }
  }

  // Synchronous on purpose: a user.data with another id stops the client inside this handler,
  // so no later event of that connection reaches a writer.
  function onEvent(entry: RunningEntry, event: BrokerEvent) {
    const accountId = entry.candidate.id;
    if (!isCurrent(accountId, entry)) return;
    switch (event.type) {
      case BrokerEventType.UserData: {
        const { user } = event;
        if (user.id !== entry.candidate.brokerUserId) {
          logger.error(
            { accountId, expected: entry.candidate.brokerUserId, received: user.id },
            'broker session user mismatch',
          );
          drop(accountId, config.refusalRetryMs);
          return;
        }
        entry.verified = true;
        enqueue(accountId, 'user_data', { mode: null, brokerTradeIds: [] }, async () => {
          const result = await writers.snapshot(accountId, user, [TradeMode.Demo, TradeMode.Real]);
          noteBalanceWrite(entry, 'user_data', result);
        });
        return;
      }
      case BrokerEventType.BalanceUpdate: {
        if (!verifiedFor(entry, event.type)) return;
        const { mode, balance } = event;
        enqueue(accountId, 'update_balance', { mode, brokerTradeIds: [] }, async () => {
          const result = await writers.balanceEvent(accountId, mode, balance);
          noteBalanceWrite(entry, 'update_balance', result);
        });
        return;
      }
      case BrokerEventType.CloseTradeSuccess: {
        if (!verifiedFor(entry, event.type)) return;
        const { mode, trades } = event;
        const ref = { mode, brokerTradeIds: trades.map((trade) => trade.id) };
        enqueue(accountId, 'close_trade_success', ref, async () => {
          noteClosedTrades(accountId, await writers.closedTrades(accountId, trades));
        });
        return;
      }
      default:
        return;
    }
  }

  // events without a user id are the account's only after its user.data on this connection
  function verifiedFor(entry: RunningEntry, type: BrokerEventType): boolean {
    if (entry.verified) return true;
    if (firstOnConnection(entry, 'before_user_data')) {
      logger.warn({ accountId: entry.candidate.id, type }, 'broker session event before user.data');
    }
    return false;
  }

  function onState(entry: RunningEntry, change: BrokerSocketStateChange) {
    const accountId = entry.candidate.id;
    if (!isCurrent(accountId, entry)) return;
    switch (change.to) {
      // a new connection proves its identity again; a stopped client has no connection to use
      // (an external stop() is not supported: the entry stays without a session until it goes
      // idle among the candidates)
      case BrokerSocketState.Connecting:
      case BrokerSocketState.Reconnecting:
      case BrokerSocketState.Authenticating:
      case BrokerSocketState.Idle:
        entry.verified = false;
        entry.warned.clear();
        return;
      // the client closed its socket: no session while the token is fetched again
      case BrokerSocketState.TokenExpired:
      case BrokerSocketState.AuthFailed:
        entry.verified = false;
        entry.warned.clear();
        if (!entry.refreshing) void refresh(entry, change.to);
        return;
      case BrokerSocketState.DisconnectedByServer:
        logger.info({ accountId, reason: change.to }, 'broker session closed');
        drop(accountId, config.retryMs);
        return;
      case BrokerSocketState.Ready:
        return;
    }
  }

  async function refresh(entry: RunningEntry, state: BrokerSocketState) {
    const accountId = entry.candidate.id;
    entry.refreshing = true;
    let outcome: AccessTokenOutcome;
    try {
      // the broker refused this token: the backend marks it expired and answers refresh_needed,
      // or hands out the pair someone already rotated (#281)
      outcome = await fetchToken(accountId, hashToken(entry.token));
    } catch (error) {
      if (stopping.signal.aborted || !isCurrent(accountId, entry)) return;
      startFailed(accountId, error);
      return;
    }
    if (stopping.signal.aborted || !isCurrent(accountId, entry)) return;
    entry.refreshing = false;
    if (!outcome.ok) {
      drop(accountId, holdBackFor(accountId, outcome));
      return;
    }
    // the same token means the backend did not mark the refusal (#281); restarting with it at
    // once would loop user.auth against the broker's per-IP limit
    if (outcome.accessToken === entry.token) {
      logger.warn({ accountId, sessionState: state }, 'broker session token unchanged');
      drop(accountId, config.retryMs);
      return;
    }
    entry.token = outcome.accessToken;
    entry.verified = false;
    startClient(entry, outcome.accessToken);
  }

  // a throw out of a token source or a client's start() is a bug by contract
  function startFailed(accountId: string, error: unknown) {
    logger.error({ accountId, ...errorLogFields(error) }, 'broker session start failed');
    drop(accountId, config.retryMs);
  }

  function startClient(entry: RunningEntry, accessToken: string) {
    try {
      entry.client.start({ brokerUserId: entry.candidate.brokerUserId, accessToken });
    } catch (error) {
      startFailed(entry.candidate.id, error);
    }
  }

  async function startOne(candidate: SessionCandidate) {
    const accountId = candidate.id;
    const starting: StartingEntry = { kind: 'starting', candidate };
    entries.set(accountId, starting);
    // the lease before the token: an account another process holds costs no token fetch
    const sentAt = now();
    let acquired: boolean;
    try {
      acquired = await leases.acquire(accountId, config.leaseTtlMs);
    } catch (error) {
      if (stopping.signal.aborted || !isCurrent(accountId, starting)) return;
      startFailed(accountId, error);
      return;
    }
    if (stopping.signal.aborted || !isCurrent(accountId, starting)) return;
    if (!acquired) {
      logger.debug({ accountId }, 'broker session lease busy');
      drop(accountId, config.retryMs);
      return;
    }
    starting.leaseUntil = sentAt + config.leaseFenceMs;
    armFence();
    let outcome: AccessTokenOutcome;
    try {
      outcome = await fetchToken(accountId);
    } catch (error) {
      if (stopping.signal.aborted || !isCurrent(accountId, starting)) return;
      startFailed(accountId, error);
      return;
    }
    if (stopping.signal.aborted || !isCurrent(accountId, starting)) return;
    if (!outcome.ok) {
      drop(accountId, holdBackFor(accountId, outcome));
      return;
    }
    const entry: RunningEntry = {
      kind: 'running',
      candidate,
      leaseUntil: starting.leaseUntil,
      client: openClient({
        url: deps.url,
        logger: logger.child({ accountId }),
        timing: deps.timing,
      }),
      token: outcome.accessToken,
      verified: false,
      refreshing: false,
      warned: new Set(),
    };
    entries.set(accountId, entry);
    entry.client.onEvent((event) => onEvent(entry, event));
    entry.client.onState((change) => onState(entry, change));
    startClient(entry, outcome.accessToken);
  }

  async function worker() {
    workers += 1;
    try {
      for (let next = startQueue.shift(); next !== undefined; next = startQueue.shift()) {
        if (stopping.signal.aborted) return;
        if (entries.has(next.id) || heldBack.has(next.id)) continue;
        await startOne(next);
      }
    } finally {
      workers -= 1;
    }
  }

  function startWorkers() {
    while (!stopping.signal.aborted && workers < config.startConcurrency && startQueue.length > 0)
      void worker();
  }

  async function runTick() {
    const now = Date.now();
    for (const [accountId, until] of heldBack) {
      if (until <= now) heldBack.delete(accountId);
    }
    let candidates: SessionCandidate[];
    try {
      candidates = await deps.candidates({
        watchWindowMs: config.watchWindowMs,
        exclude: [...heldBack.keys()],
      });
    } catch (error) {
      logger.error(errorLogFields(error), 'broker session tick failed');
      return;
    }
    if (stopping.signal.aborted) return;

    const present = new Set(candidates.map((candidate) => candidate.id));
    const at = Date.now();
    let closed = 0;
    for (const [accountId, entry] of entries) {
      if (present.has(accountId)) {
        if (entry.kind === 'running') entry.idleSince = undefined;
        continue;
      }
      if (entry.kind === 'starting') {
        // its fetch finds the entry gone and starts nothing
        entries.delete(accountId);
        closed += 1;
        continue;
      }
      entry.idleSince ??= at;
      if (at - entry.idleSince >= config.idleGraceMs) {
        logger.info({ accountId, reason: 'idle' }, 'broker session closed');
        drop(accountId);
        closed += 1;
      }
    }

    if (candidates.length > config.maxSessions) {
      logger.warn(
        { candidates: candidates.length, cap: config.maxSessions },
        'broker sessions capped',
      );
    }
    // the cap counts the starting entries too; a later tick recomputes the queue with them
    const slots = Math.max(0, config.maxSessions - entries.size);
    startQueue = candidates.filter((candidate) => !entries.has(candidate.id)).slice(0, slots);
    startWorkers();

    let starting = 0;
    for (const entry of entries.values()) if (entry.kind === 'starting') starting += 1;
    logger.debug(
      {
        candidates: candidates.length,
        sessions: entries.size - starting,
        starting,
        queued: startQueue.length,
        closed,
        heldBack: heldBack.size,
      },
      'broker session tick',
    );
  }

  function tick(): Promise<void> {
    if (stopping.signal.aborted) return Promise.resolve();
    ticking ??= runTick()
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'broker session tick failed');
      })
      .finally(() => {
        ticking = undefined;
      });
    return ticking;
  }

  async function stop() {
    if (stopping.signal.aborted) return;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (renewTimer !== undefined) clearInterval(renewTimer);
    renewTimer = undefined;
    if (fenceTimer !== undefined) clearTimeout(fenceTimer);
    fenceTimer = undefined;
    stopping.abort();
    startQueue = [];
    for (const entry of entries.values()) {
      if (entry.kind === 'running') entry.client.stop();
    }
    entries.clear();
    // after every socket closed: a successor that takes an account after the delete never
    // overlaps ours. A release that fails or overruns only leaves the leases to lapse
    const released = leases.release().then(
      () => undefined,
      (error: unknown) => {
        logger.error(errorLogFields(error), 'broker session lease release failed');
      },
    );

    let dropped = 0;
    const inFlight: Promise<void>[] = [];
    for (const queue of queues.values()) {
      dropped += queue.tasks.length;
      queue.tasks.length = 0;
      if (queue.running !== undefined) inFlight.push(queue.running);
    }
    if (dropped > 0) logger.warn({ dropped }, 'broker session writes dropped at stop');
    if (ticking !== undefined) inFlight.push(ticking);
    inFlight.push(released);

    let pending = inFlight.length;
    const settled = Promise.all(
      inFlight.map((work) =>
        work.finally(() => {
          pending -= 1;
        }),
      ),
    );
    let budget: ReturnType<typeof setTimeout> | undefined;
    const overrun = new Promise<'overrun'>((resolve) => {
      budget = setTimeout(() => resolve('overrun'), config.stopBudgetMs);
    });
    const result = await Promise.race([settled, overrun]);
    clearTimeout(budget);
    if (result === 'overrun') logger.warn({ pending }, 'broker session stop budget exceeded');
  }

  function clientFor(accountId: string): BrokerSocketClient | undefined {
    const entry = entries.get(accountId);
    return entry?.kind === 'running' ? entry.client : undefined;
  }

  return {
    start() {
      if (stopping.signal.aborted || timer !== undefined) return;
      void tick();
      timer = setInterval(() => void tick(), config.tickMs);
      renewTimer = setInterval(() => void renewLeases(), config.leaseRenewMs);
    },
    tick,
    renewLeases,
    stop,
    // the executor gets the client only once this connection's user.data matched the account;
    // until then its command goes over REST (the executor's no-session case). Never past the
    // fence, even before its timer has run: a late timer must not let a command through (#93)
    sessionFor(accountId) {
      const entry = entries.get(accountId);
      return entry?.kind === 'running' && entry.verified && now() < entry.leaseUntil
        ? entry.client
        : undefined;
    },
    clientFor,
    get size() {
      return entries.size;
    },
  };
}
