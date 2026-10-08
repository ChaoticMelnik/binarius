import type { Server as HttpServer } from 'node:http';
import {
  BrokerSocketEvent,
  modeEvent,
  priceSubscribeWireSchema,
  socketOpenTradeRequestWireSchema,
  TradeMode,
  userAuthWireSchema,
  type ModeScopedEvent,
  type OpenTradeFailWire,
} from '@binarius/shared';
import { Server, type Socket } from 'socket.io';
import { encodeSocketPayload, type MockSocketPayload } from './encoding';
import { FaultQueue } from './faults';
import { FIXTURE_MESSAGES, LIVE_MESSAGES } from './messages';
import {
  assertSocketScript,
  socketScriptKind,
  type MockSocketEndpoint,
  type MockSocketScript,
} from './socket-faults';
import { MockChangeType, type BrokerState, type MockChange } from './state';

export const MockSocketOutcome = {
  Handled: 'handled',
  Scripted: 'scripted',
  Unauthenticated: 'unauthenticated',
  Invalid: 'invalid',
  AuthFailed: 'auth_failed',
  Unknown: 'unknown',
} as const;
export type MockSocketOutcome = (typeof MockSocketOutcome)[keyof typeof MockSocketOutcome];

// observed 2026-10-02 on the live broker, not in shared's BrokerServerToClientEvents
export const OBSERVED_EXTRA_EVENTS = {
  PriceSubscribed: 'price.subscribed',
  RealCloseTradeRecent: 'user.real.close_trade.recent',
  DemoCloseTradeRecent: 'user.demo.close_trade.recent',
  RealFuturesPositions: 'user.real.futures.positions',
  RealFuturesClosedRecent: 'user.real.futures.closed.recent',
  DemoFuturesPositions: 'user.demo.futures.positions',
  DemoFuturesClosedRecent: 'user.demo.futures.closed.recent',
} as const;

// what arrived, without the token or any payload value: a test proves what the client sent
// without the journal becoming a place secrets collect
export interface MockSocketRecord {
  socketId: string;
  event: string;
  // every argument as it arrived, a trailing ack function included
  argc: number;
  userId?: number;
  outcome: MockSocketOutcome;
}

export interface MockSocketInfo {
  id: string;
  userId?: number;
  // sorted
  subscriptions: number[];
}

export type MockSocketTarget = { userId: number } | { socketId: string };

export interface MockSocket {
  failNext<E extends MockSocketEndpoint>(endpoint: E, script: MockSocketScript<E>): void;
  journal: readonly MockSocketRecord[];
  clearJournal(): void;
  // connected sockets, in connection order
  sockets(): MockSocketInfo[];
  // the server drops each matching socket; returns how many
  disconnect(target: MockSocketTarget): number;
  // closes each matching socket's transport without a DISCONNECT packet: the client sees
  // `transport close` and reconnects on its own, the shape of the live drop of 2026-10-02;
  // returns how many
  cutTransport(target: MockSocketTarget): number;
  // emits exactly these arguments to each matching socket, outside the payload form: a malformed
  // payload, extra arguments or an unknown event name; returns how many
  emitRaw(target: MockSocketTarget, event: string, ...args: unknown[]): number;
  // one price.update to each authenticated socket subscribed to the asset; returns how many
  pushPrice(assetId: number, atMs?: number): number;
  // one price.update per subscription of each authenticated socket, ids without a pair skipped;
  // returns how many were sent
  pushPrices(atMs?: number): number;
  // openTrade scripts waiting on their delayMs
  readonly pendingDelays: number;
}

interface Connection {
  socket: Socket;
  userId?: number;
  subscriptions: Set<number>;
}

const MODES = [TradeMode.Demo, TradeMode.Real] as const;
const AUTHENTICATED_ROOM = 'authenticated';
const userRoom = (userId: number) => `user:${userId}`;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// the text the REST routes use for a schema refusal, naming the first failing field
function schemaMessage(
  input: unknown,
  issues: readonly { path: readonly PropertyKey[] }[],
  fallback: string,
) {
  const field = String(issues[0]?.path[0] ?? fallback);
  const value = isPlainObject(input) ? input[field] : undefined;
  return {
    field,
    message:
      value === undefined ? FIXTURE_MESSAGES.required(field) : FIXTURE_MESSAGES.invalid(field),
  };
}

