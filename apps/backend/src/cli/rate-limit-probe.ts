import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { pino } from 'pino';
import { createDb, createTokenCipher } from '@binarius/db';
import { AccessTokenRefusal, logOptions, type EnvSource } from '@binarius/shared';
import {
  ensureFreshAccessToken,
  type AccessTokenOptions,
  type AccessTokenResult,
} from '../auth/token-service';
import { createBrokerOAuthClient } from '../broker/oauth-client';
import { formatFailure } from './kill-switch';
import { readProbeEnv } from './probe-env';

// Two authorized GET /v1/broker/user calls for one account, printing each status and the
// x-ratelimit-* headers: whether authorized calls share the per-IP window
// (docs/broker-balance.md → Observed live). The token comes from ensureFreshAccessToken with
// mayRefresh: false, so an account that is not active, of a blocked user, or whose token needs an
// exchange is refused, and nothing is ever exchanged. The token is never printed.
// Run inside the backend container, with REPLACE_WITH_ID substituted by the broker_accounts.id
// uuid: ACCOUNT_ID=REPLACE_WITH_ID pnpm rate-limit-probe
const EXIT_OK = 0;
const EXIT_FAILED = 1;

export interface ProbeIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface RateLimitProbeInput {
  accountId: string;
  brokerApiBaseUrl: string;
  accessToken: (accountId: string, options: AccessTokenOptions) => Promise<AccessTokenResult>;
}

export async function runRateLimitProbe(
  { accountId, brokerApiBaseUrl, accessToken }: RateLimitProbeInput,
  { out, err }: ProbeIo,
): Promise<number> {
  try {
    const token = await accessToken(accountId, { mayRefresh: false });
    if (!token.ok) {
      const hint =
        token.reason === AccessTokenRefusal.RefreshNeeded
          ? ' (open the bot balance once, then retry)'
          : '';
      err(`refused: ${token.reason}${hint}`);
      return EXIT_FAILED;
    }
    const url = new URL('/v1/broker/user', brokerApiBaseUrl);
    for (const call of [1, 2]) {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token.accessToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      const limits = ['limit', 'remaining', 'reset'].map(
        (name) => `${name}=${response.headers.get(`x-ratelimit-${name}`)}`,
      );
      out(`call ${call}: HTTP ${response.status} ${limits.join(' ')}`);
    }
    return EXIT_OK;
  } catch (error) {
    // name and code only (Rule 8): a database error's message carries the query, a fetch
    // error's the host
    err(`failed: ${formatFailure(error)}`);
    return EXIT_FAILED;
  }
}

export async function rateLimitProbeMain(source: EnvSource, io: ProbeIo): Promise<number> {
  let probeEnv: ReturnType<typeof readProbeEnv>;
  try {
    probeEnv = readProbeEnv(source);
  } catch (error) {
    // our own env messages name the variable, never its value
    io.err(`failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
  const { env, accountId } = probeEnv;
  let pool: Pool | undefined;
  try {
    return await runRateLimitProbe(
      {
        accountId,
        brokerApiBaseUrl: env.brokerApiBaseUrl,
        accessToken: (id, options) => {
          pool = new Pool({ connectionString: env.databaseUrl });
          const deps = {
            db: createDb(pool),
            broker: createBrokerOAuthClient({
              baseUrl: env.brokerApiBaseUrl,
              clientId: env.brokerClientId,
              clientSecret: env.brokerClientSecret,
            }),
            cipher: createTokenCipher({
              keyId: env.tokenEncryptionKeyId,
              key: env.tokenEncryptionKey,
            }),
            logger: pino(logOptions(env.logLevel)),
          };
          return ensureFreshAccessToken(deps, id, options);
        },
      },
      io,
    );
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

// The module is imported by its test, so the probe only runs when this file is what node was
// started with.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exit(
    await rateLimitProbeMain(process.env, {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    }),
  );
}
