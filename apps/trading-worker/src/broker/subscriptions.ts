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
      const invalid = input.findIndex((id) => !isAssetId(id));
      // the index, never the value: an id is caller data and errors reach logs
      if (invalid !== -1) {
        throw new RangeError(`asset id at index ${invalid} is not a non-negative safe integer`);
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

// order kept; every chunk holds 1..MAX_PRICE_SUBSCRIPTION_ASSETS ids, so each one is a valid
// price.subscribe payload
export function chunkAssets(ids: readonly number[]): number[][] {
  const chunks: number[][] = [];
  for (let start = 0; start < ids.length; start += MAX_PRICE_SUBSCRIPTION_ASSETS) {
    chunks.push(ids.slice(start, start + MAX_PRICE_SUBSCRIPTION_ASSETS));
  }
  return chunks;
}
