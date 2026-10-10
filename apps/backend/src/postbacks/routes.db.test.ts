import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTBACK_URL_SECRET_MAX_LENGTH, postbackResponseSchema } from '@binarius/shared';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import { depositEvents, postbackDeliveries } from '@binarius/db';
import { buildApp } from '../app';
import { unusedAdminDeps } from '../admin/testing';
import {
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSignalDeps,
  unusedSessionDeps,
  unusedSignalsDeps,
} from '../trading/testing';
import type { PostbackRoutesDeps } from './routes';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

const TOKEN = 'internal-token-for-tests';
const SECRET = 's3cret-postback-path-segment-0123456789';
let tmp: TempDatabase;
let app: ReturnType<typeof buildApp>;

const lines: Record<string, unknown>[] = [];
const sink = { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) };
const linesOf = (msg: string) => lines.filter((line) => line.msg === msg);

const testApp = (postbacks: Omit<PostbackRoutesDeps, 'db'> | undefined) =>
  buildApp({
    pairs: unusedPairsDeps(),
    sessions: unusedSessionDeps(),
    signal: unusedSignalDeps(),
    signals: unusedSignalsDeps(),
    admin: unusedAdminDeps(),
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: 'trace',
    logDestination: sink,
    checkTimeoutMs: 20,
    trading: {
      db: tmp.db,
      internalApiToken: TOKEN,
      onIntentQueued: () => {},
      balance: unusedBalanceDeps(),
      accessToken: unusedAccessTokenDeps(),
      demoOnly: false,
    },
    auth: {
      db: tmp.db,
      cipher: {} as never,
      broker: {} as never,
      internalApiToken: TOKEN,
      authorizeUrl: 'https://binodex.app/oauth/authorize',
      clientId: 'client-id',
      redirectUri: 'https://bot.example/oauth/callback',
      partnerRef: 'partner-ref',
      clientPush: {} as never,
      initDataVerifier: {} as never,
    },
    users: { db: tmp.db, internalApiToken: TOKEN },
    ...(postbacks === undefined ? {} : { postbacks: { db: tmp.db, ...postbacks } }),
  });

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  app = testApp({ secret: SECRET });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await tmp.drop();
});

let seq = 0;
const fresh = () => {
  const n = ++seq;
  return { id: `route-pb-${n}`, payment_id: `route-pay-${n}`, a: `route-trader-${n}` };
};
const deliveryUrl = (
  keys: { id: string; payment_id: string; a: string },
  patch: Record<string, string> = {},
  secret = SECRET,
) =>
  `/postbacks/binodex/${secret}?${new URLSearchParams({
    event: 'deposit',
    amount: '10.50',
    coin: 'USD',
    ...keys,
    ...patch,
  }).toString()}`;
const get = (url: string, target = app) => target.inject({ method: 'GET', url });
const rowsFor = async (paymentId: string) => ({
  deliveries: await tmp.db
    .select()
    .from(postbackDeliveries)
    .where(sql`${postbackDeliveries.payload} ->> 'payment_id' = ${paymentId}`),
  deposits: await tmp.db.select().from(depositEvents).where(eq(depositEvents.paymentId, paymentId)),
});

