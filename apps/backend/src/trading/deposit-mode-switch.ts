import type { FastifyBaseLogger } from 'fastify';
import { DepositModeSwitch, errorLogFields } from '@binarius/shared';
import {
  listDepositsAwaitingModeSwitch,
  switchTradingModeOnDeposit,
  type DepositModeSwitchAttempt,
} from '@binarius/db';
import type { Db } from '@binarius/db';
import {
  DEPOSIT_MODE_SWITCH_RETRY_MS,
  DEPOSIT_MODE_SWITCH_SCAN_LIMIT,
  DEPOSIT_MODE_SWITCH_SCAN_MS,
} from '../timing';

// docs/trading-mode.md → The automatic switch after a deposit (#686). The pass over the attributed
// deposits with no outcome: each attempt is switchTradingModeOnDeposit's one transaction, which
// writes an outcome or leaves the row waiting for the user's session to end. A switch wakes the
// mailing planner (onSwitched), which plans the message about it.

export interface DepositModeSwitcherConfig {
  scanMs: number;
  scanLimit: number;
  retryMs: number;
}

const DEFAULT_CONFIG: DepositModeSwitcherConfig = {
  scanMs: DEPOSIT_MODE_SWITCH_SCAN_MS,
  scanLimit: DEPOSIT_MODE_SWITCH_SCAN_LIMIT,
  retryMs: DEPOSIT_MODE_SWITCH_RETRY_MS,
};

export interface DepositModeSwitchOps {
  list: (db: Db, options: { limit: number }) => Promise<string[]>;
  attempt: (
    db: Db,
    options: { depositEventId: string; demoOnly: boolean },
  ) => Promise<{ outcome: DepositModeSwitchAttempt }>;
}

const DEFAULT_OPS: DepositModeSwitchOps = {
  list: listDepositsAwaitingModeSwitch,
  attempt: switchTradingModeOnDeposit,
};

export interface DepositModeSwitcherDeps {
  db: Db;
  // DEMO_ONLY (#396): every deposit is closed demo_only, nobody is switched
  demoOnly: boolean;
  logger: FastifyBaseLogger;
  // called after each switch's commit: the mailing engine's wakePlan
  onSwitched: () => void;
  ops?: DepositModeSwitchOps;
  config?: Partial<DepositModeSwitcherConfig>;
  // the monotonic clock of the hold-back after a throw; performance.now by default
  now?: () => number;
}

export interface DepositModeSwitcher {
  tick(): Promise<void>;
  start(): void;
  // ends the timer and waits for the tick in flight: its current transaction ends, no further
  // candidate is taken
  stop(): Promise<void>;
}

const COUNT_KEYS = {
  [DepositModeSwitch.Switched]: 'switched',
  [DepositModeSwitch.AlreadyReal]: 'alreadyReal',
  [DepositModeSwitch.UserBlocked]: 'userBlocked',
  [DepositModeSwitch.AccountInactive]: 'accountInactive',
  [DepositModeSwitch.DemoOnly]: 'demoOnly',
  [DepositModeSwitch.Superseded]: 'superseded',
  [DepositModeSwitch.Predates]: 'predates',
  session_active: 'waiting',
  gone: 'gone',
} as const satisfies Record<DepositModeSwitchAttempt, string>;

type Counts = Record<(typeof COUNT_KEYS)[DepositModeSwitchAttempt] | 'failed', number>;

export function createDepositModeSwitcher(deps: DepositModeSwitcherDeps): DepositModeSwitcher {
  const { db, demoOnly, logger, onSwitched } = deps;
  const ops = deps.ops ?? DEFAULT_OPS;
  const config = { ...DEFAULT_CONFIG, ...deps.config };
  const now = deps.now ?? (() => performance.now());
  let stopped = false;
  let ticking: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  // a candidate whose attempt threw, until when it is skipped; in memory, so a restart retries it
  const heldUntil = new Map<string, number>();

  function wake(): void {
    try {
      onSwitched();
    } catch (error) {
      logger.warn(errorLogFields(error), 'deposit mode switch wake failed');
    }
  }

  async function runTick(): Promise<void> {
    const counts: Counts = {
      switched: 0,
      alreadyReal: 0,
      userBlocked: 0,
      accountInactive: 0,
      demoOnly: 0,
      superseded: 0,
      predates: 0,
      waiting: 0,
      gone: 0,
      failed: 0,
    };
    const candidates = await ops.list(db, { limit: config.scanLimit });
    for (const depositEventId of candidates) {
      if (stopped) break;
      const held = heldUntil.get(depositEventId);
      if (held !== undefined) {
        if (now() < held) continue;
        heldUntil.delete(depositEventId);
      }
      try {
        const { outcome } = await ops.attempt(db, { depositEventId, demoOnly });
        counts[COUNT_KEYS[outcome]] += 1;
        if (outcome === DepositModeSwitch.Switched) wake();
      } catch (error) {
        counts.failed += 1;
        heldUntil.set(depositEventId, now() + config.retryMs);
        logger.warn({ depositEventId, ...errorLogFields(error) }, 'deposit mode switch failed');
      }
    }
    const nonZero = Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));
    if (Object.keys(nonZero).length > 0) logger.info(nonZero, 'deposit mode switch');
  }

  // a tick longer than its interval makes the next one a no-op
  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    ticking ??= runTick()
      .catch((error: unknown) =>
        logger.error(errorLogFields(error), 'deposit mode switch tick failed'),
      )
      .finally(() => {
        ticking = undefined;
      });
    return ticking;
  }

  return {
    tick,
    start() {
      if (stopped || timer !== undefined) return;
      timer = setInterval(() => void tick(), config.scanMs);
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      await ticking;
    },
  };
}
