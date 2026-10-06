import { MAX_PRICE_SUBSCRIPTION_ASSETS } from '@binarius/shared';

// The assets a broker socket should receive prices for. It outlives a connection: after every
// re-auth the client sends all() again, and between passes add() reports which ids are new, so
// one connection never asks for the same id twice.
export interface AssetSubscriptionRegistry {
  // validates every id before adding any; returns the ids that were not yet present, in input
  // order, each once
  add(ids: readonly number[]): number[];
  // ascending
  all(): number[];
  readonly size: number;
}

const isAssetId = (id: number) => Number.isSafeInteger(id) && id >= 0;

export function createAssetSubscriptionRegistry(): AssetSubscriptionRegistry {
  const ids = new Set<number>();
  return {
    add(input) {
      const invalid = input.find((id) => !isAssetId(id));
      if (invalid !== undefined) {
        throw new RangeError(`asset id must be a non-negative safe integer, got ${String(invalid)}`);
      }
      const added: number[] = [];
      for (const id of input) {
        if (ids.has(id)) continue;
        ids.add(id);
        added.push(id);
      }
      return added;
    },
    all: () => [...ids].sort((a, b) => a - b),
    get size() {
      return ids.size;
    },
  };
}

// order kept; every chunk holds 1..size ids, so each one is a valid price.subscribe payload
export function chunkAssets(
  ids: readonly number[],
  size: number = MAX_PRICE_SUBSCRIPTION_ASSETS,
): number[][] {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError(`chunk size must be a positive integer, got ${String(size)}`);
  }
  const chunks: number[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    chunks.push(ids.slice(start, start + size));
  }
  return chunks;
}
