import { describe, expect, it } from 'vitest';
import { closeAll } from './process';

describe('closeAll', () => {
  it('runs every step even when an earlier one rejects, and reports settled', async () => {
    const calls: string[] = [];
    const settled = await closeAll([
      () => {
        calls.push('first');
        return Promise.reject(new Error('first failed'));
      },
      () => {
        calls.push('second');
        throw new Error('second failed synchronously');
      },
      async () => {
        calls.push('third');
      },
    ]);
    expect(calls).toEqual(['first', 'second', 'third']);
    expect(settled).toBe(true);
  });

  it('reports false after the timeout when a step never settles', async () => {
    await expect(closeAll([() => new Promise(() => {})], 20)).resolves.toBe(false);
  });
});
