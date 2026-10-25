import {
  hashToken,
  type BalanceEventWrite,
  type BalanceSnapshotWrite,
  type ClosedTradeOutcome,
  type SessionCandidate,
} from '@binarius/db';
import {
  AccessTokenRefusal,
  assertExhausted,
  errorLogFields,
  TradeMode,
  type BrokerBalance,
  type BrokerUser,
  type ClosedTrade,
} from '@binarius/shared';
import {
  BrokerEventType,
  BrokerSocketState,
  createBrokerSocketClient,
  type BrokerEvent,
  type BrokerSocketClient,
  type BrokerSocketClientOptions,
  type BrokerSocketStateChange,
  type BrokerSocketTiming,
} from '@binarius/broker-socket';
import type pino from 'pino';
import {
  AccessTokenUnavailable,
  type AccessTokenOutcome,
  type AccessTokenSource,
} from './access-token';
import { DEAD_LETTER_WRITE_TIMEOUT_MS, type SessionManagerConfig } from './session-config';
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

type SessionLogger = Pick<pino.Logger, 'debug' | 'info' | 'warn' | 'error' | 'child'>;

export interface SessionWriters {
  // eventAt: the modes for which this user.data is a balance event
  snapshot(
    accountId: string,
    user: BrokerUser,
    eventAt: readonly TradeMode[],
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
  // undefined: another owner's live lease; acquiredAt: the CAS token of releaseOne
  acquire(accountId: string, ttlMs: number): Promise<{ acquiredAt: string } | undefined>;
  // the ids still held; a missing id is a lease lost
  renew(accountIds: readonly string[], ttlMs: number): Promise<string[]>;
  release(): Promise<unknown>;
  // one account's lease, only while it is still the one this acquire took (#94: a shed)
  releaseOne(accountId: string, acquiredAt: string): Promise<unknown>;
}

// The socket signal of the circuit breaker (#96): every ready session on every check, and a session
// lost to the broker once per loss. Not our own drops (idle, the fence of #93, a refusal, stop())
// and not token_expired/auth_failed.
export interface SessionLossObserver {
  lost(accountId: string): void;
  ready(accountId: string): void;
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
  // whether this process owns the account (#94, fleet/registry.ts): the manager holds sockets of
  // owned accounts only and sheds one that moved to another process
  owns: (accountId: string) => boolean;
  // the fence's clock: monotonic, so a wall-clock jump neither extends nor cuts a lease
  monotonicNow?: () => number;
  lossObserver?: SessionLossObserver;
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
  // the loss observer's check (#96): every tickMs once started, on its own timer, so a scan stuck
  // on the database does not hide the broker's losses
  observeSessions(): void;
  // the timer, the start pool, every client, then the write in flight per account within
  // stopBudgetMs; the writes queued behind it are dropped
  stop(): Promise<void>;
  // the running client of the account, verified or not: tests
  clientFor(accountId: string): BrokerSocketClient | undefined;
  // running + starting
  readonly size: number;
  // the capacity line (#94): owned and cappedOut as of the last scan, shed since start
  stats(): SessionStats;
}

export interface SessionStats {
  running: number;
  starting: number;
  owned: number;
  cappedOut: number;
  shed: number;
}

type WriteSource = SessionDeadLetter['source'];
type WriteRef = Pick<SessionDeadLetter, 'mode' | 'brokerTradeIds'>;

// One acquire's lease, shared by the starting entry and the running one that replaces it, so a
// renewal answered across that handoff still moves the fence. `until` is the fence: monotonic
// time until which the lease is ours.
interface Lease {
  until: number;
  acquiredAt: string;
}

interface StartingEntry {
  kind: 'starting';
  candidate: SessionCandidate;
  // unset until the acquire answered
  lease?: Lease;
}

interface RunningEntry {
  kind: 'running';
  candidate: SessionCandidate;
  lease: Lease;
  client: BrokerSocketClient;
  token: string;
  // this connection's user.data carried the account's broker user id
  verified: boolean;
  // a token fetch after token_expired/auth_failed is in flight
  refreshing: boolean;
  idleSince?: number;
  // warn-once keys of the current connection
  warned: Set<string>;
  // #96: ready at least once; when it left ready (monotonic); this loss already reported; the
  // next connection after a token refresh counts as leaving ready
  everReady: boolean;
  lostSince?: number;
  lossReported: boolean;
  rearmed: boolean;
  // #94: the account moved to another process (monotonic); no command from now on, the socket
  // closes shedGraceMs later unless the account is owned again
  sheddingSince?: number;
}

type Entry = StartingEntry | RunningEntry;

// one per account: the writes of a session land in the order its events came, and a new
// session of the same account queues behind what an earlier one left
interface WriteQueue {
  tasks: (() => Promise<void>)[];
  running?: Promise<void>;
}

// one bounded wait; the late answer of a work that overran is ignored
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([work, timedOut]).finally(() => clearTimeout(timer));
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
  let observeTimer: ReturnType<typeof setInterval> | undefined;
  let lastOwned = 0;
  let lastCappedOut = 0;
  let shedTotal = 0;

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

