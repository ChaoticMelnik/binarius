import { describe, expect, it } from 'vitest';
import { closeAll } from './shutdown';

describe('closeAll', () => {
  it('runs every step even when an earlier one rejects', async () => {
    const calls: string[] = [];
    await closeAll([
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
  });

  it('resolves after the timeout when a step never settles', async () => {
    await expect(closeAll([() => new Promise(() => {})], 20)).resolves.toBeUndefined();
  });
});
