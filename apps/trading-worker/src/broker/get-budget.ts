import type { BrokerRestClient } from '@binarius/broker-rest';

// The worker's share of the broker's per-IP limit (WORKER_BROKER_GETS_PER_MINUTE) held at runtime
// (#872, docs/trade-intent-transport.md -> Budget): the GETs sent in any window of this length
// never exceed the cap.
export const BROKER_GET_WINDOW_MS = 60_000;

export type BrokerGets = Pick<BrokerRestClient, 'listTrades' | 'getUser'>;

// One loop's view of the budget. The loop reserves an attempt's worst case before its first GET
// and ends the reservation when the attempt is over; every GET through `rest` is counted.
export interface BrokerGetMeter {
  rest: BrokerGets;
  // false when the reservation does not fit the window: nothing is reserved
  begin(gets: number): boolean;
  // returns what the reservation did not spend
  end(): void;
}

export interface BrokerGetBudget {
  meter(rest: BrokerGets): BrokerGetMeter;
  // the GETs sent in the window plus those reserved and not sent yet
  committed(): number;
}

export interface BrokerGetBudgetOptions {
  perMinute: number;
  now?: () => number;
}

// Invariant: made (in the window) + outstanding <= perMinute after every operation; a GET moves one
// unit from outstanding to made, so made never exceeds the cap while attempts keep to their
// reservations. A GET beyond its reservation is still counted: the next begin refuses until the
// window drops it (conservative). A GET is counted before the request: the broker counts what it
// receives, and a request cut by its signal before it is sent costs throughput, never a 429.
export function createBrokerGetBudget({
  perMinute,
  now = Date.now,
}: BrokerGetBudgetOptions): BrokerGetBudget {
  if (!Number.isInteger(perMinute) || perMinute < 1) {
    throw new RangeError(`perMinute must be a positive integer, got ${perMinute}`);
  }
  const made: number[] = [];
  let outstanding = 0;

  function trim(): void {
    const floor = now() - BROKER_GET_WINDOW_MS;
    let dropped = 0;
    while (dropped < made.length && (made[dropped] ?? Infinity) <= floor) dropped += 1;
    made.splice(0, dropped);
  }

  function committed(): number {
    trim();
    return made.length + outstanding;
  }

  function meter(rest: BrokerGets): BrokerGetMeter {
    let left = 0;
    let active = false;

    function count(): void {
      if (left > 0) {
        left -= 1;
        outstanding -= 1;
      }
      made.push(now());
    }

    return {
      rest: {
        listTrades: (auth, filter, options) => {
          count();
          return rest.listTrades(auth, filter, options);
        },
        getUser: (auth, options) => {
          count();
          return rest.getUser(auth, options);
        },
      },
      begin(gets) {
        if (!Number.isInteger(gets) || gets < 1) {
          throw new RangeError(`a reservation must be a positive integer, got ${gets}`);
        }
        if (active) throw new Error('begin() while this meter holds a reservation');
        if (committed() + gets > perMinute) return false;
        outstanding += gets;
        left = gets;
        active = true;
        return true;
      },
      end() {
        outstanding -= left;
        left = 0;
        active = false;
      },
    };
  }

  return { meter, committed };
}
