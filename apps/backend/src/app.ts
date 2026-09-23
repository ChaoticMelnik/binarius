import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type LogLevel,
} from 'fastify';
import { errorIdentity, LOG_REDACT_PATHS } from '@binarius/shared';
import { authRoutes, type AuthRoutesDeps } from './auth/routes';
import { tradingRoutes, type TradingRoutesDeps } from './trading/routes';

type DependencyCheck = () => Promise<unknown>;

export interface AppDeps {
  checkPostgres: DependencyCheck;
  checkRedis: DependencyCheck;
  logLevel: LogLevel;
  checkTimeoutMs: number;
  trading: TradingRoutesDeps;
  auth: AuthRoutesDeps;
}

type CheckResult = { status: 'ok' } | { status: 'error'; error: unknown };

export function buildApp({
  checkPostgres,
  checkRedis,
  logLevel,
  checkTimeoutMs,
  trading,
  auth,
}: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: logLevel,
      redact: [...LOG_REDACT_PATHS],
      // the default serializer logs the raw url, and an OAuth provider that ignores
      // response_mode=web_message delivers the authorization code as a query parameter
      serializers: { req: serializeRequest },
    },
  });

  // Fastify's own not-found log builds its message from the raw url, where no redact path and
  // no serializer can reach it
  app.setNotFoundHandler((request, reply) => {
    request.log.info(
      { method: request.method, url: withoutSecrets(request.url) },
      'route not found',
    );
    return reply.code(404).send({ error: 'not_found' });
  });

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
  void app.register(authRoutes, auth);

  // Fastify's default handler echoes error.message; for a DrizzleQueryError that is the SQL
  // text plus bound parameters. A 4xx error (validation, body parsing, a thrown http error)
  // keeps its shape: reply.send(error) re-enters Fastify's own chain, whose default handler
  // applies error.headers and the status. Anything else — including an error whose only status
  // is a `status` field, or a nonsensical sub-400 statusCode — becomes an opaque 500 and a log line.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const { statusCode } = error;
    if (
      typeof statusCode === 'number' &&
      Number.isInteger(statusCode) &&
      statusCode >= 400 &&
      statusCode < 500
    ) {
      return reply.send(error);
    }
    // name and code only: a DrizzleQueryError carries the bound parameters as a field and
    // interpolates them into its message, and no key-based redact path scrubs a string. The
    // query template is safe on its own — it holds $1 placeholders, never values.
    request.log.error(
      { err: errorIdentity(error), query: queryOf(error) },
      'unhandled request error',
    );
    return reply.code(500).send({ error: 'internal' });
  });

  return app;
}

// `code` and `state` are secrets for the window they are alive, and both can arrive in a query
// string: the broker chooses how it delivers them, and a 404 is exactly where an unexpected
// delivery lands.
const SECRET_QUERY_KEYS = ['code', 'state'];

export function withoutSecrets(url: string): string {
  const separator = url.indexOf('?');
  if (separator === -1) return url;
  const params = new URLSearchParams(url.slice(separator + 1));
  let redacted = false;
  for (const key of SECRET_QUERY_KEYS) {
    if (!params.has(key)) continue;
    // a bare word, not pino's '[Redacted]': URLSearchParams would percent-encode the brackets
    // and the marker would stop being greppable
    params.set(key, 'redacted');
    redacted = true;
  }
  return redacted ? `${url.slice(0, separator)}?${params.toString()}` : url;
}

function serializeRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: withoutSecrets(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort,
  };
}

// drizzle puts the SQL text on the error; anything else has no query to report
function queryOf(error: unknown): string | undefined {
  const query = (error as { query?: unknown } | null)?.query;
  return typeof query === 'string' ? query : undefined;
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
