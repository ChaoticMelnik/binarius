import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { errorLogFields } from '@binarius/shared';
import { SESSION_NOTICE_LISTEN_RETRY_MS } from '../timing';

// docs/bot-session.md → Rate and timing → The wake (#723). One client of the backend's pool LISTENs
// on the session notice channel for as long as the process runs and hands every notification to
// onNotification (the sender's wake()). A refused connect or LISTEN and a lost connection are
// logged and tried again after retryMs; a notification sent meanwhile is lost, and the sender's
// tick serves it. The client always leaves with release(true): a client still LISTENing must not
// go back to the pool.

export interface SessionNoticeListenerDeps {
  pool: Pick<Pool, 'connect'>;
  channel: string;
  onNotification: (payload: string) => void;
  logger: FastifyBaseLogger;
  retryMs?: number;
}

export interface SessionNoticeListener {
  start(): void;
  // Ends the listening and waits for a connect in flight (bounded by the pool's
  // connectionTimeoutMillis, timing.test.ts); the client is destroyed, not returned to the pool.
  stop(): Promise<void>;
}

export function createSessionNoticeListener(
  deps: SessionNoticeListenerDeps,
): SessionNoticeListener {
  const { pool, channel, onNotification, logger } = deps;
  const retryMs = deps.retryMs ?? SESSION_NOTICE_LISTEN_RETRY_MS;
  let started = false;
  let stopped = false;
  let current: PoolClient | undefined;
  let connecting: Promise<void> | undefined;
  let retry: NodeJS.Timeout | undefined;

  const retryLater = () => {
    if (stopped) return;
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, retryMs);
  };

  async function listen(): Promise<void> {
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      if (stopped) {
        client.release(true);
        return;
      }
      const own = client;
      // one break of the connection emits two errors and an end: only the first, while the client
      // is the current one, counts; without a handler the error would crash the process
      const lost = (error?: Error) => {
        if (own !== current) return;
        current = undefined;
        own.release(true);
        logger.warn(
          { retryMs, ...errorLogFields(error ?? new Error('the connection ended')) },
          'session notice listener lost',
        );
        retryLater();
      };
      own.on('error', lost);
      own.on('end', () => lost());
      own.on('notification', (notification) => onNotification(notification.payload ?? ''));
      await own.query(`LISTEN ${own.escapeIdentifier(channel)}`);
      if (stopped) {
        own.release(true);
        return;
      }
      current = own;
      logger.info({ channel }, 'session notice listener listening');
    } catch (error) {
      client?.release(true);
      logger.warn({ retryMs, ...errorLogFields(error) }, 'session notice listener not connected');
      retryLater();
    }
  }

  function connect() {
    if (stopped) return;
    connecting = listen().finally(() => {
      connecting = undefined;
    });
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      connect();
    },
    async stop() {
      stopped = true;
      clearTimeout(retry);
      retry = undefined;
      await connecting;
      const client = current;
      current = undefined;
      client?.release(true);
    },
  };
}
