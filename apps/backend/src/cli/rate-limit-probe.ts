import { Pool } from 'pg';
import { pino } from 'pino';
import * as z from 'zod';
import { createDb, createTokenCipher } from '@binarius/db';
import { logOptions, readEnv } from '@binarius/shared';
import { ensureFreshAccessToken } from '../auth/token-service';
import { createBrokerOAuthClient } from '../broker/oauth-client';
import { parseEnv } from '../env';

// Two authorized GET /v1/broker/user calls for one account, printing each status and the
// x-ratelimit-* headers: whether authorized calls share the per-IP window
// (docs/broker-balance.md → Observed live). The token comes from ensureFreshAccessToken with
// mayRefresh: false, so an account that is not active, of a blocked user, or whose token needs an
// exchange is refused, and nothing is ever exchanged. The token is never printed.
// Run inside the backend container: ACCOUNT_ID=<broker_accounts.id> pnpm rate-limit-probe

const env = parseEnv(process.env);
const accountId = z.uuid().parse(readEnv(process.env, 'ACCOUNT_ID'));
const pool = new Pool({ connectionString: env.databaseUrl });

try {
  const token = await ensureFreshAccessToken(
    {
      db: createDb(pool),
      broker: createBrokerOAuthClient({
        baseUrl: env.brokerApiBaseUrl,
        clientId: env.brokerClientId,
        clientSecret: env.brokerClientSecret,
      }),
      cipher: createTokenCipher({ keyId: env.tokenEncryptionKeyId, key: env.tokenEncryptionKey }),
      logger: pino(logOptions(env.logLevel)),
    },
    accountId,
    { mayRefresh: false },
  );
  if (!token.ok) {
    const hint =
      token.reason === 'refresh_needed' ? ' (open the bot balance once, then retry)' : '';
    process.stderr.write(`refused: ${token.reason}${hint}\n`);
    process.exitCode = 1;
  } else {
    const url = new URL('/v1/broker/user', env.brokerApiBaseUrl);
    for (const call of [1, 2]) {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token.accessToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      const limits = ['limit', 'remaining', 'reset'].map(
        (name) => `${name}=${response.headers.get(`x-ratelimit-${name}`)}`,
      );
      process.stdout.write(`call ${call}: HTTP ${response.status} ${limits.join(' ')}\n`);
    }
  }
} finally {
  await pool.end();
}
