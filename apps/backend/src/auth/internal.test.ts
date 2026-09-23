import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { internalBearerAuth } from './internal';

const token = 'internal-token-for-tests';
const app = Fastify({ logger: false });

beforeAll(async () => {
  await app.register(async (scope) => {
    scope.addHook('onRequest', internalBearerAuth(token));
    scope.get('/guarded', async () => ({ ok: true }));
  });
  app.get('/open', async () => ({ ok: true }));
  await app.ready();
});
afterAll(() => app.close());

describe('internalBearerAuth', () => {
  it('lets the exact token through', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/guarded',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it.each([
    ['no header', undefined],
    ['wrong scheme', `Basic ${token}`],
    ['wrong token of the same length', `Bearer ${token.replace('tests', 'toast')}`],
    ['prefix only', `Bearer ${token.slice(0, -1)}`],
    ['token plus a suffix', `Bearer ${token}x`],
    ['lowercase scheme', `bearer ${token}`],
    ['empty token', 'Bearer '],
  ])('rejects %s with 401', async (_label, authorization) => {
    const response = await app.inject({
      method: 'GET',
      url: '/guarded',
      headers: authorization === undefined ? {} : { authorization },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('does not touch routes outside the guarded scope', async () => {
    const response = await app.inject({ method: 'GET', url: '/open' });
    expect(response.statusCode).toBe(200);
  });
});
