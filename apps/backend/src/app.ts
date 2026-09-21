import Fastify, { type FastifyInstance } from 'fastify';
import type { LogLevel } from './env';

export type DependencyCheck = () => Promise<unknown>;

export interface AppDeps {
  checkPostgres: DependencyCheck;
  checkRedis: DependencyCheck;
  logLevel: LogLevel;
  checkTimeoutMs?: number;
}

type CheckStatus = 'ok' | 'error';

export function buildApp({
  checkPostgres,
  checkRedis,
  logLevel,
  checkTimeoutMs = 2000,
}: AppDeps): FastifyInstance {
  const app = Fastify({ logger: { level: logLevel } });

  app.get('/health', async (_request, reply) => {
    const [postgres, redis] = await Promise.all([
      runCheck(checkPostgres, checkTimeoutMs),
      runCheck(checkRedis, checkTimeoutMs),
    ]);
    const healthy = postgres === 'ok' && redis === 'ok';
    return reply
      .code(healthy ? 200 : 503)
      .send({ status: healthy ? 'ok' : 'degraded', postgres, redis });
  });

  return app;
}

async function runCheck(check: DependencyCheck, timeoutMs: number): Promise<CheckStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('dependency check timed out')), timeoutMs);
  });
  try {
    // Promise.resolve().then() turns a synchronous throw into a rejection
    await Promise.race([Promise.resolve().then(check), timeout]);
    return 'ok';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}
