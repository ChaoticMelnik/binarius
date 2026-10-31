import { describe, expect, it } from 'vitest';
import type { BrokerTrade, BrokerUser } from '@binarius/shared';
import { BROKER_GET_WINDOW_MS, createBrokerGetBudget, type BrokerGets } from './get-budget';

const AUTH = { accessToken: 'token' };

function fakeRest() {
  const calls: { kind: 'list' | 'user'; args: unknown[] }[] = [];
  const trades = [] as BrokerTrade[];
  const user = { id: 'user' } as unknown as BrokerUser;
  const rest: BrokerGets = {
    listTrades: (...args) => {
      calls.push({ kind: 'list', args });
      return Promise.resolve(trades);
    },
    getUser: (...args) => {
      calls.push({ kind: 'user', args });
      return Promise.resolve(user);
    },
  };
  return { rest, calls, trades, user };
}

// the most GETs any window of BROKER_GET_WINDOW_MS holds, over sorted timestamps
function maxInWindow(sent: readonly number[]): number {
  let max = 0;
  for (let i = 0, j = 0; i < sent.length; i += 1) {
    while (sent[j]! <= sent[i]! - BROKER_GET_WINDOW_MS) j += 1;
    max = Math.max(max, i - j + 1);
  }
  return max;
}

function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// a seeded generator, so a failing run is the same run again
function prng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s % n;
  };
}

describe('the broker GET budget (#872)', () => {
  it('G1: a reservation within the cap is taken, and end() without a GET returns it', () => {
    const c = clock();
    const budget = createBrokerGetBudget({ perMinute: 5, now: c.now });
    const meter = budget.meter(fakeRest().rest);
    expect(meter.begin(3)).toBe(true);
    expect(budget.committed()).toBe(3);
    meter.end();
    expect(budget.committed()).toBe(0);
  });

  it('G2: a GET moves one unit from the reservation into the window, which forgets it after 60 s', async () => {
    expect(BROKER_GET_WINDOW_MS).toBe(60_000);
    const c = clock();
    const budget = createBrokerGetBudget({ perMinute: 5, now: c.now });
    const meter = budget.meter(fakeRest().rest);
    expect(meter.begin(3)).toBe(true);
    await meter.rest.listTrades(AUTH);
    expect(budget.committed()).toBe(3);
    meter.end();
    expect(budget.committed()).toBe(1);
    c.advance(BROKER_GET_WINDOW_MS - 1);
    expect(budget.committed()).toBe(1);
    c.advance(1);
    expect(budget.committed()).toBe(0);
  });

  it('G3: the GETs sent in any 60 s window never exceed the cap, and begin refuses what does not fit', async () => {
    const perMinute = 10;
    const c = clock();
    const budget = createBrokerGetBudget({ perMinute, now: c.now });
    const meters = [budget.meter(fakeRest().rest), budget.meter(fakeRest().rest)];
    const random = prng(872);
    const sent: number[] = [];
    let refused = 0;
    const end = c.now() + 10 * BROKER_GET_WINDOW_MS;
    while (c.now() < end) {
      const meter = meters[random(2)]!;
      const reserve = 1 + random(5);
      if (meter.begin(reserve)) {
        const gets = random(reserve + 1);
        for (let i = 0; i < gets; i += 1) {
          sent.push(c.now());
          await meter.rest.listTrades(AUTH);
          c.advance(random(400));
        }
        meter.end();
      } else {
        refused += 1;
      }
      c.advance(random(3_000));
    }
    expect(sent.length).toBeGreaterThan(5 * perMinute);
    expect(maxInWindow(sent)).toBeLessThanOrEqual(perMinute);
    expect(refused).toBeGreaterThan(0);
  });

  it('G4: two meters of one budget see each other’s reservations', () => {
    const c = clock();
    const budget = createBrokerGetBudget({ perMinute: 6, now: c.now });
    const a = budget.meter(fakeRest().rest);
    const b = budget.meter(fakeRest().rest);
    expect(a.begin(4)).toBe(true);
    expect(b.begin(3)).toBe(false);
    expect(b.begin(2)).toBe(true);
  });

  it('G5: a GET beyond the reservation is counted, and the next begin refuses until the window drops it', async () => {
    const c = clock();
    const budget = createBrokerGetBudget({ perMinute: 2, now: c.now });
    const meter = budget.meter(fakeRest().rest);
    expect(meter.begin(1)).toBe(true);
    await meter.rest.listTrades(AUTH);
    await meter.rest.listTrades(AUTH);
    meter.end();
    expect(budget.committed()).toBe(2);
    expect(meter.begin(1)).toBe(false);
    c.advance(BROKER_GET_WINDOW_MS);
    expect(meter.begin(1)).toBe(true);
  });

  it('G6: a refused begin changes nothing', () => {
    const c = clock();
    const budget = createBrokerGetBudget({ perMinute: 4, now: c.now });
    const a = budget.meter(fakeRest().rest);
    const b = budget.meter(fakeRest().rest);
    expect(a.begin(3)).toBe(true);
    expect(b.begin(2)).toBe(false);
    expect(budget.committed()).toBe(3);
    expect(b.begin(1)).toBe(true);
  });

  it('G7: getUser and listTrades are both counted, with arguments and answers passed through', async () => {
    const c = clock();
    const budget = createBrokerGetBudget({ perMinute: 5, now: c.now });
    const fake = fakeRest();
    const meter = budget.meter(fake.rest);
    const signal = new AbortController().signal;
    expect(await meter.rest.getUser(AUTH, { signal })).toBe(fake.user);
    expect(budget.committed()).toBe(1);
    const filter = { limit: 50, offset: 0 };
    expect(await meter.rest.listTrades(AUTH, filter, { signal })).toBe(fake.trades);
    expect(budget.committed()).toBe(2);
    expect(fake.calls).toEqual([
      { kind: 'user', args: [AUTH, { signal }] },
      { kind: 'list', args: [AUTH, filter, { signal }] },
    ]);
  });

  it('G8: begin during a reservation throws; a non-positive cap or reservation is a RangeError', () => {
    const budget = createBrokerGetBudget({ perMinute: 5, now: clock().now });
    const meter = budget.meter(fakeRest().rest);
    expect(meter.begin(1)).toBe(true);
    expect(() => meter.begin(1)).toThrow('begin() while this meter holds a reservation');
    meter.end();
    expect(() => meter.begin(0)).toThrow(RangeError);
    expect(() => createBrokerGetBudget({ perMinute: 0 })).toThrow(RangeError);
  });
});

