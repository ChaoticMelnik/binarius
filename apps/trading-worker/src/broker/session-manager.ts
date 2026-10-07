import type {
  BalanceEventWrite,
  BalanceSnapshotWrite,
  ClosedTradeOutcome,
  SessionCandidate,
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
import type { SessionManagerConfig } from './session-config';
import {
  BrokerSocketState,
  createBrokerSocketClient,
  type BrokerSocketClient,
  type BrokerSocketClientOptions,
  type BrokerSocketStateChange,
} from './socket';
import type { BrokerSocketTiming } from './socket-config';
import type { TradeSessionSource } from './trade-session';

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

export interface BrokerSessionManagerDeps {
  url: string;
  // production: listSessionCandidates over the worker's database
  candidates: (options: {
    watchWindowMs: number;
    exclude: readonly string[];
  }) => Promise<SessionCandidate[]>;
  tokens: AccessTokenSource;
  writers: SessionWriters;
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
  // the timer, the start pool, every client, then the write in flight per account within
  // stopBudgetMs; the writes queued behind it are dropped
  stop(): Promise<void>;
  // the running client of the account: tests and the probe
  clientFor(accountId: string): BrokerSocketClient | undefined;
  // running + starting
  readonly size: number;
}

type WriteSource = 'user_data' | 'update_balance' | 'close_trade_success';

interface StartingEntry {
  kind: 'starting';
  candidate: SessionCandidate;
}

interface RunningEntry {
  kind: 'running';
  candidate: SessionCandidate;
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
  const { config, logger, tokens, writers } = deps;
  const openClient = deps.openClient ?? createBrokerSocketClient;
  const entries = new Map<string, Entry>();
  const heldBack = new Map<string, number>();
  const queues = new Map<string, WriteQueue>();
  const stopping = new AbortController();
  let startQueue: SessionCandidate[] = [];
  let workers = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;

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
      // not_configured: index.ts builds the manager only with the backend source
      case AccessTokenUnavailable.BackendStatus:
      case AccessTokenUnavailable.ContractViolation:
      case AccessTokenUnavailable.NotConfigured:
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

  function fetchToken(accountId: string) {
    return tokens.accessToken(accountId, { mayRefresh: false, signal: stopping.signal });
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

  function enqueue(accountId: string, source: WriteSource, write: () => Promise<void>) {
    let queue = queues.get(accountId);
    if (queue === undefined) {
      queue = { tasks: [] };
      queues.set(accountId, queue);
    }
    queue.tasks.push(async () => {
      try {
        await write();
      } catch (error) {
        logger.error(
          { accountId, source, ...errorLogFields(error) },
          'broker session write failed',
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
        enqueue(accountId, 'user_data', async () => {
          const result = await writers.snapshot(accountId, user, [TradeMode.Demo, TradeMode.Real]);
          noteBalanceWrite(entry, 'user_data', result);
        });
        return;
      }
      case BrokerEventType.BalanceUpdate: {
        if (!verifiedFor(entry, event.type)) return;
        const { mode, balance } = event;
        enqueue(accountId, 'update_balance', async () => {
          const result = await writers.balanceEvent(accountId, mode, balance);
          noteBalanceWrite(entry, 'update_balance', result);
        });
        return;
      }
      case BrokerEventType.CloseTradeSuccess: {
        if (!verifiedFor(entry, event.type)) return;
        const { trades } = event;
        enqueue(accountId, 'close_trade_success', async () => {
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
      case BrokerSocketState.Connecting:
      case BrokerSocketState.Reconnecting:
      case BrokerSocketState.Authenticating:
        // a new connection proves its identity again
        entry.verified = false;
        entry.warned.clear();
        return;
      case BrokerSocketState.TokenExpired:
      case BrokerSocketState.AuthFailed:
        if (!entry.refreshing) void refresh(entry, change.to);
        return;
      case BrokerSocketState.DisconnectedByServer:
        logger.info({ accountId, reason: change.to }, 'broker session closed');
        drop(accountId, config.retryMs);
        return;
      case BrokerSocketState.Ready:
      case BrokerSocketState.Idle:
        return;
    }
  }

  async function refresh(entry: RunningEntry, state: BrokerSocketState) {
    const accountId = entry.candidate.id;
    entry.refreshing = true;
    let outcome: AccessTokenOutcome;
    try {
      outcome = await fetchToken(accountId);
    } catch (error) {
      if (stopped || !isCurrent(accountId, entry)) return;
      logger.error({ accountId, ...errorLogFields(error) }, 'broker session start failed');
      drop(accountId, config.retryMs);
      return;
    }
    if (stopped || !isCurrent(accountId, entry)) return;
    entry.refreshing = false;
    if (!outcome.ok) {
      drop(accountId, holdBackFor(accountId, outcome));
      return;
    }
    if (outcome.accessToken === entry.token) {
      logger.warn({ accountId, sessionState: state }, 'broker session token unchanged');
      drop(accountId, config.retryMs);
      return;
    }
    entry.token = outcome.accessToken;
    entry.verified = false;
    try {
      entry.client.start({
        brokerUserId: entry.candidate.brokerUserId,
        accessToken: outcome.accessToken,
      });
    } catch (error) {
      logger.error({ accountId, ...errorLogFields(error) }, 'broker session start failed');
      drop(accountId, config.retryMs);
    }
  }

  async function startOne(candidate: SessionCandidate) {
    const accountId = candidate.id;
    const starting: StartingEntry = { kind: 'starting', candidate };
    entries.set(accountId, starting);
    let outcome: AccessTokenOutcome;
    try {
      outcome = await fetchToken(accountId);
    } catch (error) {
      if (stopped || !isCurrent(accountId, starting)) return;
      logger.error({ accountId, ...errorLogFields(error) }, 'broker session start failed');
      drop(accountId, config.retryMs);
      return;
    }
    if (stopped || !isCurrent(accountId, starting)) return;
    if (!outcome.ok) {
      drop(accountId, holdBackFor(accountId, outcome));
      return;
    }
    const entry: RunningEntry = {
      kind: 'running',
      candidate,
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
    try {
      entry.client.start({
        brokerUserId: candidate.brokerUserId,
        accessToken: outcome.accessToken,
      });
    } catch (error) {
      logger.error({ accountId, ...errorLogFields(error) }, 'broker session start failed');
      drop(accountId, config.retryMs);
    }
  }

  async function worker() {
    workers += 1;
    try {
      for (let next = startQueue.shift(); next !== undefined; next = startQueue.shift()) {
        if (stopped) return;
        if (entries.has(next.id) || heldBack.has(next.id)) continue;
        await startOne(next);
      }
    } finally {
      workers -= 1;
    }
  }

  function startWorkers() {
    while (!stopped && workers < config.startConcurrency && startQueue.length > 0) void worker();
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
    if (stopped) return;

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
    if (stopped) return Promise.resolve();
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
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    stopping.abort();
    startQueue = [];
    for (const entry of entries.values()) {
      if (entry.kind === 'running') entry.client.stop();
    }
    entries.clear();

    let dropped = 0;
    const inFlight: Promise<void>[] = [];
    for (const queue of queues.values()) {
      dropped += queue.tasks.length;
      queue.tasks.length = 0;
      if (queue.running !== undefined) inFlight.push(queue.running);
    }
    if (dropped > 0) logger.warn({ dropped }, 'broker session writes dropped at stop');
    if (ticking !== undefined) inFlight.push(ticking);
    if (inFlight.length === 0) return;

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

  return {
    start() {
      if (stopped || timer !== undefined) return;
      void tick();
      timer = setInterval(() => void tick(), config.tickMs);
    },
    tick,
    stop,
    sessionFor: (accountId) => clientFor(accountId),
    clientFor,
    get size() {
      return entries.size;
    },
  };

  function clientFor(accountId: string): BrokerSocketClient | undefined {
    const entry = entries.get(accountId);
    return entry?.kind === 'running' ? entry.client : undefined;
  }
}
