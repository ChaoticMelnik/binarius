import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { pino } from 'pino';
import { createBrokerRestClient } from '@binarius/broker-rest';
import { brokerAccounts, createDb } from '@binarius/db';
import {
  DATABASE_URL_RULES,
  errorLogFields,
  HTTPS_ONLY_RULES,
  logOptions,
  parseBoundedIntegerEnv,
  parseInternalTokenEnv,
  parseLogLevelEnv,
  parseUrlEnv,
  readEnv,
  UUID_PATTERN,
  type LogLevel,
} from '@binarius/shared';
import { createBackendAccessTokenSource } from '../broker/access-token';
import { createBrokerSocketClient, type BrokerSocketClient } from '../broker/socket';
import { BACKEND_URL_RULES, BROKER_WS_URL_RULES } from '../env';
import { runSpike, SPIKE_TIMING, type SpikeDeps, type SpikeRun } from './candle-spike-run';
import { renderReport } from './candle-spike-report';

// The candle spike (#392, docs/broker-socket.md -> The candle spike): candles built from the
// broker's price ticks against its REST candles, on one socket of the operator's account. The
// report on stdout, progress and pino on stderr. The token is taken with mayRefresh: false (never
// an exchange, Rule 12); no trade command is sent and nothing is written to the database.
//
// docker compose exec -T -e ACCOUNT_ID=REPLACE_WITH_ID trading-worker \
//   pnpm --silent --filter @binarius/trading-worker --fail-if-no-match candle-spike > spike-392.md
const EXIT_OK = 0;
const EXIT_FAILED = 1;

// 80 min keeps the 1s fetch (minutes x 60 + 6 rows) under the broker's 5000-row cap
export const MAX_SPIKE_MINUTES = 80;
const MAX_SPIKE_PAIRS = 40;

export interface SpikeEnv {
  brokerWsUrl: string;
  backendUrl: string;
  internalApiToken: string;
  databaseUrl: string;
  brokerApiBaseUrl: string;
  accountId: string;
  logLevel: LogLevel;
  minutes: number;
  pairs: number;
  assetIds?: number[];
  subscribeAll: boolean;
}

function parseAssetIds(raw: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.length > MAX_SPIKE_PAIRS || !parts.every((part) => /^[1-9]\d{0,15}$/.test(part))) {
    throw new Error(
      `Env SPIKE_ASSET_IDS must be 1 to ${MAX_SPIKE_PAIRS} comma-separated positive integers`,
    );
  }
  const ids = parts.map(Number);
  if (!ids.every(Number.isSafeInteger)) {
    throw new Error('Env SPIKE_ASSET_IDS must hold safe integers');
  }
  return ids;
}

