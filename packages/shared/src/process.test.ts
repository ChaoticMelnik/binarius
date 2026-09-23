import { describe, expect, it } from 'vitest';
import { closeAll } from './process';

describe('closeAll', () => {
  it('runs every step even when an earlier one rejects, and reports the rejection', async () => {
    const calls: string[] = [];
    const clean = await closeAll([
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
    expect(clean).toBe(false);
  });

  it('reports true when every step fulfilled within the budget', async () => {
    await expect(closeAll([async () => {}, () => Promise.resolve(1)])).resolves.toBe(true);
  });

  it('reports false after the timeout when a step never settles', async () => {
    await expect(closeAll([() => new Promise(() => {})], 20)).resolves.toBe(false);
  });
});
