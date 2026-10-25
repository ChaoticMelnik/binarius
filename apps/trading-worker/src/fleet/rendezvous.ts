import { createHash } from 'node:crypto';

// Rendezvous (highest random weight) hashing (#94, docs/worker-capacity.md → Ownership): the
// owner of an account is the live process whose sha256(`${owner}:${accountId}`) is the greatest.
// Every process computes it from the same live set and gets the same answer; a join moves only
// the accounts the newcomer wins, a leave only the leaver's. #347 and any SQL twin must match the
// vector pinned in rendezvous.test.ts.

export type Digest = (input: string) => Buffer;

const sha256: Digest = (input) => createHash('sha256').update(input, 'utf8').digest();

export function ownerOf(
  accountId: string,
  live: readonly string[],
  digest: Digest = sha256,
): string | undefined {
  let best: string | undefined;
  let bestWeight: Buffer | undefined;
  for (const owner of live) {
    const weight = digest(`${owner}:${accountId}`);
    const order = bestWeight === undefined ? 1 : Buffer.compare(weight, bestWeight);
    // equal weights: the lower owner id, so the answer does not depend on the order of `live`
    if (order > 0 || (order === 0 && owner < best!)) {
      best = owner;
      bestWeight = weight;
    }
  }
  return best;
}
