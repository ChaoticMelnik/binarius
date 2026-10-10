import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrokerAccountStatus,
  PostbackRejectReason,
  PostbackSource,
  TokenLedgerKind,
  type PostbackQuery,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  attachDepositsToAccount,
  listRecentPostbackDeliveries,
  readDepositByPayment,
  recordPostback,
  type RecordPostbackResult,
} from './postback-ops';
import { depositEvents, postbackDeliveries, tokenLedger } from './schema/index';
import {
  createTempDatabase,
  lockWaiters,
  seedBrokerAccount,
  seedUser,
  type TempDatabase,
} from './testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

let seq = 0;
// Every key below is the test's own, so rows of one case never meet another's.
const fresh = () => {
  const n = ++seq;
  return { postbackId: `pb-${n}`, paymentId: `pay-${n}`, traderId: `trader-${n}` };
};
const query = (
  keys: { postbackId: string; paymentId: string; traderId: string },
  patch: Record<string, string | undefined> = {},
): PostbackQuery => {
  const full: Record<string, string | undefined> = {
    event: 'deposit',
    id: keys.postbackId,
    payment_id: keys.paymentId,
    a: keys.traderId,
    amount: '10.50',
    coin: 'USD',
    ...patch,
  };
  return Object.fromEntries(
    Object.entries(full).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
};
const record = (q: PostbackQuery) =>
  recordPostback(tmp.db, { source: PostbackSource.Binodex, query: q });

const deliveriesOf = (column: 'postbackId' | 'depositEventId', value: string) =>
  tmp.db
    .select()
    .from(postbackDeliveries)
    .where(eq(postbackDeliveries[column], value))
    .orderBy(postbackDeliveries.createdAt);
const depositsOf = (paymentId: string) =>
  tmp.db.select().from(depositEvents).where(eq(depositEvents.paymentId, paymentId));

async function account(status: BrokerAccountStatus, brokerUserId: string) {
  const user = await seedUser(tmp.db);
  const accountId = await seedBrokerAccount(tmp.db, user.userId, { status, brokerUserId });
  return { ...user, accountId };
}

describe('recordPostback — keys', () => {
  it('P1 records a postback id once: the repeat writes nothing and answers duplicate', async () => {
    const keys = fresh();
    const first = await record(query(keys));
    const second = await record(query(keys));

    expect(first).toMatchObject({ outcome: 'recorded', postbackId: keys.postbackId });
    expect(second).toEqual({ outcome: 'duplicate', postbackId: keys.postbackId, event: 'deposit' });
    expect(await deliveriesOf('postbackId', keys.postbackId)).toHaveLength(1);
    const deposits = await depositsOf(keys.paymentId);
    expect(deposits).toHaveLength(1);
    expect(deposits[0]).toMatchObject({
      source: 'binodex',
      brokerUserId: keys.traderId,
      amount: '10.50000000',
      currency: 'USD',
      status: 'received',
      userId: null,
      brokerAccountId: null,
    });
  });

  it('P1 answers duplicate for a recorded postback id that names another payment, writing nothing', async () => {
    const keys = fresh();
    await record(query(keys));
    const other = fresh();

    expect(await record(query({ ...other, postbackId: keys.postbackId }))).toMatchObject({
      outcome: 'duplicate',
    });
    expect(await depositsOf(other.paymentId)).toEqual([]);
  });

  it('P2 keeps one deposit for the Deposit and the FTD postback of one payment, and one bonus for it', async () => {
    const keys = fresh();
    const owner = await account(BrokerAccountStatus.Active, keys.traderId);
    const deposit = await record(query(keys));
    const ftd = await record(
      query({ ...keys, postbackId: `${keys.postbackId}-ftd` }, { event: 'ftd' }),
    );

    expect(deposit).toMatchObject({ outcome: 'recorded' });
    expect(ftd).toEqual({
      outcome: 'repeated',
      postbackId: `${keys.postbackId}-ftd`,
      event: 'ftd',
      depositEventId: (deposit as { depositEventId: string }).depositEventId,
    });
    const [row] = await depositsOf(keys.paymentId);
    const journal = await deliveriesOf('depositEventId', row!.id);
    expect(journal.map((d) => [d.event, d.outcome])).toEqual([
      ['deposit', 'recorded'],
      ['ftd', 'repeated'],
    ]);

    // the ledger's own key: one bonus per deposit, whatever #386 writes later
    const bonus = {
      userId: owner.userId,
      kind: TokenLedgerKind.Bonus,
      balanceDelta: 1n,
      depositEventId: row!.id,
    };
    await tmp.db.insert(tokenLedger).values(bonus);
    const refused = await tmp.db
      .insert(tokenLedger)
      .values(bonus)
      .then(
        () => undefined,
        (error: unknown) => (error as { cause?: unknown }).cause,
      );
    expect(refused).toMatchObject({ code: '23505', constraint: 'token_ledger_deposit_event_idx' });
  });

  // Both deliveries name one trader whose account another transaction holds FOR NO KEY UPDATE:
  // each passes the journal pre-check, then queues on the account's FOR SHARE, and the release
  // lets both write at once — the race the unique indexes, not the pre-check, have to settle.
  async function lockstep(traderId: string, both: () => Promise<RecordPostbackResult>[]) {
    const owner = await account(BrokerAccountStatus.Active, traderId);
    const client = await tmp.pool.connect();
    try {
      await client.query('begin');
      await client.query('select 1 from broker_accounts where id = $1 for no key update', [
        owner.accountId,
      ]);
      const pending = Promise.all(both());
      await until(
        'both deliveries to wait on the held account',
        async () => (await lockWaiters(tmp.db)) >= 2,
      );
      await client.query('commit');
      return await pending;
    } finally {
      client.release();
    }
  }

  it('P3 two concurrent deliveries of one payment with different ids make one deposit and two journal rows', async () => {
    const keys = fresh();
    const results = await lockstep(keys.traderId, () => [
      record(query(keys)),
      record(query({ ...keys, postbackId: `${keys.postbackId}-b` }, { event: 'ftd' })),
    ]);

    expect(results.map((r) => r.outcome).sort()).toEqual(['recorded', 'repeated']);
    const deposits = await depositsOf(keys.paymentId);
    expect(deposits).toHaveLength(1);
    expect(await deliveriesOf('depositEventId', deposits[0]!.id)).toHaveLength(2);
  });

  it('P3 two concurrent deliveries of one postback id make one deposit and one journal row', async () => {
    const keys = fresh();
    const results = await lockstep(keys.traderId, () => [record(query(keys)), record(query(keys))]);

    expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate', 'recorded']);
    expect(await depositsOf(keys.paymentId)).toHaveLength(1);
    expect(await deliveriesOf('postbackId', keys.postbackId)).toHaveLength(1);
  });

  it('P3 a concurrent twin of a postback id with another payment leaves no deposit behind', async () => {
    const keys = fresh();
    const other = { ...fresh(), postbackId: keys.postbackId, traderId: keys.traderId };
    const results = await lockstep(keys.traderId, () => [
      record(query(keys)),
      record(query(other)),
    ]);

    expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate', 'recorded']);
    const left = [...(await depositsOf(keys.paymentId)), ...(await depositsOf(other.paymentId))];
    expect(left).toHaveLength(1);
    expect(await deliveriesOf('postbackId', keys.postbackId)).toHaveLength(1);
  });
});

describe('recordPostback — attribution', () => {
  it.each([
    [BrokerAccountStatus.Active, true],
    [BrokerAccountStatus.Revoked, true],
    [BrokerAccountStatus.Pending, false],
  ])(
    'P4 a deposit of a trader whose account is %s is attributed: %s',
    async (status, attributed) => {
      const keys = fresh();
      const owner = await account(status, keys.traderId);

      const result = await record(query(keys));

      expect(result).toMatchObject({ outcome: 'recorded', attributed });
      const [row] = await depositsOf(keys.paymentId);
      expect(row).toMatchObject(
        attributed
          ? { userId: owner.userId, brokerAccountId: owner.accountId, brokerUserId: keys.traderId }
          : { userId: null, brokerAccountId: null, brokerUserId: keys.traderId },
      );
    },
  );

  it('P4 a deposit of an unknown trader is stored without an owner', async () => {
    const keys = fresh();
    expect(await record(query(keys))).toMatchObject({ outcome: 'recorded', attributed: false });
  });

  // a confirm holds the account FOR NO KEY UPDATE; the ingest's FOR SHARE waits for it and then
  // reads the committed status
  it('P5 waits for an activation in flight and attributes after its commit', async () => {
    const keys = fresh();
    const owner = await account(BrokerAccountStatus.Pending, keys.traderId);
    const client = await tmp.pool.connect();
    try {
      await client.query('begin');
      await client.query('select 1 from broker_accounts where id = $1 for no key update', [
        owner.accountId,
      ]);
      let settled = false;
      const ingest = record(query(keys)).finally(() => {
        settled = true;
      });
      await until(
        'the ingest to wait on the held account',
        async () => (await lockWaiters(tmp.db)) > 0,
      );
      expect(settled).toBe(false);
      await client.query(`update broker_accounts set status = 'active' where id = $1`, [
        owner.accountId,
      ]);
      await client.query('commit');
      expect(await ingest).toMatchObject({ outcome: 'recorded', attributed: true });
    } finally {
      client.release();
    }
    expect((await depositsOf(keys.paymentId))[0]).toMatchObject({ userId: owner.userId });
  });
});

describe('recordPostback — refusals', () => {
  it.each([
    [PostbackRejectReason.MissingPostbackId, { id: undefined }],
    [PostbackRejectReason.UnknownEvent, { event: 'withdrawal' }],
    [PostbackRejectReason.MissingPaymentId, { payment_id: '' }],
    [PostbackRejectReason.MissingTraderId, { a: undefined }],
    [PostbackRejectReason.InvalidAmount, { amount: '1,000' }],
  ])('P6 journals a delivery refused for %s, with no deposit', async (reason, patch) => {
    const keys = fresh();
    const marker = `marker-${keys.postbackId}`;
    const q = query(keys, { ...patch, sub_id: marker });

    expect(await record(q)).toMatchObject({ outcome: 'rejected', reason });

    const rows = await tmp.db
      .select()
      .from(postbackDeliveries)
      .where(sql`${postbackDeliveries.payload} ->> 'sub_id' = ${marker}`);
    const missingId = reason === PostbackRejectReason.MissingPostbackId;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'rejected',
      rejectReason: reason,
      depositEventId: null,
      postbackId: missingId ? null : keys.postbackId,
      payload: q,
    });
    expect(await depositsOf(keys.paymentId)).toEqual([]);
  });

  it('P6 lets a refused id be recorded by its corrected re-send', async () => {
    const keys = fresh();
    expect(await record(query(keys, { amount: '1e5' }))).toMatchObject({ outcome: 'rejected' });
    expect(await record(query(keys, { amount: '1e5' }))).toMatchObject({ outcome: 'rejected' });
    expect(await record(query(keys))).toMatchObject({ outcome: 'recorded' });
    expect((await deliveriesOf('postbackId', keys.postbackId)).map((d) => d.outcome)).toEqual([
      'rejected',
      'rejected',
      'recorded',
    ]);
  });
});