describe('the broker GET budget across a restart (#909)', () => {
  it('G9: a budget created with carriedOver refuses both meters until the window drops the carried GETs, at exactly 60 s', () => {
    const c = clock();
    const budget = createBrokerGetBudget({ perMinute: 5, now: c.now, carriedOver: 5 });
    const pass = budget.meter(fakeRest().rest);
    const catchup = budget.meter(fakeRest().rest);
    expect(budget.committed()).toBe(5);
    expect(pass.begin(1)).toBe(false);
    expect(catchup.begin(1)).toBe(false);
    c.advance(BROKER_GET_WINDOW_MS - 1);
    expect(pass.begin(1)).toBe(false);
    expect(catchup.begin(1)).toBe(false);
    c.advance(1);
    expect(pass.begin(1)).toBe(true);
    expect(budget.committed()).toBe(1);
    expect(catchup.begin(4)).toBe(true);
  });

  it('G10: a window crossing a restart holds no more than the cap, the old budget’s GETs and the new one’s together', async () => {
    const perMinute = 10;
    const c = clock();
    const old = createBrokerGetBudget({ perMinute, now: c.now });
    const oldMeter = old.meter(fakeRest().rest);
    const sent: number[] = [];
    const restartAt = c.now() + 1_000;
    expect(oldMeter.begin(perMinute)).toBe(true);
    for (let i = 0; i < perMinute; i += 1) {
      sent.push(c.now());
      await oldMeter.rest.listTrades(AUTH);
    }
    oldMeter.end();
    c.advance(restartAt - c.now());
    const fresh = createBrokerGetBudget({ perMinute, now: c.now, carriedOver: perMinute });
    const meter = fresh.meter(fakeRest().rest);
    let first: number | undefined;
    const end = restartAt + 2 * BROKER_GET_WINDOW_MS;
    while (c.now() < end) {
      if (meter.begin(1)) {
        first ??= c.now();
        sent.push(c.now());
        await meter.rest.listTrades(AUTH);
        meter.end();
      }
      c.advance(5_000);
    }
    expect(first).toBe(restartAt + BROKER_GET_WINDOW_MS);
    expect(maxInWindow(sent)).toBe(perMinute);
  });

  it('G11: carriedOver above the cap, negative or fractional is a RangeError; 0 and the cap are accepted', () => {
    expect(() => createBrokerGetBudget({ perMinute: 5, carriedOver: 6 })).toThrow(RangeError);
    expect(() => createBrokerGetBudget({ perMinute: 5, carriedOver: -1 })).toThrow(RangeError);
    expect(() => createBrokerGetBudget({ perMinute: 5, carriedOver: 1.5 })).toThrow(RangeError);
    expect(() => createBrokerGetBudget({ perMinute: 5, carriedOver: 0 })).not.toThrow();
    expect(() => createBrokerGetBudget({ perMinute: 5, carriedOver: 5 })).not.toThrow();
  });
});
