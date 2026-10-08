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
import { runProbe } from './socket-probe-run';
import { renderVerdict, verdict } from './socket-probe-verdict';

// The two-socket probe (#285, docs/broker-socket.md -> Observed live): does the live broker send
// an open_trade answer only to the socket that sent the command? The verdict line on stdout, exit
// 0 only on the safe verdict; everything else, pino included, on stderr. The token is taken with
// mayRefresh: false (never an exchange). The demo trades it opens bypass the intent pipeline and
// the trading switch: an operator's probe, not_ours for the catch-up and the reconciler.
//
// docker compose exec -T -e ACCOUNT_ID=REPLACE_WITH_ID -e BROKER_WS_URL=https://broker-ws.binodex.app \
//   trading-worker pnpm --filter @binarius/trading-worker socket-probe
const EXIT_SAFE = 0;
const EXIT_NOT_SAFE = 1;

const READY_TIMEOUT_MS = 15_000;
// the client taints its connection on an abort, so a later command on it is not_sent
const COMMAND_TIMEOUT_MS = 10_000;
const PROBE_WINDOW_MS = 15_000;

interface ProbeEnv {
  brokerWsUrl: string;
  backendUrl: string;
  internalApiToken: string;
  databaseUrl: string;
  brokerApiBaseUrl: string;
  accountId: string;
  logLevel: LogLevel;
}

function parseProbeEnv(source: NodeJS.ProcessEnv): ProbeEnv {
  const accountId = readEnv(source, 'ACCOUNT_ID');
  if (!UUID_PATTERN.test(accountId)) {
    throw new Error('Env ACCOUNT_ID must be a broker_accounts.id (uuid)');
  }
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
  };
}

export async function runSocketProbeCli(
  source: NodeJS.ProcessEnv,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  let env: ProbeEnv;
  try {
    env = parseProbeEnv(source);
  } catch (error) {
    // our own env messages name the variable, never its value
    err(`setup failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_NOT_SAFE;
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
      return EXIT_NOT_SAFE;
    }
    const token = await createBackendAccessTokenSource({
      baseUrl: env.backendUrl,
      token: env.internalApiToken,
    }).accessToken(env.accountId, { mayRefresh: false });
    if (!token.ok) {
      const status = token.status === undefined ? '' : ` ${token.status}`;
      err(`setup failed: token unavailable: ${token.reason}${status}`);
      return EXIT_NOT_SAFE;
    }

    const run = await runProbe({
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
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      say: err,
      timing: {
        readyTimeoutMs: READY_TIMEOUT_MS,
        commandTimeoutMs: COMMAND_TIMEOUT_MS,
        windowMs: PROBE_WINDOW_MS,
      },
    });
    if (run.kind === 'setup_failed') {
      err(`setup failed: ${run.what}`);
      return EXIT_NOT_SAFE;
    }
    const result = verdict(run.input);
    out(renderVerdict(result));
    return result.kind === 'sender_only' ? EXIT_SAFE : EXIT_NOT_SAFE;
  } catch (error) {
    // name and code only (Rule 8): a message may carry a URL
    err(`setup failed: ${formatFailure(error)}`);
    return EXIT_NOT_SAFE;
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
  const code = await runSocketProbeCli(
    process.env,
    (line) => process.stdout.write(`${line}\n`),
    (line) => process.stderr.write(`${line}\n`),
  );
  process.exit(code);
}
