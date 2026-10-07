import { MAX_DETAIL_LENGTH } from '@binarius/broker-rest';
import {
  BrokerSocketEvent,
  normalizeDecimal,
  errorLogFields,
  modeEvent,
  priceSubscribeWireSchema,
  socketOpenTradeRequestWireSchema,
  toSocketOpenTradeRequestWire,
  userAuthWireSchema,
  type BrokerClientToServerEvents,
  type BrokerServerToClientEvents,
  type OpenTrade,
  type OpenTradeFailure,
  type SocketOpenTradeRequest,
  type TradeMode,
  type UserAuthWire,
} from '@binarius/shared';
import type pino from 'pino';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import {
  BrokerEventProblemKind,
  BrokerEventType,
  normalizeBrokerEvent,
  type BrokerEvent,
} from './events';
import { resolveBrokerSocketTiming, type BrokerSocketTiming } from './socket-config';
import { chunkAssets, createAssetSubscriptionRegistry } from './subscriptions';

export type BrokerSocket = Socket<BrokerServerToClientEvents, BrokerClientToServerEvents>;
export type BrokerSocketOptions = Partial<ManagerOptions & SocketOptions>;

export const BrokerSocketState = {
  Idle: 'idle',
  Connecting: 'connecting',
  Authenticating: 'authenticating',
  Ready: 'ready',
  Reconnecting: 'reconnecting',
  AuthFailed: 'auth_failed',
  TokenExpired: 'token_expired',
  DisconnectedByServer: 'disconnected_by_server',
} as const;
export type BrokerSocketState = (typeof BrokerSocketState)[keyof typeof BrokerSocketState];

// terminal for the credentials of the current start(): the socket is closed and nothing reopens
// it until the owner calls start() again
const TERMINAL_STATES: ReadonlySet<BrokerSocketState> = new Set([
  BrokerSocketState.AuthFailed,
  BrokerSocketState.TokenExpired,
  BrokerSocketState.DisconnectedByServer,
]);

export const isTerminalBrokerSocketState = (state: BrokerSocketState): boolean =>
  TERMINAL_STATES.has(state);

// Sent by the live broker (2026-10-03) and of no use to the worker. The same names as the mock's
// OBSERVED_EXTRA_EVENTS, which a test-only package cannot supply at runtime; socket.test.ts holds
// the two lists equal.
export const IGNORED_BROKER_EVENTS: ReadonlySet<string> = new Set([
  'price.subscribed',
  'user.real.close_trade.recent',
  'user.demo.close_trade.recent',
  'user.real.futures.positions',
  'user.real.futures.closed.recent',
  'user.demo.futures.positions',
  'user.demo.futures.closed.recent',
]);

// socket.io's reasons: the server sent DISCONNECT, or our own disconnect()
const SERVER_DISCONNECT = 'io server disconnect';
const CLIENT_DISCONNECT = 'io client disconnect';
// the client's reason for a connection the server refused with a CONNECT_ERROR packet
const CONNECT_ERROR = 'connect_error';

export interface BrokerCredentials {
  brokerUserId: string;
  accessToken: string;
}

export interface BrokerSocketStateChange {
  from: BrokerSocketState;
  to: BrokerSocketState;
  // socket.io's disconnect reason, or the client's own (`auth_timeout`, `auth_error`, …)
  reason?: string;
}

export type SocketOpenTradeResult =
  | { outcome: 'success'; trade: OpenTrade }
  | { outcome: 'fail'; failures: OpenTradeFailure[] }
  // nothing was emitted: the client is not ready, or the caller's signal was already aborted
  | { outcome: 'not_sent'; reason: 'not_ready' | 'aborted'; state: BrokerSocketState }
  // emitted, and no answer: the session changed state, or the caller aborted while waiting
  | { outcome: 'unknown'; reason: 'state_changed' | 'aborted'; state: BrokerSocketState };

export type BrokerSocketLogger = Pick<pino.Logger, 'debug' | 'info' | 'warn' | 'error'>;

