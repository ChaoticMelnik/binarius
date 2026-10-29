import { describe, expect, it } from 'vitest';
import { AccessTokenRefusal } from '@binarius/shared';
import type { AccessTokenResult } from '../auth/token-service';
import { rateLimitProbeMain, runRateLimitProbe } from './rate-limit-probe';

const ACCOUNT_ID = '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01';
const TOKEN = 'probe-access-token-SECRET';
// nothing listens on port 1, so a fetch there fails at once
const CLOSED = 'http://127.0.0.1:1';

async function probe(
  accessToken: () => Promise<AccessTokenResult>,
  brokerApiBaseUrl = CLOSED,
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runRateLimitProbe(
    { accountId: ACCOUNT_ID, brokerApiBaseUrl, accessToken },
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );
  return { code, out, err };
}

// a DrizzleQueryError's shape: the query and its parameters in the message, SQLSTATE in the cause
const databaseFailure = () =>
  new Error('Failed query: select … params: SECRET', {
    cause: Object.assign(new Error('relation "x" does not exist'), {
      name: 'error',
      code: '42P01',
    }),
  });

describe('rate-limit-probe', () => {
  it('R1 tells the owner how to get a fresh token', async () => {
    expect(
      await probe(() => Promise.resolve({ ok: false, reason: AccessTokenRefusal.RefreshNeeded })),
    ).toEqual({
      code: 1,
      out: [],
      err: ['refused: refresh_needed (open the bot balance once, then retry)'],
    });
  });

  it('R2 answers a database failure with its name and code only', async () => {
    const result = await probe(() => Promise.reject(databaseFailure()));

    expect(result).toEqual({ code: 1, out: [], err: ['failed: Error (error 42P01)'] });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('R3 answers a broker that cannot be reached without the token or the host', async () => {
    const result = await probe(() =>
      Promise.resolve({ ok: true, accessToken: TOKEN, brokerUserId: 'broker-user' }),
    );

    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err).toHaveLength(1);
    // the cause undici attaches differs by platform; the name is what is asserted
    expect(result.err[0]).toMatch(/^failed: TypeError/);
    expect(result.err[0]).not.toMatch(/SECRET|127\.0\.0\.1/);
  });

  it('R4 answers a missing ACCOUNT_ID with the variable', async () => {
    const err: string[] = [];
    const code = await rateLimitProbeMain(
      {},
      { out: () => undefined, err: (line) => err.push(line) },
    );

    expect([code, err]).toEqual([1, ['failed: Missing required env ACCOUNT_ID']]);
  });
});