describe('GET /postbacks/binodex/:secret', () => {
  it('records a delivery and answers each outcome with 200', async () => {
    const keys = fresh();

    const recorded = await get(deliveryUrl(keys));
    const duplicate = await get(deliveryUrl(keys));
    const repeated = await get(deliveryUrl({ ...keys, id: `${keys.id}-ftd` }, { event: 'ftd' }));
    const rejected = await get(deliveryUrl({ ...keys, id: `${keys.id}-bad` }, { amount: '1e5' }));

    expect(
      [recorded, duplicate, repeated, rejected].map((r) => [r.statusCode, r.json<unknown>()]),
    ).toEqual([
      [200, { outcome: 'recorded' }],
      [200, { outcome: 'duplicate' }],
      [200, { outcome: 'repeated' }],
      [200, { outcome: 'rejected', reason: 'invalid_amount' }],
    ]);
    for (const response of [recorded, duplicate, repeated, rejected]) {
      expect(postbackResponseSchema.safeParse(response.json()).success).toBe(true);
    }
    const rows = await rowsFor(keys.payment_id);
    expect(rows.deposits).toHaveLength(1);
    expect(rows.deliveries.map((d) => d.outcome).sort()).toEqual([
      'recorded',
      'rejected',
      'repeated',
    ]);
  });

  it('logs one line per delivery with the outcome, never the secret or the url', async () => {
    const keys = fresh();
    lines.length = 0;

    await get(deliveryUrl(keys));

    expect(linesOf('postback received')).toEqual([
      expect.objectContaining({
        level: 30,
        outcome: 'recorded',
        event: 'deposit',
        postbackId: keys.id,
      }),
    ]);
    const text = JSON.stringify(lines);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('/postbacks/redacted?');
  });

  // the router decodes escapes in static segments, so this spelling reaches the route
  it('records a delivery through a percent-encoded prefix and keeps the secret out of the log', async () => {
    const keys = fresh();
    lines.length = 0;

    const response = await get(deliveryUrl(keys).replace('/postbacks/', '/p%6Fstbacks/'));

    expect([response.statusCode, response.json<unknown>()]).toEqual([200, { outcome: 'recorded' }]);
    const requestLines = lines.filter((line) => line.req !== undefined);
    expect(requestLines.length).toBeGreaterThan(0);
    expect(JSON.stringify(requestLines)).toContain('/postbacks/redacted?');
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('warns about a repeat that disagrees, by field name only', async () => {
    const keys = fresh();
    await get(deliveryUrl(keys));
    lines.length = 0;

    const response = await get(
      deliveryUrl({ ...keys, id: `${keys.id}-ftd` }, { event: 'ftd', amount: '987.65' }),
    );

    expect(response.json()).toEqual({ outcome: 'repeated' });
    const [deposit] = (await rowsFor(keys.payment_id)).deposits;
    const warned = linesOf('postback repeated with different fields');
    expect(warned).toEqual([
      expect.objectContaining({
        level: 40,
        depositEventId: deposit!.id,
        postbackId: `${keys.id}-ftd`,
        mismatch: ['amount'],
      }),
    ]);
    expect(JSON.stringify(warned)).not.toContain('987.65');
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it.each([
    ['a wrong secret', `${SECRET}x`],
    ['a short secret', 'abc'],
  ])('answers %s with the not-found body and writes nothing', async (_label, secret) => {
    const keys = fresh();
    lines.length = 0;

    const response = await get(deliveryUrl(keys, {}, secret));

    expect([response.statusCode, response.json<unknown>()]).toEqual([404, { error: 'not_found' }]);
    expect(await rowsFor(keys.payment_id)).toEqual({ deliveries: [], deposits: [] });
    expect(linesOf('postback refused')).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(secret);
  });

  it('refuses a repeated query key with 400 and journals nothing', async () => {
    const keys = fresh();
    const response = await get(`${deliveryUrl(keys)}&a=second`);

    expect([response.statusCode, response.json<unknown>()]).toEqual([400, { error: 'validation' }]);
    expect(await rowsFor(keys.payment_id)).toEqual({ deliveries: [], deposits: [] });
  });

  it('answers HEAD with the right secret through the not-found handler and writes nothing', async () => {
    const keys = fresh();
    lines.length = 0;

    const response = await app.inject({ method: 'HEAD', url: deliveryUrl(keys) });

    expect(response.statusCode).toBe(404);
    expect(await rowsFor(keys.payment_id)).toEqual({ deliveries: [], deposits: [] });
    const notFound = linesOf('route not found');
    expect(notFound).toHaveLength(1);
    expect(notFound[0]!.url).toContain('/postbacks/redacted?');
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('refuses a NUL in the query with 400, not a 500, and journals nothing', async () => {
    const keys = fresh();
    const response = await get(`${deliveryUrl(keys)}&sub_id=a%00b`);

    expect([response.statusCode, response.json<unknown>()]).toEqual([400, { error: 'validation' }]);
    expect(await rowsFor(keys.payment_id)).toEqual({ deliveries: [], deposits: [] });
  });

  // D7': wrong secrets take no slot, so a probe cannot crowd out the broker's deliveries
  it('counts the window only past the secret', async () => {
    const limited = testApp({ secret: SECRET, maxPerMinute: 2 });
    await limited.ready();
    try {
      const statuses = [];
      for (let i = 0; i < 5; i += 1)
        statuses.push((await get(deliveryUrl(fresh(), {}, `${SECRET}x`), limited)).statusCode);
      const third = fresh();
      for (const keys of [fresh(), fresh(), third])
        statuses.push((await get(deliveryUrl(keys), limited)).statusCode);

      expect(statuses).toEqual([404, 404, 404, 404, 404, 200, 200, 429]);
      expect(await rowsFor(third.payment_id)).toEqual({ deliveries: [], deposits: [] });
    } finally {
      await limited.close();
    }
  });

  it('records a delivery through a secret of the maximum length', async () => {
    const longest = 'L'.repeat(POSTBACK_URL_SECRET_MAX_LENGTH);
    const long = testApp({ secret: longest });
    await long.ready();
    try {
      const keys = fresh();
      const response = await get(deliveryUrl(keys, {}, longest), long);

      expect([response.statusCode, response.json<unknown>()]).toEqual([
        200,
        { outcome: 'recorded' },
      ]);
      expect((await rowsFor(keys.payment_id)).deposits).toHaveLength(1);
    } finally {
      await long.close();
    }
  });
});

// Fastify's router answers an overlong (414) or malformed (400) segment itself, echoing the path;
// frameworkErrors turns both into the not-found answer, the same whether the route is on or off
describe('router-level answers, route on and off', () => {
  const overlong = 'o'.repeat(POSTBACK_URL_SECRET_MAX_LENGTH + 1);
  const malformed = `${'m'.repeat(40)}%ZZ`;

  it.each([
    // a path that cannot be decoded is masked whole
    ['an overlong segment', overlong, '/postbacks/redacted?'],
    ['a malformed segment', malformed, '/redacted?'],
  ])('answers %s with the not-found 404, on and off alike', async (_label, segment, logged) => {
    const off = testApp(undefined);
    await off.ready();
    try {
      for (const target of [app, off]) {
        const keys = fresh();
        lines.length = 0;

        const response = await get(deliveryUrl(keys, {}, segment), target);

        expect([response.statusCode, response.body]).toEqual([404, '{"error":"not_found"}']);
        expect(await rowsFor(keys.payment_id)).toEqual({ deliveries: [], deposits: [] });
        const notFound = linesOf('route not found');
        expect(notFound).toHaveLength(1);
        expect(notFound[0]!.url).toMatch(new RegExp(`^${logged.replace('?', '\\?')}`));
        expect(JSON.stringify(lines)).not.toContain(segment.slice(0, 40));
      }
    } finally {
      await off.close();
    }
  });
});

describe('without POSTBACK_URL_SECRET', () => {
  it('has no route: the right path answers 404 and its log line masks the segment', async () => {
    const off = testApp(undefined);
    await off.ready();
    try {
      const keys = fresh();
      lines.length = 0;

      const response = await get(deliveryUrl(keys), off);

      expect([response.statusCode, response.json<unknown>()]).toEqual([
        404,
        { error: 'not_found' },
      ]);
      expect(await rowsFor(keys.payment_id)).toEqual({ deliveries: [], deposits: [] });
      const notFound = linesOf('route not found');
      expect(notFound).toHaveLength(1);
      expect(notFound[0]!.url).toContain('/postbacks/redacted?');
      expect(JSON.stringify(lines)).not.toContain(SECRET);
    } finally {
      await off.close();
    }
  });
});
