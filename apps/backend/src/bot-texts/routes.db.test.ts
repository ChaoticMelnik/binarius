import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOT_TEXT_OVERRIDES_MAX,
  BOT_TEXTS_PATH,
  botTextOverridesResponseSchema,
} from '@binarius/shared';
import { createTempDatabase, seedStaff, type TempDatabase } from '@binarius/db/testing';
import { botTextOverrides } from '@binarius/db';
import { botTextsRoutes } from './routes';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

const TOKEN = 'internal-token-for-tests';
let tmp: TempDatabase;
let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  app = Fastify();
  await app.register(botTextsRoutes, { db: tmp.db, internalApiToken: TOKEN });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await tmp.drop();
});

describe('GET /bot-texts', () => {
  it('R1 refuses a caller without the bearer', async () => {
    const response = await app.inject({ method: 'GET', url: BOT_TEXTS_PATH });
    expect(response.statusCode).toBe(401);
  });

  it('R2 answers every row as key, source and version only', async () => {
    const { staffId } = await seedStaff(tmp.db);
    await tmp.db.insert(botTextOverrides).values([
      { key: 'welcome', source: 'Привет', updatedByStaffId: staffId },
      { key: 'renamedKey', source: 'x' },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: BOT_TEXTS_PATH,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(botTextOverridesResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      overrides: [
        { key: 'renamedKey', source: 'x', version: expect.any(Number) },
        { key: 'welcome', source: 'Привет', version: expect.any(Number) },
      ],
    });
  });

  // rows inserted by hand past the wire schema's cap must not stop the bot's refresh (#299 review)
  it('answers at most BOT_TEXT_OVERRIDES_MAX rows, the first by key', async () => {
    await tmp.db.delete(botTextOverrides);
    await tmp.db.insert(botTextOverrides).values(
      Array.from({ length: BOT_TEXT_OVERRIDES_MAX + 1 }, (_, i) => ({
        key: `k${String(i).padStart(4, '0')}`,
        source: 'x',
      })),
    );
    const response = await app.inject({
      method: 'GET',
      url: BOT_TEXTS_PATH,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const { overrides } = botTextOverridesResponseSchema.parse(response.json());
    expect(overrides).toHaveLength(BOT_TEXT_OVERRIDES_MAX);
    expect(overrides.at(-1)?.key).toBe('k0999');
  });
});
