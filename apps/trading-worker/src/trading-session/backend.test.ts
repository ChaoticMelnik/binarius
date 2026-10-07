import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TRADING_PAIRS_PATH, TRADING_SIGNAL_PATH } from '@binarius/shared';
import { UNIT_WAIT_CEILING_MS } from '@binarius/shared/testing';
import { createBackendPairsSource, createBackendSignalSource } from './backend';
import { eurUsd, fetchFailedAnswer, signalAnswer } from './testing';

const BEARER = 'internal-token-for-tests-0123456789';
const MARKER = 'body-marker-that-must-not-leak';

interface Seen {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let seen: Seen[];
let reply: (res: ServerResponse) => void;

beforeEach(async () => {
  seen = [];
  reply = (res) => json(res, 200, {});
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
      });
      reply(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const text = (status: number, body: string) => (res: ServerResponse) => {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(body);
};

const signals = (timeoutMs?: number) =>
  createBackendSignalSource({ baseUrl, token: BEARER, timeoutMs });
const pairs = (timeoutMs?: number) =>
  createBackendPairsSource({ baseUrl, token: BEARER, timeoutMs });

const catalog = (fresh = true) => ({
  pairs: [eurUsd()],
  fetchedAt: 1_760_000_000_000,
  ageMs: 1_000,
  fresh,
});

describe('createBackendSignalSource (#287)', () => {
  it('B1 posts the asset and the interval with the bearer and answers the response', async () => {
    reply = (res) => json(res, 200, signalAnswer('up'));
    expect(await signals().evaluate({ assetId: 101, interval: '1m' })).toEqual({
      ok: true,
      response: signalAnswer('up'),
    });
    expect(seen).toEqual([
      {
        method: 'POST',
        url: TRADING_SIGNAL_PATH,
        authorization: `Bearer ${BEARER}`,
        body: { assetId: 101, interval: '1m' },
      },
    ]);
  });

  it('B2 passes fetch_failed through as an answer', async () => {
    reply = (res) => json(res, 200, fetchFailedAnswer(7));
    expect(await signals().evaluate({ assetId: 101, interval: '1m' })).toEqual({
      ok: true,
      response: fetchFailedAnswer(7),
    });
  });

  it.each([400, 401, 500, 503])('B3 answers backend_status for HTTP %i', async (status) => {
    reply = (res) => json(res, status, signalAnswer('up'));
    expect(await signals().evaluate({ assetId: 101, interval: '1m' })).toEqual({
      ok: false,
      reason: 'backend_status',
      status,
    });
  });

  it.each([
    ['a body the schema refuses', (res: ServerResponse) => json(res, 200, { outcome: 'decided' })],
    ['a body that is not JSON', text(200, 'not json')],
  ])('B4 answers contract_violation for %s', async (_label, answer) => {
    reply = answer;
    expect(await signals().evaluate({ assetId: 101, interval: '1m' })).toEqual({
      ok: false,
      reason: 'contract_violation',
      status: 200,
    });
  });

  it('B5 answers backend_unreachable when nothing listens, on the timeout and on an abort', async () => {
    const closed = createBackendSignalSource({ baseUrl: 'http://127.0.0.1:1', token: BEARER });
    expect(await closed.evaluate({ assetId: 101, interval: '1m' })).toEqual({
      ok: false,
      reason: 'backend_unreachable',
    });
    reply = () => {};
    expect(await signals(50).evaluate({ assetId: 101, interval: '1m' })).toEqual({
      ok: false,
      reason: 'backend_unreachable',
    });
    // a timeout far past the test's own: only the caller's abort can end the request in time
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = signals(60_000).evaluate(
      { assetId: 101, interval: '1m' },
      { signal: controller.signal },
    );
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: 'backend_unreachable' });
    expect(Date.now() - startedAt).toBeLessThan(UNIT_WAIT_CEILING_MS);
  });

  it('B6 keeps the body, the bearer and the URL out of a failure', async () => {
    const failures = [];
    reply = text(500, MARKER);
    failures.push(await signals().evaluate({ assetId: 101, interval: '1m' }));
    reply = (res) => json(res, 200, { outcome: MARKER });
    failures.push(await signals().evaluate({ assetId: 101, interval: '1m' }));
    reply = text(503, MARKER);
    failures.push(await pairs().read());
    for (const failure of failures) {
      const serialized = JSON.stringify(failure);
      expect(failure.ok).toBe(false);
      expect(serialized).not.toContain(MARKER);
      expect(serialized).not.toContain(BEARER);
      expect(serialized).not.toContain('127.0.0.1');
    }
  });
});

describe('createBackendPairsSource (#287)', () => {
  it('P1 gets the catalog with the bearer and answers it, fresh or not', async () => {
    reply = (res) => json(res, 200, catalog());
    expect(await pairs().read()).toEqual({ ok: true, catalog: catalog() });
    expect(seen).toEqual([
      {
        method: 'GET',
        url: TRADING_PAIRS_PATH,
        authorization: `Bearer ${BEARER}`,
        body: undefined,
      },
    ]);
    reply = (res) => json(res, 200, catalog(false));
    expect(await pairs().read()).toEqual({ ok: true, catalog: catalog(false) });
  });

  it("P2 answers catalog_unavailable for the route's own 503, backend_status for any other", async () => {
    reply = (res) => json(res, 503, { error: 'catalog_unavailable' });
    expect(await pairs().read()).toEqual({ ok: false, reason: 'catalog_unavailable' });
    reply = (res) => json(res, 503, { error: 'other' });
    expect(await pairs().read()).toEqual({ ok: false, reason: 'backend_status', status: 503 });
    reply = (res) => json(res, 401, { error: 'unauthorized' });
    expect(await pairs().read()).toEqual({ ok: false, reason: 'backend_status', status: 401 });
  });

  it('P3 answers contract_violation for a catalog the schema refuses', async () => {
    reply = (res) => json(res, 200, { pairs: [eurUsd()], fetchedAt: 1, ageMs: 0 });
    expect(await pairs().read()).toEqual({
      ok: false,
      reason: 'contract_violation',
      status: 200,
    });
  });

  it('P4 answers backend_unreachable on the timeout and on an abort', async () => {
    reply = () => {};
    expect(await pairs(50).read()).toEqual({ ok: false, reason: 'backend_unreachable' });
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = pairs(60_000).read({ signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: 'backend_unreachable' });
    expect(Date.now() - startedAt).toBeLessThan(UNIT_WAIT_CEILING_MS);
  });
});
