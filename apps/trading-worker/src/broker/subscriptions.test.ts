import { MAX_PRICE_SUBSCRIPTION_ASSETS, priceSubscribeWireSchema } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { chunkAssets, createAssetSubscriptionRegistry } from './subscriptions';

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

describe('createAssetSubscriptionRegistry', () => {
  it('returns the new ids in input order, each once, and lists all of them ascending', () => {
    const registry = createAssetSubscriptionRegistry();
    expect(registry.add([303, 101, 303, 202])).toEqual([303, 101, 202]);
    expect(registry.add([101, 404, 0])).toEqual([404, 0]);
    expect(registry.all()).toEqual([0, 101, 202, 303, 404]);
    expect(registry.size).toBe(5);
  });

  it('adds nothing for an id already present or an empty input', () => {
    const registry = createAssetSubscriptionRegistry();
    registry.add([101]);
    expect(registry.add([101, 101])).toEqual([]);
    expect(registry.add([])).toEqual([]);
    expect(registry.all()).toEqual([101]);
  });

  it.each([
    ['a negative id', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses %s and adds nothing from that call', (_name, bad) => {
    const registry = createAssetSubscriptionRegistry();
    registry.add([101]);
    expect(() => registry.add([202, bad])).toThrow(RangeError);
    expect(registry.all()).toEqual([101]);
  });

  it('names the index of a rejected id, never its value', () => {
    const registry = createAssetSubscriptionRegistry();
    let thrown: unknown;
    try {
      registry.add([101, 'SECRET-id' as unknown as number]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RangeError);
    expect((thrown as Error).message).not.toContain('SECRET');
    expect((thrown as Error).message).toContain('index 1');
    expect(registry.all()).toEqual([]);
  });

  it('hands out copies', () => {
    const registry = createAssetSubscriptionRegistry();
    registry.add([101]);
    registry.all().push(999);
    expect(registry.all()).toEqual([101]);
  });
});

describe('chunkAssets', () => {
  it('cuts at the contract maximum, keeps order, and every chunk is a valid price.subscribe', () => {
    const ids = range(1, 2 * MAX_PRICE_SUBSCRIPTION_ASSETS + 1);
    const chunks = chunkAssets(ids);
    expect(chunks.map((chunk) => chunk.length)).toEqual([
      MAX_PRICE_SUBSCRIPTION_ASSETS,
      MAX_PRICE_SUBSCRIPTION_ASSETS,
      1,
    ]);
    expect(chunks.flat()).toEqual(ids);
    for (const assets of chunks) {
      expect(priceSubscribeWireSchema.safeParse({ assets }).success).toBe(true);
    }
  });

  it('gives one chunk for exactly the maximum and none for no ids', () => {
    expect(chunkAssets(range(1, MAX_PRICE_SUBSCRIPTION_ASSETS))).toHaveLength(1);
    expect(chunkAssets([])).toEqual([]);
  });
});