export function parseSpikeEnv(source: NodeJS.ProcessEnv): SpikeEnv {
  const accountId = readEnv(source, 'ACCOUNT_ID');
  if (!UUID_PATTERN.test(accountId)) {
    throw new Error('Env ACCOUNT_ID must be a broker_accounts.id (uuid)');
  }
  const subscribeAll = readEnv(source, 'SPIKE_SUBSCRIBE_ALL', '1');
  if (subscribeAll !== '0' && subscribeAll !== '1') {
    throw new Error('Env SPIKE_SUBSCRIBE_ALL must be 0 or 1');
  }
  const assetIds = parseAssetIds(source.SPIKE_ASSET_IDS);
  return {
    brokerWsUrl: parseUrlEnv(
      readEnv(source, 'BROKER_WS_URL'),
      'BROKER_WS_URL',
      BROKER_WS_URL_RULES,
    ),
    backendUrl: parseUrlEnv(readEnv(source, 'BACKEND_URL'), 'BACKEND_URL', BACKEND_URL_RULES),
    internalApiToken: parseInternalTokenEnv(
      readEnv(source, 'INTERNAL_API_TOKEN'),
      'INTERNAL_API_TOKEN',
    ),
    databaseUrl: parseUrlEnv(readEnv(source, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES),
    brokerApiBaseUrl: parseUrlEnv(
      readEnv(source, 'BROKER_API_BASE_URL'),
      'BROKER_API_BASE_URL',
      HTTPS_ONLY_RULES,
    ),
    accountId,
    logLevel: parseLogLevelEnv(readEnv(source, 'LOG_LEVEL', 'info'), 'LOG_LEVEL'),
    minutes: parseBoundedIntegerEnv(
      readEnv(source, 'SPIKE_MINUTES', '30'),
      'SPIKE_MINUTES',
      1,
      MAX_SPIKE_MINUTES,
    ),
    pairs: parseBoundedIntegerEnv(
      readEnv(source, 'SPIKE_PAIRS', '10'),
      'SPIKE_PAIRS',
      1,
      MAX_SPIKE_PAIRS,
    ),
    ...(assetIds === undefined ? {} : { assetIds }),
    subscribeAll: subscribeAll === '1',
  };
}

// 0 only when phase B ran its whole window and at least one candle was compared
export const exitCodeOf = (run: SpikeRun): number =>
  run.kind === 'ran' && run.windowCompleted && run.compared > 0 ? EXIT_OK : EXIT_FAILED;

const abortableSleep = (stop: AbortSignal) => (ms: number) =>
  new Promise<void>((resolve) => {
    if (stop.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      stop.removeEventListener('abort', done);
      resolve();
    }
    stop.addEventListener('abort', done, { once: true });
  });

export async function runCandleSpikeCli(
  source: NodeJS.ProcessEnv,
  out: (line: string) => void,
  err: (line: string) => void,
  stop: AbortSignal = new AbortController().signal,
): Promise<number> {
  let env: SpikeEnv;
  try {
    env = parseSpikeEnv(source);
  } catch (error) {
    // our own env messages name the variable, never its value
    err(`setup failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }

  const logger = pino(logOptions(env.logLevel), process.stderr);
  const pool = new Pool({ connectionString: env.databaseUrl });
  const clients: BrokerSocketClient[] = [];
  try {
    const [account] = await createDb(pool)
      .select({ brokerUserId: brokerAccounts.brokerUserId })
      .from(brokerAccounts)
      .where(eq(brokerAccounts.id, env.accountId));
    if (account === undefined) {
      err('setup failed: no broker account with this ACCOUNT_ID');
      return EXIT_FAILED;
    }
    const token = await createBackendAccessTokenSource({
      baseUrl: env.backendUrl,
      token: env.internalApiToken,
    }).accessToken(env.accountId, { mayRefresh: false });
    if (!token.ok) {
      const status = token.status === undefined ? '' : ` ${token.status}`;
      err(`setup failed: token unavailable: ${token.reason}${status}`);
      return EXIT_FAILED;
    }

    const deps: SpikeDeps = {
      openClient: (label) => {
        const client = createBrokerSocketClient({
          url: env.brokerWsUrl,
          logger: logger.child({ socket: label }),
        });
        clients.push(client);
        return client;
      },
      rest: createBrokerRestClient({ baseUrl: env.brokerApiBaseUrl }),
      credentials: { brokerUserId: account.brokerUserId, accessToken: token.accessToken },
      now: Date.now,
      sleep: abortableSleep(stop),
      say: err,
      sample: () => {
        const cpu = process.cpuUsage();
        return { cpuMicros: cpu.user + cpu.system, rssBytes: process.memoryUsage().rss };
      },
      stop,
      timing: SPIKE_TIMING,
      options: {
        minutes: env.minutes,
        pairs: env.pairs,
        ...(env.assetIds === undefined ? {} : { assetIds: env.assetIds }),
        subscribeAll: env.subscribeAll,
      },
    };
    const run = await runSpike(deps);
    if (run.kind === 'setup_failed') {
      err(`setup failed: ${run.what}`);
      return EXIT_FAILED;
    }
    out(renderReport(run.report));
    return exitCodeOf(run);
  } catch (error) {
    // name and code only (Rule 8): a message may carry a URL
    err(`setup failed: ${formatFailure(error)}`);
    return EXIT_FAILED;
  } finally {
    for (const client of clients) client.stop();
    await pool.end().catch(() => undefined);
  }
}

function formatFailure(error: unknown): string {
  const { err, cause } = errorLogFields(error);
  const one = ({ name, code }: { name: string; code?: string }) =>
    code === undefined ? name : `${name} ${code}`;
  return cause === undefined ? one(err) : `${one(err)} (${one(cause)})`;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const code = await runCandleSpikeCli(
    process.env,
    (line) => process.stdout.write(`${line}\n`),
    (line) => process.stderr.write(`${line}\n`),
    controller.signal,
  );
  process.exit(code);
}
