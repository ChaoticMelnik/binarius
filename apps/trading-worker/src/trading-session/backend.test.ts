import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TRADING_PAIRS_PATH,
  TRADING_SIGNAL_PATH,
  safeParsePairsCatalogResponse,
  safeParseTradingSignalResponse,
} from '@binarius/shared';
import { UNIT_WAIT_CEILING_MS } from '@binarius/shared/testing';
import {
  createBackendPairsSource,
  createBackendSignalSource,
  MAX_BACKEND_BODY_BYTES,
} from './backend';
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

const noop = (): void => undefined;

// a body, then whitespace past the ceiling: only a reader that stops at the ceiling refuses it
function overCeiling(res: ServerResponse, status: number, body: string) {
  res.on('error', noop);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.write(body);
  const padding = ' '.repeat(64 * 1024);
  for (let written = 0; written <= MAX_BACKEND_BODY_BYTES; written += padding.length) {
    res.write(padding);
  }
  res.end();
}

// a body that never ends: a reader without a ceiling waits for the client's timeout
function endless(res: ServerResponse, status: number, head: string) {
  res.on('error', noop);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.write(head);
  const chunk = 'x'.repeat(16 * 1024);
  const pump = (): void => {
    while (!res.destroyed && res.write(chunk));
    if (!res.destroyed) res.once('drain', pump);
  };
  pump();
}

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
    reply = (res) => overCeiling(res, 200, JSON.stringify({ outcome: MARKER }));
    failures.push(await signals(60_000).evaluate({ assetId: 101, interval: '1m' }));
    reply = (res) => overCeiling(res, 503, `{"error":"catalog_unavailable","m":"${MARKER}"}`);
    failures.push(await pairs(60_000).read());
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

describe('body size (#234)', () => {
  it('S1 refuses a signal 200 over MAX_BACKEND_BODY_BYTES as a contract violation', async () => {
    reply = (res) => overCeiling(res, 200, JSON.stringify(signalAnswer('up')));
    expect(await signals(60_000).evaluate({ assetId: 101, interval: '1m' })).toEqual({
      ok: false,
      reason: 'contract_violation',
      status: 200,
    });
  });

  it("S2 refuses an endless body on the pairs' own 503 as a contract violation", async () => {
    reply = (res) => endless(res, 503, '{"error":"catalog_unavailable",');
    expect(await pairs(60_000).read()).toEqual({
      ok: false,
      reason: 'contract_violation',
      status: 503,
    });
  }, 2_000);

  it('S3 answers an endless pairs body on another status by the status', async () => {
    reply = (res) => endless(res, 500, '{"error":"internal",');
    expect(await pairs(60_000).read()).toEqual({
      ok: false,
      reason: 'backend_status',
      status: 500,
    });
  }, 2_000);

  // Assumptions in UTF-8 bytes or items, each false on the condition named:
  // the catalog holds at most 300 pairs (the live broker lists 144, docs/broker-rest.md);
  const ASSUMED_LONGEST_PAIRS = 300;
  // a pair's symbol and type: the broker's are short (EUR/USD; the live catalog of 144 pairs);
  // false once the broker sends one longer than 64 bytes. A catalog that grows past the ceiling
  // then fails loudly as contract_violation, not silently.
  const ASSUMED_LONGEST_PAIR_STRING = 64;

  const longestPairs = {
    ...catalog(),
    pairs: Array.from({ length: ASSUMED_LONGEST_PAIRS }, (_, index) =>
      eurUsd({
        id: Number.MAX_SAFE_INTEGER - index,
        symbol: 's'.repeat(ASSUMED_LONGEST_PAIR_STRING),
        type: 't'.repeat(ASSUMED_LONGEST_PAIR_STRING),
      }),
    ),
  };

  it('S4 leaves the longest signal answer far below MAX_BACKEND_BODY_BYTES', () => {
    // numbers and enums only: the decided answer is the longer of the two
    const sample = signalAnswer('up');
    expect(safeParseTradingSignalResponse(sample).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(sample))).toBeLessThan(MAX_BACKEND_BODY_BYTES / 4);
  });

  it('S5 the longest pairs sample passes the parser', () => {
    expect(safeParsePairsCatalogResponse(longestPairs).success).toBe(true);
  });

  it('S6 leaves the longest pairs answer far below MAX_BACKEND_BODY_BYTES', () => {
    expect(Buffer.byteLength(JSON.stringify(longestPairs))).toBeLessThan(
      MAX_BACKEND_BODY_BYTES / 4,
    );
  });
});
