import Fastify, { type FastifyInstance, type LogLevel } from 'fastify';
import { LOG_REDACT_PATHS } from '@binarius/shared';
import { tradingRoutes, type TradingRoutesDeps } from './trading/routes';

type DependencyCheck = () => Promise<unknown>;

export interface AppDeps {
  checkPostgres: DependencyCheck;
  checkRedis: DependencyCheck;
  logLevel: LogLevel;
  checkTimeoutMs: number;
  trading: TradingRoutesDeps;
}

type CheckResult = { status: 'ok' } | { status: 'error'; error: unknown };

export function buildApp({
  checkPostgres,
  checkRedis,
  logLevel,
  checkTimeoutMs,
  trading,
}: AppDeps): FastifyInstance {
  const app = Fastify({ logger: { level: logLevel, redact: [...LOG_REDACT_PATHS] } });

  app.get('/health', async (request, reply) => {
    const [postgres, redis] = await Promise.all([
      runCheck(checkPostgres, checkTimeoutMs),
      runCheck(checkRedis, checkTimeoutMs),
    ]);
    if (postgres.status === 'error') {
      request.log.warn({ err: postgres.error }, 'postgres check failed');
    }
    if (redis.status === 'error') {
      request.log.warn({ err: redis.error }, 'redis check failed');
    }
    const healthy = postgres.status === 'ok' && redis.status === 'ok';
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      postgres: postgres.status,
      redis: redis.status,
    });
  });

  void app.register(tradingRoutes, trading);

  return app;
}

async function runCheck(check: DependencyCheck, timeoutMs: number): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('dependency check timed out')), timeoutMs);
  });
  try {
    // Promise.resolve().then() turns a synchronous throw into a rejection
    await Promise.race([Promise.resolve().then(check), timeout]);
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error', error };
  } finally {
    clearTimeout(timer);
  }
}
