import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateTradeIntentRequest, DecimalString } from '@binarius/shared';
import {
  brokerAccounts,
  createTradeIntent,
  findTradeIntent,
  takeIntent,
  tradeIntents,
  users,
} from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import { startSweeper, sweepStaleSubmitting } from './sweeper';

const baseUrl = process.env.DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'DATABASE_URL is required for apps/trading-worker integration tests (see README)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

let seq = 0;
async function submittingIntent(ageMs: number) {
  const n = ++seq;
  const telegramUserId = BigInt(400_000 + n);
  const [user] = await tmp.db
    .insert(users)
    .values({ telegramUserId, tokenBalance: 5n })
    .returning({ id: users.id });
  await tmp.db.insert(brokerAccounts).values({
    userId: user!.id,
    brokerUserId: `broker-${n}`,
    accessTokenEnc: Buffer.from('enc'),
    refreshTokenEnc: Buffer.from('enc'),
    tokenKeyId: 'k1',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
  });
  const request: CreateTradeIntentRequest = {
    telegramUserId: telegramUserId.toString(),
    mode: 'demo',
    assetId: 91,
    amount: '10.00' as DecimalString,
    action: 'up',
    durationSec: 60,
    clientRequestId: `req-${n}`,
  };
  const { intent } = await createTradeIntent(tmp.db, request);
  await takeIntent(tmp.db, { id: intent.id, expectedVersion: intent.version, maxAgeMs: 60_000 });
  await tmp.db
    .update(tradeIntents)
    .set({ submittedAt: sql`now() - (${ageMs}::int * interval '1 millisecond')` })
    .where(eq(tradeIntents.id, intent.id));
  return intent.id;
}

describe('sweepStaleSubmitting', () => {
  it('moves only intents submitting longer than the threshold', async () => {
    const stale = await submittingIntent(120_000);
    const fresh = await submittingIntent(1_000);
    expect(await sweepStaleSubmitting(tmp.db, { olderThanMs: 60_000, limit: 10 })).toBe(1);
    expect(await findTradeIntent(tmp.db, stale)).toMatchObject({
      status: 'unknown',
      lastError: 'stale_submitting',
    });
    expect((await findTradeIntent(tmp.db, fresh))?.status).toBe('submitting');
    expect(await sweepStaleSubmitting(tmp.db, { olderThanMs: 60_000, limit: 10 })).toBe(0);
  });

  it('runs on its interval until stopped', async () => {
    const stale = await submittingIntent(120_000);
    const sweeper = startSweeper({
      db: tmp.db,
      logger: pino({ level: 'silent' }),
      intervalMs: 20,
      olderThanMs: 60_000,
      limit: 10,
    });
    try {
      const deadline = Date.now() + 2_000;
      while (
        (await findTradeIntent(tmp.db, stale))?.status !== 'unknown' &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await findTradeIntent(tmp.db, stale))?.status).toBe('unknown');
    } finally {
      sweeper.stop();
    }
  });
});
