import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import pino, { type DestinationStream } from 'pino';
import {
  errorIdentity,
  errorLogFields,
  LOG_SERIALIZERS,
  logOptions,
  type LogLevel,
} from '@binarius/shared';
import { adminRoutes, type AdminRoutesDeps } from './admin/routes';
import { authRoutes, type AuthRoutesDeps } from './auth/routes';
import { pairsRoutes, type PairsRoutesDeps } from './trading/pairs-routes';
import { tradingRoutes, type TradingRoutesDeps } from './trading/routes';
import { usersRoutes, type UsersRoutesDeps } from './users/routes';

type DependencyCheck = () => Promise<unknown>;

export interface AppDeps {
  checkPostgres: DependencyCheck;
  checkRedis: DependencyCheck;
  logLevel: LogLevel;
  checkTimeoutMs: number;
  trading: TradingRoutesDeps;
  pairs: PairsRoutesDeps;
  auth: AuthRoutesDeps;
  users: UsersRoutesDeps;
  admin: AdminRoutesDeps;
  // Where the logger writes. Production omits it and pino uses its own destination; the tests
  // pass a sink, because what this app keeps out of its log lines is only provable by reading
  // them, and pino writes to a file descriptor that stubbing `process.stdout` does not reach.
  logDestination?: DestinationStream;
}

type CheckResult = { status: 'ok' } | { status: 'error'; error: unknown };

// Fastify logs a handful of events itself, as `{ err: error }`. The logger's serializer reduces
// that `err` to its whitelist (logOptions), but two of these lines also pass `error.message` as
// the log message — the default error log and the head-write failure — and a message given
// explicitly is out of the serializer's and the hook's reach. Our own 4xx path reaches the
// first, because the error handler delegates through `reply.send(error)`. These overrides keep
// every operational field and level the originals have — dropping `res`, `responseTime` or
// `statusCode` would cost the reason those lines exist — and replace the error and the message.
//
// Fastify's other own lines — client errors, hook errors, rejected promises after send, a stream
// error on an auto-generated HEAD route — carry the error under `err` and so reach the log by
// name and code only. Its duplicate-reply warning still writes the raw url into the message.
// docs/binodex-oauth.md says what remains.
class SafeLogController extends LogController {
  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (this.isLogDisabled(request)) return;
    if (error) {
      reply.log.error(
        { res: reply, ...errorLogFields(error), responseTime: reply.elapsedTime },
        'request errored',
      );
      return;
    }
    reply.log.info({ res: reply, responseTime: reply.elapsedTime }, 'request completed');
  }

  override defaultErrorLog(error: Error, request: FastifyRequest, reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    if (reply.statusCode >= 500) {
      reply.log.error(
        { req: request, res: reply, ...errorLogFields(error) },
        'request failed with an unhandled error',
      );
      return;
    }
    reply.log.info({ res: reply, ...errorLogFields(error) }, 'request refused');
  }

  override streamError(error: Error, request: FastifyRequest, reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    if ((error as { code?: unknown }).code === 'ERR_STREAM_PREMATURE_CLOSE') {
      reply.log.info({ res: reply }, 'stream closed prematurely');
      return;
    }
    reply.log.warn(
      errorLogFields(error),
      'response terminated with an error with headers already sent',
    );
  }

  override writeHeadError(error: Error, request: FastifyRequest, reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    reply.log.warn(
      { req: request, res: reply, ...errorLogFields(error) },
      'writing the response head failed',
    );
  }

  override serializerError(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
    metadata: { statusCode: number },
  ): void {
    if (this.isLogDisabled(request)) return;
    reply.log.error(
      { ...errorLogFields(error), statusCode: metadata.statusCode },
      'the serializer for the given status code failed',
    );
  }

  // unreachable while setNotFoundHandler below is installed, and overridden so that removing it
  // cannot quietly put the raw url back in the log
  override routeNotFound(request: FastifyRequest): void {
    if (this.isLogDisabled(request)) return;
    request.log.info(
      { method: request.method, url: withoutSecrets(request.url) },
      'route not found',
    );
  }
}

export function buildApp({
  checkPostgres,
  checkRedis,
  logLevel,
  checkTimeoutMs,
  trading,
  pairs,
  auth,
  users,
  admin,
  logDestination,
}: AppDeps): FastifyInstance {
  // Typed as Fastify's logger: left to inference, pino's Logger becomes the instance's logger
  // type parameter and the app no longer is the FastifyInstance every route module takes.
  const logger: FastifyBaseLogger = pino(
    {
      ...logOptions(logLevel),
      // the default serializer logs the raw url, and the broker delivers the authorization
      // code as a query parameter of the redirect
      serializers: { ...LOG_SERIALIZERS, req: serializeRequest },
    },
    logDestination,
  );
  const app = Fastify({
    // An instance, not the class: Fastify validates `userController instanceof LogController`.
    // Its options belong here rather than in the Fastify options — a supplied controller is
    // returned as-is, so `disableRequestLogging` or `requestIdLogLabel` given to Fastify would
    // never reach it. The empty object takes the same defaults Fastify would have applied.
    logController: new SafeLogController({}),
    // An instance rather than `logger` options: Fastify's option type requires an `err`
    // serializer to return `{ type, message, stack }`, which is what the whitelist withholds.
    // Fastify merges its own `res` serializer under these and keeps ours.
    loggerInstance: logger,
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
      request.log.warn({ err: errorIdentity(postgres.error) }, 'postgres check failed');
    }
    if (redis.status === 'error') {
      request.log.warn({ err: errorIdentity(redis.error) }, 'redis check failed');
    }
    const healthy = postgres.status === 'ok' && redis.status === 'ok';
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      postgres: postgres.status,
      redis: redis.status,
    });
  });

  void app.register(tradingRoutes, trading);
  void app.register(pairsRoutes, pairs);
  void app.register(authRoutes, auth);
  void app.register(usersRoutes, users);
  void app.register(adminRoutes, admin);

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
    // query template is safe on its own — it holds $1 placeholders, never values. The cause
    // carries the SQLSTATE, which is the whole diagnostic value of a database failure and is
    // absent from the wrapper: drizzle sets neither `name` nor `code` on it.
    request.log.error(
      { ...errorLogFields(error), query: queryOf(error) },
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
