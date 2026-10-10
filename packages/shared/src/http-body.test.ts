import { describe, expect, it } from 'vitest';
import { readBody } from './http-body';

const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> => {
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  });
};

describe('readBody', () => {
  it('joins chunks that cut a multi-byte character before decoding them', async () => {
    const bytes = new TextEncoder().encode('{"a":"привет"}');
    const body = streamOf([bytes.subarray(0, 7), bytes.subarray(7)]);
    expect(await readBody(new Response(body), 1024)).toBe('{"a":"привет"}');
  });

  it('reads a body of exactly maxBytes and refuses one byte more', async () => {
    const bytes = new TextEncoder().encode('0123456789');
    expect(await readBody(new Response(streamOf([bytes])), 10)).toBe('0123456789');
    expect(await readBody(new Response(streamOf([bytes])), 9)).toBeUndefined();
  });

  it('stops an endless body at the ceiling and cancels its source', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readBody(new Response(body), 64 * 1024)).toBeUndefined();
    expect(cancelled).toBe(true);
  });

  it('reads a response without a body as empty text', async () => {
    expect(await readBody(new Response(null), 16)).toBe('');
  });

  it('throws the failure of a body cut mid-flight', async () => {
    const failure = new Error('cut');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":'));
        controller.error(failure);
      },
    });
    await expect(readBody(new Response(body), 1024)).rejects.toBe(failure);
  });
});
