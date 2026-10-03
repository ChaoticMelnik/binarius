import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { TokenField, brokerAccounts, createDb, createTokenCipher } from '@binarius/db';
import { DATABASE_URL_RULES, parseUrlEnv, readEnv } from '@binarius/shared';

// Two authorized GET /v1/broker/user calls for one account, printing each status and the
// x-ratelimit-* headers: whether authorized calls share the per-IP window
// (docs/broker-balance.md → Observed live). The token is decrypted here and never printed.
// Run inside the backend container: ACCOUNT_ID=<broker_accounts.id> pnpm rate-limit-probe

const env = process.env;
const pool = new Pool({
  connectionString: parseUrlEnv(readEnv(env, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES),
});
const accountId = readEnv(env, 'ACCOUNT_ID');
const [row] = await createDb(pool)
  .select()
  .from(brokerAccounts)
  .where(eq(brokerAccounts.id, accountId));
await pool.end();
if (row === undefined) throw new Error(`no broker account ${accountId}`);

const cipher = createTokenCipher({
  keyId: readEnv(env, 'TOKEN_ENCRYPTION_KEY_ID'),
  key: Buffer.from(readEnv(env, 'TOKEN_ENCRYPTION_KEY'), 'base64'),
});
const token = cipher.decrypt(row.accessTokenEnc, { accountId: row.id, field: TokenField.Access });
const url = new URL('/v1/broker/user', readEnv(env, 'BROKER_API_BASE_URL'));

for (const call of [1, 2]) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  const limits = ['limit', 'remaining', 'reset'].map(
    (name) => `${name}=${response.headers.get(`x-ratelimit-${name}`)}`,
  );
  process.stdout.write(`call ${call}: HTTP ${response.status} ${limits.join(' ')}\n`);
}