export interface BrokerSocketClientOptions {
  url: string;
  logger: BrokerSocketLogger;
  // tests shorten the waits; the override is held to the chain in socket-config.ts
  timing?: Partial<BrokerSocketTiming>;
  // default io(); a seam for tests. The returned socket is a socket.io-client Socket or a wrapper
  // that keeps its timing: connect() and emit() return before any event is delivered, disconnect()
  // raises `disconnect` synchronously. A wrapper that re-enters the client from inside these
  // calls is refused (start()) or ended (stop()) without an orphan socket; nothing more is promised
  openSocket?: (url: string, options: BrokerSocketOptions) => BrokerSocket;
}

export interface BrokerSocketClient {
  // opens a new socket for these credentials; throws unless idle or terminal
  start(credentials: BrokerCredentials): void;
  // closes the socket and forgets the credentials; synchronous, a no-op when idle
  stop(): void;
  // adds to the registry; the new ids go out now when ready, otherwise with the next auth
  subscribe(assetIds: readonly number[]): void;
  // the registry, ascending
  subscriptions(): number[];
  // emits user.<mode>.open_trade only while ready on an untainted connection; the answer is the
  // first open_trade.fail of that mode, or the first open_trade.success of that mode with the
  // command's asset, action and amount, on the same connection. A command aborted while waiting
  // taints its connection: the client drops it and takes no command until the next ready. At
  // most one command at a time: a second one throws.
  openTrade(
    mode: TradeMode,
    request: SocketOpenTradeRequest,
    signal: AbortSignal,
  ): Promise<SocketOpenTradeResult>;
  readonly state: BrokerSocketState;
  // successful auths since the last start()
  readonly connections: number;
  onEvent(listener: (event: BrokerEvent) => void): () => void;
  onState(listener: (change: BrokerSocketStateChange) => void): () => void;
}

interface Counters {
  events: number;
  ignored: number;
  extraArgs: number;
  authTimeouts: number;
  problems: Record<BrokerEventProblemKind, number>;
}

// one connection (one `connect` of the socket); counters and warn-once keys reset with it
interface Connection {
  ordinal: number;
  connectedAt: number;
  attempt: number;
  counters: Counters;
  warned: Set<string>;
  // a command ended here without its answer: a late answer may still come on this connection
  tainted: boolean;
}

interface Session {
  socket: BrokerSocket;
  auth: UserAuthWire;
  stopped: boolean;
  authTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempt: number;
  connectErrorWarned: boolean;
  connectionCount: number;
  connection?: Connection;
}

// the command in flight, tied to the connection it was emitted on
interface PendingCommand {
  session: Session;
  connection: number;
  mode: TradeMode;
  request: SocketOpenTradeRequest;
  settle: (result: SocketOpenTradeResult) => void;
}

type Delivery =
  | { kind: 'state'; change: BrokerSocketStateChange }
  | { kind: 'event'; session: Session; event: BrokerEvent };

const newCounters = (): Counters => ({
  events: 0,
  ignored: 0,
  extraArgs: 0,
  authTimeouts: 0,
  problems: {
    [BrokerEventProblemKind.UnknownEvent]: 0,
    [BrokerEventProblemKind.MissingPayload]: 0,
    [BrokerEventProblemKind.Decode]: 0,
    [BrokerEventProblemKind.Schema]: 0,
  },
});

// the first term of the command a success does not carry; undefined when it is the command's
function mismatchedField(
  trade: OpenTrade,
  request: SocketOpenTradeRequest,
): 'asset' | 'action' | 'amount' | undefined {
  if (trade.assetId !== request.assetId) return 'asset';
  if (trade.action !== request.action) return 'action';
  if (normalizeDecimal(trade.amount) !== normalizeDecimal(request.amount)) return 'amount';
  return undefined;
}