describe('recordPostback — a repeat that disagrees', () => {
  it.each([
    ['neither', {}, undefined],
    ['the same amount in another spelling', { amount: '10.5000' }, undefined],
    ['the amount', { amount: '11' }, { amount: true }],
    ['the trader', { a: 'someone-else' }, { traderId: true }],
    ['both', { amount: '11', a: 'someone-else' }, { amount: true, traderId: true }],
  ])('P7 names %s and keeps the stored row', async (_label, patch, mismatch) => {
    const keys = fresh();
    await record(query(keys));
    const [before] = await depositsOf(keys.paymentId);

    const result = await record(query({ ...keys, postbackId: `${keys.postbackId}-r` }, patch));

    expect(result).toMatchObject({ outcome: 'repeated' });
    expect((result as { mismatch?: unknown }).mismatch).toEqual(mismatch);
    expect(await depositsOf(keys.paymentId)).toEqual([before]);
  });
});

describe('attachDepositsToAccount', () => {
  it("attaches only the trader's unowned deposits, once", async () => {
    const mine = fresh();
    const theirs = fresh();
    await record(query(mine));
    await record(query(theirs));
    const owner = await account(BrokerAccountStatus.Active, mine.traderId);

    const attach = () =>
      tmp.db.transaction((tx) =>
        attachDepositsToAccount(tx, {
          accountId: owner.accountId,
          userId: owner.userId,
          brokerUserId: mine.traderId,
        }),
      );
    // xmin moves on every UPDATE of the row, even one that writes the same values
    const version = async () => {
      const { rows } = await tmp.db.execute<{ xmin: string }>(
        sql`select xmin::text as xmin from deposit_events where payment_id = ${mine.paymentId}`,
      );
      return rows[0]?.xmin;
    };
    await attach();
    expect((await depositsOf(mine.paymentId))[0]).toMatchObject({
      userId: owner.userId,
      brokerAccountId: owner.accountId,
    });
    const attached = await version();
    await attach();
    expect(await version()).toBe(attached);
    expect((await depositsOf(theirs.paymentId))[0]).toMatchObject({ userId: null });
  });
});