  // A release that commits late finds acquired_at moved by our own re-acquire and deletes nothing;
  // one that fails or overruns leaves the row to lapse
  function releaseOne(accountId: string, lease: Lease) {
    void withTimeout(
      leases.releaseOne(accountId, lease.acquiredAt),
      config.leaseRenewTimeoutMs,
    ).then(
      (result) => {
        if (result === 'timeout') {
          logger.warn({ accountId, timedOut: true }, 'broker session lease release failed');
        }
      },
      (error: unknown) => {
        logger.error(
          { accountId, ...errorLogFields(error) },
          'broker session lease release failed',
        );
      },
    );
  }

  // the entry goes first, as in drop(): the client's own state change finds it gone
  function shed(accountId: string, entry: RunningEntry) {
    entries.delete(accountId);
    entry.client.stop();
    shedTotal += 1;
    logger.info({ accountId, graceMs: config.shedGraceMs }, 'broker session shed');
    releaseOne(accountId, entry.lease);
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
      if (entry.lease !== undefined) earliest = Math.min(earliest, entry.lease.until);
    }
    if (earliest === Infinity) return;
    fenceTimer = setTimeout(fence, Math.max(0, earliest - now()));
  }

  // true when the lease has passed its fence: the entry is dropped as the fence timer would
  function fencedNow(accountId: string, lease: Lease | undefined, at = now()): boolean {
    if (lease === undefined || lease.until > at) return false;
    logger.warn({ accountId, lateMs: Math.round(at - lease.until) }, 'broker session lease fenced');
    drop(accountId, config.retryMs);
    return true;
  }

  function fence() {
    fenceTimer = undefined;
    const at = now();
    for (const [accountId, entry] of [...entries]) fencedNow(accountId, entry.lease, at);
    armFence();
  }

  // Only the leases whose acquire has answered: an acquire still in flight may not have
  // committed, and a renewal that misses its id would drop a lease about to be ours. The answer
  // applies to an account that still holds the same lease, whichever entry carries it now.
  async function runRenewal() {
    const sent: [string, Lease][] = [];
    const ids: string[] = [];
    for (const [accountId, entry] of entries) {
      if (entry.lease === undefined) continue;
      sent.push([accountId, entry.lease]);
      ids.push(accountId);
    }
    if (sent.length === 0) return;
    const t0 = now();
    let held: string[] | 'timeout';
    try {
      held = await withTimeout(leases.renew(ids, config.leaseTtlMs), config.leaseRenewTimeoutMs);
    } catch (error) {
      // the fence decides: one failed renewal leaves every lease trusted (2 × renew < fence)
      logger.error(errorLogFields(error), 'broker session lease renewal failed');
      return;
    }
    // a statement stuck on the pool must not hold the next renewal back: it counts as one
    // failure, and its late answer is ignored
    if (held === 'timeout') {
      logger.warn({ leases: sent.length }, 'broker session lease renewal timed out');
      return;
    }
    if (stopping.signal.aborted) return;
    const kept = new Set(held);
    for (const [accountId, lease] of sent) {
      if (entries.get(accountId)?.lease !== lease) continue;
      if (kept.has(accountId)) {
        lease.until = Math.max(lease.until, t0 + config.leaseFenceMs);
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
        // the bookkeeping after an answer threw, not the database
        logger.error(errorLogFields(error), 'broker session lease renewal threw');
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
      // not_configured: worker.ts builds the manager only with the backend source;
      // refresh_rate_limited is unreachable with mayRefresh: false, temporary if it ever comes
      // (#275); not_service is unreachable: the worker's body has no serviceOnly (#391)
      case AccessTokenUnavailable.BackendStatus:
      case AccessTokenUnavailable.ContractViolation:
      case AccessTokenUnavailable.NotConfigured:
      case AccessTokenRefusal.RefreshRateLimited:
      case AccessTokenRefusal.NotService:
        logger.warn({ accountId, reason, status }, 'broker session token unavailable');
        return config.retryMs;
      case AccessTokenRefusal.AccountNotFound:
      case AccessTokenRefusal.AccountPending:
      case AccessTokenRefusal.AccountRevoked:
      case AccessTokenRefusal.UserBlocked:
      case AccessTokenRefusal.KeyUnavailable:
        logger.warn({ accountId, refusal: reason }, 'broker session token refused');
        return config.refusalRetryMs;
      default:
        return assertExhausted(reason, 'access token answer');
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
        // a ready session that left ready, or the first connection after its token refresh: a loss
        // once it outlasts the grace (observeSessions decides)
        if (change.from === BrokerSocketState.Ready || entry.rearmed) {
          entry.lostSince ??= now();
          entry.rearmed = false;
        }
        return;
      // the client closed its socket: no session while the token is fetched again. Credentials,
      // not the connection: no loss
      case BrokerSocketState.TokenExpired:
      case BrokerSocketState.AuthFailed:
        entry.verified = false;
        entry.warned.clear();
        entry.lostSince = undefined;
        entry.rearmed = entry.everReady;
        if (!entry.refreshing) void refresh(entry, change.to);
        return;
      case BrokerSocketState.DisconnectedByServer:
        logger.info({ accountId, reason: change.to }, 'broker session closed');
        if (entry.everReady && !entry.lossReported) deps.lossObserver?.lost(accountId);
        drop(accountId, config.retryMs);
        return;
      case BrokerSocketState.Ready:
        entry.everReady = true;
        entry.lostSince = undefined;
        entry.lossReported = false;
        entry.rearmed = false;
        return;
    }
  }

  // The token for a start or a restart; undefined when the caller has nothing left to do: the
  // manager is stopping, the entry was replaced, the source threw (logged, dropped) or refused
  // (held back).
  async function tokenFor(
    accountId: string,
    entry: Entry,
    refusedToken?: string,
  ): Promise<string | undefined> {
    let outcome: AccessTokenOutcome;
    try {
      outcome = await fetchToken(accountId, refusedToken);
    } catch (error) {
      if (stopping.signal.aborted || !isCurrent(accountId, entry)) return undefined;
      startFailed(accountId, error);
      return undefined;
    }
    if (stopping.signal.aborted || !isCurrent(accountId, entry)) return undefined;
    if (!outcome.ok) {
      drop(accountId, holdBackFor(accountId, outcome));
      return undefined;
    }
    return outcome.accessToken;
  }

  async function refresh(entry: RunningEntry, state: BrokerSocketState) {
    const accountId = entry.candidate.id;
    entry.refreshing = true;
    // the broker refused this token: the backend marks it expired and answers refresh_needed,
    // or hands out the pair someone already rotated (#281)
    const token = await tokenFor(accountId, entry, hashToken(entry.token));
    if (token === undefined) return;
    entry.refreshing = false;
    // the same token means the backend did not mark the refusal (#281); restarting with it at
    // once would loop user.auth against the broker's per-IP limit
    if (token === entry.token) {
      logger.warn({ accountId, sessionState: state }, 'broker session token unchanged');
      drop(accountId, config.retryMs);
      return;
    }
    if (fencedNow(accountId, entry.lease)) return;
    entry.token = token;
    entry.verified = false;
    startClient(entry, token);
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
    let acquired: { acquiredAt: string } | undefined | 'timeout';
    try {
      // bounded like a renewal: the one-failed-renewal guarantee counts on it
      acquired = await withTimeout(
        leases.acquire(accountId, config.leaseTtlMs),
        config.leaseRenewTimeoutMs,
      );
    } catch (error) {
      if (stopping.signal.aborted || !isCurrent(accountId, starting)) return;
      startFailed(accountId, error);
      return;
    }
    if (stopping.signal.aborted || !isCurrent(accountId, starting)) return;
    // a late commit leaves our row, which lapses or which we take again
    if (acquired === 'timeout') {
      logger.warn({ accountId }, 'broker session lease acquire timed out');
      drop(accountId, config.retryMs);
      return;
    }
    if (acquired === undefined) {
      logger.debug({ accountId }, 'broker session lease busy');
      drop(accountId, config.retryMs);
      return;
    }
    starting.lease = { until: sentAt + config.leaseFenceMs, acquiredAt: acquired.acquiredAt };
    armFence();
    const token = await tokenFor(accountId, starting);
    if (token === undefined) return;
    // a stall can deliver the token before the overdue fence timer: no socket past the fence
    if (fencedNow(accountId, starting.lease)) return;
    const entry: RunningEntry = {
      kind: 'running',
      candidate,
      lease: starting.lease,
      client: openClient({
        url: deps.url,
        logger: logger.child({ accountId }),
        timing: deps.timing,
      }),
      token,
      verified: false,
      refreshing: false,
      warned: new Set(),
      everReady: false,
      lossReported: false,
      rearmed: false,
    };
    entries.set(accountId, entry);
    entry.client.onEvent((event) => onEvent(entry, event));
    entry.client.onState((change) => onState(entry, change));
    startClient(entry, token);
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

  // every ready session is reported ready, so the breaker's window holds every session in work with
  // its latest state; a session still not ready config.lossGraceMs after it left ready is one loss
  // (monotonic, like the fence: a wall-clock jump neither hides nor invents a loss)
  function observeSessions() {
    const observer = deps.lossObserver;
    if (observer === undefined || stopping.signal.aborted) return;
    const at = now();
    for (const [accountId, entry] of entries) {
      if (entry.kind !== 'running') continue;
      if (entry.client.state === BrokerSocketState.Ready) {
        observer.ready(accountId);
        continue;
      }
      if (entry.lostSince === undefined || entry.lossReported) continue;
      if (at - entry.lostSince < config.lossGraceMs) continue;
      entry.lossReported = true;
      observer.lost(accountId);
    }
  }

  async function runTick() {
    const wallNow = Date.now();
    for (const [accountId, until] of heldBack) {
      if (until <= wallNow) heldBack.delete(accountId);
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
    const owned = candidates.filter((candidate) => deps.owns(candidate.id));
    const mine = new Set(owned.map((candidate) => candidate.id));
    const at = Date.now();
    const monotonicAt = now();
    let closed = 0;
    for (const [accountId, entry] of entries) {
      if (mine.has(accountId)) {
        if (entry.kind === 'running') {
          entry.idleSince = undefined;
          entry.sheddingSince = undefined;
        }
        continue;
      }
      if (present.has(accountId)) {
        // in work, owned by another process (#94)
        if (entry.kind === 'starting') {
          // its acquire or fetch finds the entry gone; a lease it already holds goes back now
          entries.delete(accountId);
          if (entry.lease !== undefined) releaseOne(accountId, entry.lease);
          closed += 1;
          continue;
        }
        entry.idleSince = undefined;
        entry.sheddingSince ??= monotonicAt;
        if (monotonicAt - entry.sheddingSince >= config.shedGraceMs) {
          shed(accountId, entry);
          closed += 1;
        }
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

    lastOwned = owned.length;
    lastCappedOut = Math.max(0, owned.length - config.maxSessions);
    if (owned.length > config.maxSessions) {
      logger.warn({ candidates: owned.length, cap: config.maxSessions }, 'broker sessions capped');
    }
    // the cap counts the starting and the shedding entries too; a later tick recomputes the queue
    const slots = Math.max(0, config.maxSessions - entries.size);
    startQueue = owned.filter((candidate) => !entries.has(candidate.id)).slice(0, slots);
    startWorkers();

    let starting = 0;
    for (const entry of entries.values()) if (entry.kind === 'starting') starting += 1;
    logger.debug(
      {
        candidates: candidates.length,
        owned: owned.length,
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
    if (observeTimer !== undefined) clearInterval(observeTimer);
    observeTimer = undefined;
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
    const result = await withTimeout(settled, config.stopBudgetMs);
    if (result === 'timeout') logger.warn({ pending }, 'broker session stop budget exceeded');
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
      if (deps.lossObserver !== undefined) {
        observeTimer = setInterval(observeSessions, config.tickMs);
      }
    },
    tick,
    renewLeases,
    observeSessions,
    stop,
    // the executor gets the client only once this connection's user.data matched the account;
    // until then its command goes over REST (the executor's no-session case). Never past the
    // fence, even before its timer has run: a late timer must not let a command through (#93)
    sessionFor(accountId) {
      const entry = entries.get(accountId);
      return entry?.kind === 'running' &&
        entry.verified &&
        entry.sheddingSince === undefined &&
        now() < entry.lease.until
        ? entry.client
        : undefined;
    },
    clientFor,
    get size() {
      return entries.size;
    },
    stats() {
      let starting = 0;
      for (const entry of entries.values()) if (entry.kind === 'starting') starting += 1;
      return {
        running: entries.size - starting,
        starting,
        owned: lastOwned,
        cappedOut: lastCappedOut,
        shed: shedTotal,
      };
    },
  };
}