export function createBrokerSocketClient(options: BrokerSocketClientOptions): BrokerSocketClient {
  const timing = resolveBrokerSocketTiming(options.timing);
  const openSocket = options.openSocket ?? ((url, socketOptions) => io(url, socketOptions));
  const { logger } = options;
  const registry = createAssetSubscriptionRegistry();
  const eventListeners = new Set<(event: BrokerEvent) => void>();
  const stateListeners = new Set<(change: BrokerSocketStateChange) => void>();
  let state: BrokerSocketState = BrokerSocketState.Idle;
  let connections = 0;
  let session: Session | undefined;
  let starting = false;
  let pending: PendingCommand | undefined;

  // Run-to-completion: every entry point (a socket.io handler, the auth timer, start(), stop())
  // is one unit of work, and listeners hear of it only once the outermost unit has finished. A
  // listener's start()/stop() is a nested unit: its effect is immediate, its notifications queue
  // behind the one being delivered, so every listener sees every change in causal order.
  const queue: Delivery[] = [];
  let depth = 0;
  let draining = false;

  function unit<T>(work: () => T): T {
    depth += 1;
    try {
      return work();
    } finally {
      depth -= 1;
      if (depth === 0) drain();
    }
  }

  function drain() {
    if (draining) return;
    draining = true;
    try {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) deliver(item);
    } finally {
      draining = false;
    }
  }

  function deliver(item: Delivery) {
    if (item.kind === 'state') {
      for (const listener of [...stateListeners]) {
        try {
          listener(item.change);
        } catch (error) {
          logger.warn(
            { to: item.change.to, ...errorLogFields(error) },
            'broker socket state listener threw',
          );
        }
      }
      return;
    }
    const { session: owner, event } = item;
    for (const listener of [...eventListeners]) {
      // a listener before this one stopped or restarted the client: the event's session is gone
      if (sessionEnded(owner)) return;
      try {
        listener(event);
      } catch (error) {
        if (firstOnConnection(owner, `listener:${event.type}`)) {
          logger.warn(
            { type: event.type, ...errorLogFields(error) },
            'broker event listener threw',
          );
        }
      }
    }
  }

  function transition(to: BrokerSocketState, reason?: string) {
    const from = state;
    if (from === to) return;
    state = to;
    // the emitted command's answer can no longer be told apart from silence: its connection is
    // gone or going, and a new connection never carries it
    settleCommand({ outcome: 'unknown', reason: 'state_changed', state: to });
    const change: BrokerSocketStateChange =
      reason === undefined ? { from, to } : { from, to, reason };
    logger.debug(change, 'broker socket state');
    queue.push({ kind: 'state', change });
  }

  function settleCommand(result: SocketOpenTradeResult) {
    const command = pending;
    if (command === undefined) return;
    pending = undefined;
    command.settle(result);
  }

  // stopped, or replaced by a later start(): its socket's events no longer speak for the client
  const sessionEnded = (current: Session) => current.stopped || session !== current;

  function clearAuthTimer(current: Session) {
    if (current.authTimer !== undefined) clearTimeout(current.authTimer);
    current.authTimer = undefined;
  }

  // once per key per connection; true when this call is the first
  function firstOnConnection(current: Session, key: string): boolean {
    const warned = current.connection?.warned;
    if (warned === undefined) return true;
    if (warned.has(key)) return false;
    warned.add(key);
    return true;
  }

  // the only place price.subscribe is emitted, each chunk checked against the contract: after
  // user.auth.success, the pass right away (before ready is published) and subscribe() while ready
  function sendSubscriptions(current: Session, ids: readonly number[]) {
    for (const assets of chunkAssets(ids)) {
      if (sessionEnded(current)) return;
      current.socket.emit(
        BrokerSocketEvent.PriceSubscribe,
        priceSubscribeWireSchema.parse({ assets }),
      );
    }
  }

  function closeSocket(current: Session) {
    clearAuthTimer(current);
    current.socket.disconnect();
  }

  function detach(current: Session) {
    clearAuthTimer(current);
    current.socket.offAny();
    current.socket.removeAllListeners();
    current.socket.io.removeAllListeners();
  }

  function endSession(current: Session) {
    closeSocket(current);
    detach(current);
  }

  function onConnect(current: Session) {
    if (sessionEnded(current)) return;
    if (state !== BrokerSocketState.Connecting && state !== BrokerSocketState.Reconnecting) {
      logger.debug({ state }, 'broker socket connect out of state');
      return;
    }
    current.connectionCount += 1;
    current.connectErrorWarned = false;
    current.connection = {
      ordinal: current.connectionCount,
      connectedAt: Date.now(),
      attempt: current.reconnectAttempt,
      counters: newCounters(),
      warned: new Set(),
      tainted: false,
    };
    current.reconnectAttempt = 0;
    current.socket.emit(BrokerSocketEvent.UserAuth, current.auth);
    if (sessionEnded(current)) return;
    current.authTimer = setTimeout(() => unit(() => onAuthTimeout(current)), timing.authTimeoutMs);
    transition(BrokerSocketState.Authenticating);
  }

  function onAuthTimeout(current: Session) {
    current.authTimer = undefined;
    if (sessionEnded(current) || state !== BrokerSocketState.Authenticating) return;
    if (current.connection !== undefined) current.connection.counters.authTimeouts += 1;
    logger.warn({ connection: current.connection?.ordinal }, 'broker socket auth timeout');
    // a transport loss as far as socket.io is concerned: its backoff schedules the next attempt
    current.socket.io.engine.close();
  }

  function onDisconnect(current: Session, reason: string) {
    clearAuthTimer(current);
    // An emit made after the ping deadline passed but before engine.io closed (a subscribe() or
    // the pass) is buffered, and socket.io flushes its buffer on the next connect ahead of
    // user.auth: the broker would see price.subscribe unauthenticated and then again in the pass.
    // The pass resends everything the registry holds, so nothing buffered is needed.
    current.socket.sendBuffer = [];
    const { connection } = current;
    if (connection !== undefined) {
      logger.info(
        {
          reason,
          connection: connection.ordinal,
          durationMs: Date.now() - connection.connectedAt,
          ...connection.counters,
        },
        'broker socket disconnected',
      );
      current.connection = undefined;
    }
    if (current.stopped || isTerminalBrokerSocketState(state) || reason === CLIENT_DISCONNECT) {
      return;
    }
    if (reason === SERVER_DISCONNECT) {
      logger.warn({ reason }, 'broker socket disconnected by server');
      transition(BrokerSocketState.DisconnectedByServer, reason);
      return;
    }
    transition(BrokerSocketState.Reconnecting, reason);
  }

  function onConnectError(current: Session, error: Error) {
    if (sessionEnded(current) || isTerminalBrokerSocketState(state)) return;
    // a CONNECT_ERROR packet (the server's namespace middleware refused): socket.io destroys the
    // socket before emitting and never retries it; a transport failure leaves it active
    if (!current.socket.active) {
      logger.warn(
        { reason: CONNECT_ERROR, ...errorLogFields(error) },
        'broker socket disconnected by server',
      );
      transition(BrokerSocketState.DisconnectedByServer, CONNECT_ERROR);
      return;
    }
    const fields = { attempt: current.reconnectAttempt, ...errorLogFields(error) };
    if (current.connectErrorWarned) {
      logger.debug(fields, 'broker socket connect error');
    } else {
      current.connectErrorWarned = true;
      logger.warn(fields, 'broker socket connect error');
    }
  }

  function onAuthSuccess(current: Session) {
    if (state !== BrokerSocketState.Authenticating) {
      logger.debug({ state }, 'broker socket auth success out of state');
      return;
    }
    clearAuthTimer(current);
    connections += 1;
    const { connection } = current;
    logger.info(
      {
        connection: connection?.ordinal,
        attempt: connection?.attempt,
        subscriptions: registry.size,
        authMs: connection === undefined ? undefined : Date.now() - connection.connectedAt,
      },
      'broker socket ready',
    );
    sendSubscriptions(current, registry.all());
    if (sessionEnded(current)) return;
    transition(BrokerSocketState.Ready);
  }

  function onTerminalEvent(current: Session, to: BrokerSocketState, message?: string) {
    if (sessionEnded(current) || isTerminalBrokerSocketState(state)) return;
    if (to === BrokerSocketState.AuthFailed) {
      logger.warn({ detail: message?.slice(0, MAX_DETAIL_LENGTH) }, 'broker socket auth failed');
    } else {
      logger.warn('broker socket token expired');
    }
    closeSocket(current);
    if (sessionEnded(current)) return;
    transition(to, to === BrokerSocketState.AuthFailed ? 'auth_error' : 'token_expired');
  }

  function answerCommand(current: Session, event: BrokerEvent) {
    if (
      pending === undefined ||
      pending.session !== current ||
      pending.connection !== current.connection?.ordinal
    ) {
      return;
    }
    if (event.type === BrokerEventType.OpenTradeSuccess && event.mode === pending.mode) {
      const field = mismatchedField(event.trade, pending.request);
      if (field === undefined) {
        settleCommand({ outcome: 'success', trade: event.trade });
      } else {
        logger.warn(
          { connection: pending.connection, mode: pending.mode, field },
          'broker socket open_trade answer mismatch',
        );
      }
    } else if (event.type === BrokerEventType.OpenTradeFail && event.mode === pending.mode) {
      settleCommand({ outcome: 'fail', failures: event.failures });
    }
  }

  // The check and the emit are one synchronous unit: the state the caller is answered by is the
  // state the command went out in. The only emit of user.<mode>.open_trade.
  function openTrade(
    mode: TradeMode,
    request: SocketOpenTradeRequest,
    signal: AbortSignal,
  ): Promise<SocketOpenTradeResult> {
    const current = session;
    if (signal.aborted) {
      return Promise.resolve({ outcome: 'not_sent', reason: 'aborted', state });
    }
    const connection = current?.connection;
    if (
      current === undefined ||
      connection === undefined ||
      connection.tainted ||
      state !== BrokerSocketState.Ready
    ) {
      return Promise.resolve({ outcome: 'not_sent', reason: 'not_ready', state });
    }
    if (pending !== undefined) throw new Error('broker socket open_trade already pending');
    const payload = socketOpenTradeRequestWireSchema.parse(toSocketOpenTradeRequestWire(request));
    current.socket.emit(modeEvent(mode, 'open_trade'), payload);
    logger.debug({ mode, connection: connection.ordinal }, 'broker socket open_trade sent');
    if (sessionEnded(current) || state !== BrokerSocketState.Ready) {
      return Promise.resolve({ outcome: 'unknown', reason: 'state_changed', state });
    }
    return new Promise((resolve) => {
      const command: PendingCommand = {
        session: current,
        connection: connection.ordinal,
        mode,
        request,
        settle: (result) => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
      };
      function onAbort() {
        if (pending !== command) return;
        settleCommand({ outcome: 'unknown', reason: 'aborted', state });
        const owner = command.session;
        const live = owner.connection;
        if (sessionEnded(owner) || live?.ordinal !== command.connection) return;
        // A late answer of this command would answer the next one: the connection takes no
        // command until it is replaced. engine.io's close is a transport loss to socket.io, whose
        // backoff reconnects; with packets still in its write buffer engine.io drains them first
        // and `disconnect` comes later, so the flag covers the window until it does.
        live.tainted = true;
        logger.warn({ connection: command.connection }, 'broker socket connection tainted');
        owner.socket.io.engine.close();
      }
      pending = command;
      signal.addEventListener('abort', onAbort);
    });
  }

  function dispatch(current: Session, event: BrokerEvent) {
    queue.push({ kind: 'event', session: current, event });
  }

  function onAnyEvent(current: Session, name: string, args: unknown[]) {
    if (sessionEnded(current)) return;
    const counters = current.connection?.counters;
    if (counters !== undefined) counters.events += 1;
    if (IGNORED_BROKER_EVENTS.has(name)) {
      if (counters !== undefined) counters.ignored += 1;
      logger.debug({ event: name }, 'broker event ignored');
      return;
    }
    const result = normalizeBrokerEvent(name, args);
    if (counters !== undefined) counters.extraArgs += result.extraArgs;
    if (!result.ok) {
      const { problem } = result;
      if (counters !== undefined) counters.problems[problem.kind] += 1;
      if (firstOnConnection(current, `problem:${problem.kind}:${problem.event}`)) {
        logger.warn({ problem, extraArgs: result.extraArgs }, 'broker event problem');
      }
      return;
    }
    const { event } = result;
    answerCommand(current, event);
    if (result.extraArgs > 0 && firstOnConnection(current, `extra:${name}`)) {
      logger.warn(
        { event: name, extraArgs: result.extraArgs },
        'broker event with extra arguments',
      );
    }
    switch (event.type) {
      case BrokerEventType.AuthSuccess:
        onAuthSuccess(current);
        break;
      case BrokerEventType.AuthError:
        onTerminalEvent(current, BrokerSocketState.AuthFailed, event.message);
        break;
      case BrokerEventType.TokenExpired:
        onTerminalEvent(current, BrokerSocketState.TokenExpired);
        break;
      default:
        break;
    }
    dispatch(current, event);
  }

  function start(credentials: BrokerCredentials) {
    // `starting`: an openSocket that calls start() itself would orphan one of the two sockets
    if (starting || (state !== BrokerSocketState.Idle && !isTerminalBrokerSocketState(state))) {
      throw new Error('broker socket client already started');
    }
    const auth = userAuthWireSchema.safeParse({
      id: credentials.brokerUserId,
      token: credentials.accessToken,
    });
    // the zod error is not passed on: its issues may quote the input
    if (!auth.success) throw new TypeError('broker socket credentials are invalid');
    if (session !== undefined) endSession(session);
    starting = true;
    try {
      open(auth.data);
    } finally {
      starting = false;
    }
  }

  function open(auth: UserAuthWire) {
    const socket = openSocket(options.url, {
      transports: ['websocket'],
      forceNew: true,
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Number.POSITIVE_INFINITY,
      reconnectionDelay: timing.reconnectDelayMs,
      reconnectionDelayMax: timing.reconnectDelayMaxMs,
      randomizationFactor: timing.jitter,
      timeout: timing.connectTimeoutMs,
    });
    const current: Session = {
      socket,
      auth,
      stopped: false,
      reconnectAttempt: 0,
      connectErrorWarned: false,
      connectionCount: 0,
    };
    session = current;
    connections = 0;
    socket.on('connect', () => unit(() => onConnect(current)));
    socket.on('disconnect', (reason) => unit(() => onDisconnect(current, reason)));
    socket.on('connect_error', (error) => unit(() => onConnectError(current, error)));
    socket.io.on('reconnect_attempt', (attempt) => {
      current.reconnectAttempt = attempt;
    });
    socket.onAny((name: string, ...args: unknown[]) => unit(() => onAnyEvent(current, name, args)));
    // connecting before connect(), so a double that connects synchronously finds it; the
    // notification is delivered after connect() returned, so a listener's stop() there closes a
    // socket that stays closed (Manager.open would undo an earlier disconnect)
    transition(BrokerSocketState.Connecting);
    socket.connect();
  }

  function stop() {
    const current = session;
    if (current === undefined) return;
    session = undefined;
    current.stopped = true;
    // socket.io emits `disconnect` before disconnect() returns, so the summary line is written
    // while the listeners are still attached
    endSession(current);
    transition(BrokerSocketState.Idle, 'stop');
  }

  return {
    start: (credentials) => unit(() => start(credentials)),
    stop: () => unit(stop),
    subscribe(assetIds) {
      const added = registry.add(assetIds);
      if (session !== undefined && state === BrokerSocketState.Ready && added.length > 0) {
        sendSubscriptions(session, added);
      }
    },
    subscriptions: () => registry.all(),
    openTrade: (mode, request, signal) => unit(() => openTrade(mode, request, signal)),
    get state() {
      return state;
    },
    get connections() {
      return connections;
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
}
