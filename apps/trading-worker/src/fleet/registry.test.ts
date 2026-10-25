import { randomUUID } from 'node:crypto';
import { logOptions } from '@binarius/shared';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { liveViewOf } from './capacity';
import type { FleetConfig } from './config';
import { createFleetRegistry, type FleetRegistryOps } from './registry';
import { ownerOf } from './rendezvous';

const CONFIG: FleetConfig = {
  heartbeatMs: 1_000,
  heartbeatTimeoutMs: 50,
  liveFenceMs: 5_000,
  processTtlMs: 6_000,
  processPruneMs: 60_000,
  capacityLogMs: 1_000,
};
const ME = randomUUID();
const OTHERS = [randomUUID(), randomUUID()];
const ACCOUNTS = Array.from({ length: 200 }, () => randomUUID());

function harness(ops: Partial<FleetRegistryOps> = {}) {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(logOptions('debug'), {
    write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  // the database's answer, deliberately not sorted: the registry sorts it
  const state = { answer: [OTHERS[1]!, ME, OTHERS[0]!] };
  const calls = { heartbeat: 0, deregister: 0 };
  let clock = 1_000;
  const registry = createFleetRegistry({
    ownerId: ME,
    config: CONFIG,
    logger,
    monotonicNow: () => clock,
    ops: {
      heartbeat: (options) => {
        calls.heartbeat += 1;
        return ops.heartbeat?.(options) ?? Promise.resolve([...state.answer]);
      },
      deregister: () => {
        calls.deregister += 1;
        return ops.deregister?.() ?? Promise.resolve(1);
      },
    },
  });
  return {
    registry,
    state,
    calls,
    setClock: (at: number) => (clock = at),
    logs: (msg: string) => lines.filter((line) => line.msg === msg),
  };
}

const ownedBy = (live: readonly string[]) =>
  ACCOUNTS.filter((id) => ownerOf(id, [...live].sort()) === ME);

describe('the fleet registry (#94)', () => {
  it('F1 owns nothing before the first heartbeat answers', () => {
    const h = harness();
    expect(ACCOUNTS.some((id) => h.registry.owns(id))).toBe(false);
    expect(h.registry.live()).toEqual([]);
    expect(h.registry.lastAnsweredAt()).toBeUndefined();
  });

  it('F2 after it: owns what rendezvous names us for, the live set sorted, the view of the sorted set', async () => {
    const h = harness();
    await h.registry.heartbeat();
    const sorted = [...h.state.answer].sort();
    expect(h.registry.live()).toEqual(sorted);
    expect(h.registry.liveView).toBe(liveViewOf(sorted));
    const mine = ownedBy(sorted);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.length).toBeLessThan(ACCOUNTS.length);
    expect(ACCOUNTS.filter((id) => h.registry.owns(id))).toEqual(mine);

    const alone = harness();
    alone.state.answer = [ME];
    await alone.registry.heartbeat();
    expect(ACCOUNTS.every((id) => alone.registry.owns(id))).toBe(true);
  });

  it('F3 a view not refreshed owns nothing from the fence on, and holds just before it', async () => {
    const h = harness();
    h.setClock(2_000);
    await h.registry.heartbeat();
    const mine = ownedBy(h.state.answer);
    h.setClock(2_000 + CONFIG.liveFenceMs - 1);
    expect(ACCOUNTS.filter((id) => h.registry.owns(id))).toEqual(mine);
    h.setClock(2_000 + CONFIG.liveFenceMs);
    expect(ACCOUNTS.some((id) => h.registry.owns(id))).toBe(false);
  });

  it('F4 a heartbeat that throws keeps the view; one that times out too, and its late answer is ignored', async () => {
    let mode: 'ok' | 'throw' | 'hang' = 'ok';
    let late: (ids: string[]) => void = () => undefined;
    const h = harness({
      heartbeat: () => {
        if (mode === 'throw') return Promise.reject(new Error('database down'));
        if (mode === 'hang') return new Promise((resolve) => (late = resolve));
        return Promise.resolve([...h.state.answer]);
      },
    });
    await h.registry.heartbeat();
    const mine = ownedBy(h.state.answer);
    mode = 'throw';
    await h.registry.heartbeat();
    expect(h.logs('worker heartbeat failed')).toEqual([expect.objectContaining({ level: 50 })]);
    expect(ACCOUNTS.filter((id) => h.registry.owns(id))).toEqual(mine);
    mode = 'hang';
    await h.registry.heartbeat();
    expect(h.logs('worker heartbeat timed out')).toEqual([expect.objectContaining({ level: 40 })]);
    late([ME]);
    // the late answer's turn: nothing is waiting on it any more
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.registry.live()).toEqual([...h.state.answer].sort());
    expect(ACCOUNTS.filter((id) => h.registry.owns(id))).toEqual(mine);
  });

  it('F5 stop() owns nothing at once and deregisters once; a deregister that throws is logged', async () => {
    const h = harness();
    await h.registry.heartbeat();
    await h.registry.stop();
    expect(ACCOUNTS.some((id) => h.registry.owns(id))).toBe(false);
    expect(h.registry.live()).toEqual([]);
    expect(h.calls.deregister).toBe(1);
    await h.registry.heartbeat();
    expect(h.calls.heartbeat).toBe(1);

    const failing = harness({ deregister: () => Promise.reject(new Error('database down')) });
    await failing.registry.heartbeat();
    await failing.registry.stop();
    expect(failing.logs('worker deregister failed')).toHaveLength(1);
  });

  it('F6 logs a join and a leave with who, and nothing for an unchanged set', async () => {
    const h = harness();
    h.state.answer = [ME];
    await h.registry.heartbeat();
    h.state.answer = [ME, OTHERS[0]!];
    await h.registry.heartbeat();
    await h.registry.heartbeat();
    h.state.answer = [OTHERS[0]!, ME];
    await h.registry.heartbeat();
    h.state.answer = [ME];
    await h.registry.heartbeat();
    const changes = h.logs('worker fleet changed');
    expect(changes.map(({ joined, left }) => ({ joined, left }))).toEqual([
      { joined: [ME], left: [] },
      { joined: [OTHERS[0]], left: [] },
      { joined: [], left: [OTHERS[0]] },
    ]);
    expect(changes[1]).toMatchObject({
      level: 30,
      live: [ME, OTHERS[0]].sort(),
      liveView: liveViewOf([ME, OTHERS[0]!].sort()),
    });
  });

  it('F7 ownerOf (#347): undefined before the first answer, the rendezvous owner after it, undefined from the fence and after stop()', async () => {
    const h = harness();
    const ids = ACCOUNTS.slice(0, 50);
    h.setClock(2_000);
    expect(ids.some((id) => h.registry.ownerOf(id) !== undefined)).toBe(false);
    await h.registry.heartbeat();
    const sorted = [...h.state.answer].sort();
    expect(ids.map((id) => h.registry.ownerOf(id))).toEqual(ids.map((id) => ownerOf(id, sorted)));
    expect(new Set(ids.map((id) => h.registry.ownerOf(id))).size).toBeGreaterThan(1);
    expect(ids.every((id) => h.registry.owns(id) === (h.registry.ownerOf(id) === ME))).toBe(true);
    h.setClock(2_000 + CONFIG.liveFenceMs);
    expect(ids.some((id) => h.registry.ownerOf(id) !== undefined)).toBe(false);
    h.setClock(2_000);
    expect(h.registry.ownerOf(ids[0]!)).toBe(ownerOf(ids[0]!, sorted));
    await h.registry.stop();
    expect(ids.some((id) => h.registry.ownerOf(id) !== undefined)).toBe(false);
  });
});