export function attachMockSocket(
  httpServer: HttpServer,
  state: BrokerState,
  form: MockSocketPayload,
): { socket: MockSocket; close(): void } {
  const io = new Server(httpServer, { serveClient: false, transports: ['websocket'] });
  const faults = new FaultQueue<MockSocketEndpoint, MockSocketScript<MockSocketEndpoint>>(
    assertSocketScript,
  );
  const journal: MockSocketRecord[] = [];
  const connections = new Map<string, Connection>();
  const delayed = new Set<ReturnType<typeof setTimeout>>();

  // the one place a server->client payload is encoded
  const emitTo = (target: Pick<Socket, 'emit'>, event: string, payload: unknown) =>
    target.emit(event, encodeSocketPayload(payload, form));

  const toUser = (userId: number) => io.to(userRoom(userId));

  function authenticated(connection: Connection, userId: number) {
    const { socket } = connection;
    if (connection.userId !== undefined && connection.userId !== userId) {
      void socket.leave(userRoom(connection.userId));
    }
    connection.userId = userId;
    void socket.join([userRoom(userId), AUTHENTICATED_ROOM]);
    emitTo(socket, BrokerSocketEvent.UserAuthSuccess, null);
    emitTo(socket, BrokerSocketEvent.UserData, state.getUser(userId));
    emitTo(socket, BrokerSocketEvent.CommonAssetsList, state.listPairs());
    emitTo(socket, OBSERVED_EXTRA_EVENTS.RealCloseTradeRecent, { trades: [] });
    emitTo(socket, OBSERVED_EXTRA_EVENTS.DemoCloseTradeRecent, { trades: [] });
    emitTo(socket, OBSERVED_EXTRA_EVENTS.RealFuturesPositions, { positions: [], orders: [] });
    emitTo(socket, OBSERVED_EXTRA_EVENTS.RealFuturesClosedRecent, { orders: [] });
    emitTo(socket, OBSERVED_EXTRA_EVENTS.DemoFuturesPositions, { positions: [], orders: [] });
    emitTo(socket, OBSERVED_EXTRA_EVENTS.DemoFuturesClosedRecent, { orders: [] });
  }

  function onAuth(connection: Connection, payload: unknown): MockSocketOutcome {
    const { socket } = connection;
    const script = faults.shift('auth');
    if (script !== undefined) {
      const played = socketScriptKind(script);
      if (played.kind === 'error') {
        emitTo(socket, BrokerSocketEvent.UserAuthError, { message: played.message });
      } else if (played.kind === 'disconnect') {
        socket.disconnect(true);
      }
      return MockSocketOutcome.Scripted;
    }
    const parsed = userAuthWireSchema.safeParse(payload);
    if (!parsed.success) {
      const { message } = schemaMessage(payload, parsed.error.issues, 'id');
      emitTo(socket, BrokerSocketEvent.UserAuthError, { message });
      return MockSocketOutcome.Invalid;
    }
    const userId = state.authenticate(parsed.data.token);
    if (userId === undefined || String(parsed.data.id) !== String(userId)) {
      emitTo(socket, BrokerSocketEvent.UserAuthError, { message: LIVE_MESSAGES.invalidToken });
      return MockSocketOutcome.AuthFailed;
    }
    authenticated(connection, userId);
    return MockSocketOutcome.Handled;
  }

  function onSubscribe(connection: Connection, payload: unknown): MockSocketOutcome {
    if (connection.userId === undefined) return MockSocketOutcome.Unauthenticated;
    const parsed = priceSubscribeWireSchema.safeParse(payload);
    if (!parsed.success) return MockSocketOutcome.Invalid;
    for (const assetId of parsed.data.assets) connection.subscriptions.add(assetId);
    emitTo(connection.socket, OBSERVED_EXTRA_EVENTS.PriceSubscribed, {
      assets: parsed.data.assets,
    });
    return MockSocketOutcome.Handled;
  }

  // the unscripted path; reply: false runs the command and answers no one (a silent or
  // disconnect script with open: true). userId is the user the socket was authenticated as when
  // the command arrived: a delayed command still belongs to that user, and its answer goes only
  // to a socket still logged in as that user, never into a session that re-authenticated as
  // someone else.
  function runOpenTrade(
    connection: Connection,
    userId: number,
    mode: TradeMode,
    payload: unknown,
    reply: boolean,
  ): MockSocketOutcome {
    const answer = (event: ModeScopedEvent, body: unknown) => {
      if (reply && connection.userId === userId) {
        emitTo(connection.socket, modeEvent(mode, event), body);
      }
    };
    const parsed = socketOpenTradeRequestWireSchema.safeParse(payload);
    if (!parsed.success) {
      const failure = schemaMessage(payload, parsed.error.issues, 'asset_id');
      answer('open_trade.fail', [failure] satisfies OpenTradeFailWire);
      return MockSocketOutcome.Invalid;
    }
    const result = state.openTrade(userId, { ...parsed.data, is_demo: mode === TradeMode.Demo });
    if (!result.ok) answer('open_trade.fail', [{ message: result.message }]);
    else answer('open_trade.success', socketTrade(result.trade));
    return MockSocketOutcome.Handled;
  }

  // auth comes before the script: an unauthenticated command leaves the script queued
  function onOpenTrade(connection: Connection, mode: TradeMode, payload: unknown) {
    const { userId } = connection;
    if (userId === undefined) return MockSocketOutcome.Unauthenticated;
    const script = faults.shift('openTrade');
    if (script === undefined) return runOpenTrade(connection, userId, mode, payload, true);
    const played = socketScriptKind(script);
    switch (played.kind) {
      case 'fail':
        emitTo(connection.socket, modeEvent(mode, 'open_trade.fail'), played.failures);
        break;
      case 'silent':
        if (played.open) runOpenTrade(connection, userId, mode, payload, false);
        break;
      case 'disconnect':
        connection.socket.disconnect(true);
        if (played.open) runOpenTrade(connection, userId, mode, payload, false);
        break;
      case 'delay': {
        const timer = setTimeout(() => {
          delayed.delete(timer);
          runOpenTrade(connection, userId, mode, payload, true);
        }, played.delayMs);
        delayed.add(timer);
        break;
      }
      case 'error':
        break;
    }
    return MockSocketOutcome.Scripted;
  }

  const openTradeEvents = new Map<string, TradeMode>(
    MODES.map((mode) => [modeEvent(mode, 'open_trade'), mode]),
  );

  function dispatch(connection: Connection, event: string, payload: unknown): MockSocketOutcome {
    if (event === BrokerSocketEvent.UserAuth) return onAuth(connection, payload);
    if (event === BrokerSocketEvent.PriceSubscribe) return onSubscribe(connection, payload);
    const mode = openTradeEvents.get(event);
    if (mode !== undefined) return onOpenTrade(connection, mode, payload);
    return MockSocketOutcome.Unknown;
  }

  // a refused connection never reaches 'connection', so the journal records nothing for it
  io.use((_socket, next) => {
    const script = faults.shift('connect');
    if (script === undefined) {
      next();
      return;
    }
    const played = socketScriptKind(script);
    next(played.kind === 'error' ? new Error(played.message) : undefined);
  });

  io.on('connection', (socket) => {
    const connection: Connection = { socket, subscriptions: new Set() };
    connections.set(socket.id, connection);
    socket.on('disconnect', () => {
      connections.delete(socket.id);
    });
    socket.onAny((event: string, ...args: unknown[]) => {
      const record: MockSocketRecord = {
        socketId: socket.id,
        event,
        argc: args.length,
        outcome: MockSocketOutcome.Unknown,
      };
      journal.push(record);
      record.outcome = dispatch(connection, event, args[0]);
      if (connection.userId !== undefined) record.userId = connection.userId;
    });
  });

  // the store is the one writer; this listener only fans its changes out, and emitting to a
  // room nobody is in, or to a socket already gone, is a no-op rather than a throw
  const unsubscribe = state.onChange((change: MockChange) => {
    switch (change.type) {
      case MockChangeType.TradeOpened: {
        const mode = change.trade.is_demo ? TradeMode.Demo : TradeMode.Real;
        emitTo(
          toUser(change.userId),
          modeEvent(mode, 'update_balance'),
          state.getUser(change.userId)[mode],
        );
        return;
      }
      case MockChangeType.TradeClosed: {
        const mode = change.trade.is_demo ? TradeMode.Demo : TradeMode.Real;
        emitTo(toUser(change.userId), modeEvent(mode, 'close_trade.success'), {
          trades: [socketTrade(change.trade)],
        });
        emitTo(
          toUser(change.userId),
          modeEvent(mode, 'update_balance'),
          state.getUser(change.userId)[mode],
        );
        return;
      }
      case MockChangeType.PairUpdated:
        // the live form is an array of patches (#368); a pairs.update() is one pair
        emitTo(io.to(AUTHENTICATED_ROOM), BrokerSocketEvent.CommonAssetsUpdate, [
          {
            asset_id: change.pair.id,
            payout: change.pair.payout,
            scheduled_until: change.pair.scheduled_until,
          },
        ]);
        return;
      case MockChangeType.TokenRevoked:
        emitTo(toUser(change.userId), BrokerSocketEvent.UserDisconnectTokenExpired, null);
        io.in(userRoom(change.userId)).disconnectSockets(true);
        return;
    }
  });

  function sendPrice(connection: Connection, assetId: number, atMs: number) {
    emitTo(connection.socket, BrokerSocketEvent.PriceUpdate, [
      assetId,
      state.priceAt(assetId, atMs),
      atMs,
    ]);
  }

  const matchingConnections = (target: MockSocketTarget) =>
    [...connections.values()].filter((connection) =>
      'userId' in target
        ? connection.userId === target.userId
        : connection.socket.id === target.socketId,
    );

  const socket: MockSocket = {
    failNext: (endpoint, script) => faults.push(endpoint, script),
    journal,
    clearJournal: () => {
      journal.length = 0;
    },
    sockets: () =>
      [...connections.values()].map((connection) => ({
        id: connection.socket.id,
        ...(connection.userId === undefined ? {} : { userId: connection.userId }),
        subscriptions: [...connection.subscriptions].sort((a, b) => a - b),
      })),
    disconnect(target) {
      const matching = matchingConnections(target);
      for (const connection of matching) connection.socket.disconnect(true);
      return matching.length;
    },
    cutTransport(target) {
      const matching = matchingConnections(target);
      for (const connection of matching) connection.socket.conn.close();
      return matching.length;
    },
    emitRaw(target, event, ...args) {
      const matching = matchingConnections(target);
      for (const connection of matching) connection.socket.emit(event, ...args);
      return matching.length;
    },
    pushPrice(assetId, atMs = Date.now()) {
      // an unknown asset is a test error, thrown before anything is sent
      state.priceAt(assetId, atMs);
      const receivers = [...connections.values()].filter((connection) =>
        connection.subscriptions.has(assetId),
      );
      for (const connection of receivers) sendPrice(connection, assetId, atMs);
      return receivers.length;
    },
    pushPrices(atMs = Date.now()) {
      let sent = 0;
      // only an authenticated socket holds subscriptions: price.subscribe is refused before auth
      for (const connection of connections.values()) {
        for (const assetId of connection.subscriptions) {
          if (state.findPair(assetId) === undefined) continue;
          sendPrice(connection, assetId, atMs);
          sent += 1;
        }
      }
      return sent;
    },
    get pendingDelays() {
      return delayed.size;
    },
  };

  return {
    socket,
    // io.close() is not used: it waits for httpServer.close(), which waits for a REST connection
    // close() has cut but not yet dropped; the caller closes the HTTP server next
    close() {
      for (const timer of delayed) clearTimeout(timer);
      delayed.clear();
      unsubscribe();
      io.disconnectSockets(true);
      io.engine.close();
    },
  };
}

// The live broker's socket trade (#354): the REST form without is_demo, the mode being the event's.
// The store keeps is_demo for REST.
function socketTrade(trade: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(trade).filter(([key]) => key !== 'is_demo'));
}