describe('the readers', () => {
  it('lists the journal newest first, refusals included', async () => {
    const keys = fresh();
    await record(query(keys, { amount: 'x' }));
    await record(query(keys));

    const rows = await listRecentPostbackDeliveries(tmp.db, 2);
    expect(rows.map((r) => [r.postbackId, r.outcome])).toEqual([
      [keys.postbackId, 'recorded'],
      [keys.postbackId, 'rejected'],
    ]);
  });

  it('reads a payment with its deliveries and the refused ones that named it', async () => {
    const keys = fresh();
    const owner = await account(BrokerAccountStatus.Active, keys.traderId);
    await record(query(keys, { a: '' }));
    await record(query(keys));
    await record(query({ ...keys, postbackId: `${keys.postbackId}-ftd` }, { event: 'ftd' }));

    const read = await readDepositByPayment(tmp.db, {
      source: PostbackSource.Binodex,
      paymentId: keys.paymentId,
    });
    expect(read.deposit).toMatchObject({
      brokerUserId: keys.traderId,
      amount: '10.50000000',
      brokerAccountId: owner.accountId,
      telegramUserId: BigInt(owner.telegramUserId),
    });
    expect(read.deliveries.map((d) => [d.event, d.outcome])).toEqual([
      ['deposit', 'rejected'],
      ['deposit', 'recorded'],
      ['ftd', 'repeated'],
    ]);
    expect(
      await readDepositByPayment(tmp.db, { source: PostbackSource.Binodex, paymentId: 'nope' }),
    ).toEqual({ deposit: undefined, deliveries: [] });
  });
});
