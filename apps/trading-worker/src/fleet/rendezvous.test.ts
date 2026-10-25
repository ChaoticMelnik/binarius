import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ownerOf } from './rendezvous';

// deterministic uuid-shaped ids: sha256 of the index, cut into the 8-4-4-4-12 groups
const uuidOf = (seed: string) => {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const accounts = (n: number) => Array.from({ length: n }, (_, i) => uuidOf(String(i)));
const processes = (n: number) => Array.from({ length: n }, (_, i) => uuidOf(`process-${i}`));

describe('ownerOf (#94)', () => {
  it('H1 is deterministic and does not depend on the order of the live set', () => {
    const live = processes(4);
    for (const id of accounts(200)) {
      expect(ownerOf(id, live)).toBe(ownerOf(id, [...live].reverse()));
      expect(live).toContain(ownerOf(id, live));
    }
  });

  it('H2 a joining process takes accounts only for itself', () => {
    const before = processes(3);
    const joined = processes(4);
    const newcomer = joined[3]!;
    let moved = 0;
    for (const id of accounts(1_000)) {
      const [was, is] = [ownerOf(id, before), ownerOf(id, joined)];
      if (was !== is) {
        expect(is).toBe(newcomer);
        moved += 1;
      }
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('H3 a leaving process gives away only its own accounts', () => {
    const before = processes(4);
    const leaver = before[1]!;
    const after = before.filter((owner) => owner !== leaver);
    for (const id of accounts(1_000)) {
      const was = ownerOf(id, before);
      if (was !== leaver) expect(ownerOf(id, after)).toBe(was);
    }
  });

  it.each([2, 3, 4, 5, 6])(
    'H4 spreads 10 000 accounts within ±15 %% of even over %i processes',
    (n) => {
      const live = processes(n);
      const counts = new Map(live.map((owner) => [owner, 0]));
      for (const id of accounts(10_000)) {
        const owner = ownerOf(id, live)!;
        counts.set(owner, counts.get(owner)! + 1);
      }
      const even = 10_000 / n;
      for (const count of counts.values()) {
        expect(Math.abs(count - even) / even).toBeLessThanOrEqual(0.15);
      }
    },
  );

  it('H5 nobody owns anything with no live process', () => {
    expect(ownerOf(uuidOf('0'), [])).toBeUndefined();
  });

  // computed outside the code (`printf '%s' '<owner>:<account>' | shasum -a 256`):
  //   aaaaaaaa-…:11111111-… → 669691dd…
  //   bbbbbbbb-…:11111111-… → 9a840227…
  //   cccccccc-…:11111111-… → ffaff481…  the greatest: the owner
  it('H6 matches the pinned vector', () => {
    const live = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ];
    expect(ownerOf('11111111-1111-4111-8111-111111111111', live)).toBe(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
  });

  it('H7 equal weights go to the lowest owner id, whatever the order', () => {
    const constant = () => Buffer.alloc(32, 7);
    const live = ['cccc', 'aaaa', 'bbbb'];
    expect(ownerOf('acc', live, constant)).toBe('aaaa');
    expect(ownerOf('acc', [...live].reverse(), constant)).toBe('aaaa');
  });
});
