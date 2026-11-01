import { describe, expect, it, vi } from 'vitest';
import type { BackendClient } from './backend-client';
import { withPairsCache } from './pairs-cache';
import { fakeBackend, PAIRS_RESPONSE, pairsResponse } from './testing';

const TTL_MS = 1_000;

function setup(readPairs: BackendClient['readPairs']) {
  const clock = { at: 0 };
  const read = vi.fn(readPairs);
  const backend = withPairsCache(fakeBackend({ readPairs: read }), {
    ttlMs: TTL_MS,
    now: () => clock.at,
  });
  return { backend, read, clock };
}

describe('withPairsCache (#875)', () => {
  it('PC1 two reads at once are one request and one answer', async () => {
    const { backend, read } = setup(() => Promise.resolve(PAIRS_RESPONSE));
    const [first, second] = await Promise.all([backend.readPairs(), backend.readPairs()]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('PC2 an answer is given again within the TTL without a request', async () => {
    const { backend, read, clock } = setup(() => Promise.resolve(PAIRS_RESPONSE));
    await backend.readPairs();
    clock.at = TTL_MS - 1;
    await backend.readPairs();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('PC3 past the TTL the catalog is read again', async () => {
    const answers = [PAIRS_RESPONSE, pairsResponse({ fresh: false })];
    const { backend, read, clock } = setup(() =>
      Promise.resolve(answers.shift() ?? PAIRS_RESPONSE),
    );
    await backend.readPairs();
    clock.at = TTL_MS;
    expect((await backend.readPairs()).fresh).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('PC4 a failure is not kept: callers at once share it, the next call reads again', async () => {
    let fail = true;
    const { backend, read } = setup(() =>
      fail ? Promise.reject(new Error('unreachable')) : Promise.resolve(PAIRS_RESPONSE),
    );
    const results = await Promise.allSettled([backend.readPairs(), backend.readPairs()]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(read).toHaveBeenCalledTimes(1);
    fail = false;
    await expect(backend.readPairs()).resolves.toBe(PAIRS_RESPONSE);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('PC5 the TTL runs from the answer, not from the request', async () => {
    const holder: { clock?: { at: number } } = {};
    const { backend, read, clock } = setup(
      () =>
        new Promise((resolve) => {
          // the answer comes 900 ms after the request
          if (holder.clock !== undefined) holder.clock.at += 900;
          resolve(PAIRS_RESPONSE);
        }),
    );
    holder.clock = clock;
    await backend.readPairs();
    clock.at = 900 + TTL_MS - 1;
    await backend.readPairs();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
