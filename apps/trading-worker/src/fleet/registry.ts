import { errorLogFields } from '@binarius/shared';
import type pino from 'pino';
import { withTimeout } from '../broker/session-manager';
import { liveViewOf } from './capacity';
import type { FleetConfig } from './config';
import { ownerOf } from './rendezvous';

// This process's view of the live worker fleet (#94, docs/worker-capacity.md → The registry): a
// heartbeat moves our row in worker_processes and answers the live set; an account is ours when
// rendezvous hashing over that set names us. The view is trusted until liveFenceMs after the
// heartbeat that answered it was sent: past that the process owns nothing, before the others may
// see its row lapse (FLEET_CONFIG's chain).

type FleetLogger = Pick<pino.Logger, 'info' | 'warn' | 'error'>;

// bound to this process's owner id by the caller: production is worker-process-ops.ts
export interface FleetRegistryOps {
  heartbeat(options: { ttlMs: number; pruneAfterMs: number }): Promise<string[]>;
  deregister(): Promise<unknown>;
}

export interface FleetRegistry {
  // one heartbeat at once, then every heartbeatMs
  start(): void;
  // single-flight, bounded by heartbeatTimeoutMs; never rejects
  heartbeat(): Promise<void>;
  owns(accountId: string): boolean;
  // the live set of the last answer, sorted; [] before the first answer and after stop()
  live(): readonly string[];
  readonly liveView: string;
  // monotonic send time of the heartbeat that answered last; undefined before the first
  lastAnsweredAt(): number | undefined;
  // owns nothing from here on; then deletes our row, bounded by heartbeatTimeoutMs
  stop(): Promise<void>;
}

export interface FleetRegistryDeps {
  ownerId: string;
  ops: FleetRegistryOps;
  config: FleetConfig;
  logger: FleetLogger;
  monotonicNow?: () => number;
}

export function createFleetRegistry(deps: FleetRegistryDeps): FleetRegistry {
  const { ownerId, ops, config, logger } = deps;
  const now = deps.monotonicNow ?? (() => performance.now());
  let live: readonly string[] = [];
  let view = liveViewOf(live);
  let liveUntil = -Infinity;
  let answeredAt: number | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let beating: Promise<void> | undefined;

  function apply(answer: readonly string[], sentAt: number) {
    // the registry's own order: two processes compare views whatever order the database answered
    const next = [...new Set(answer)].sort();
    liveUntil = sentAt + config.liveFenceMs;
    answeredAt = sentAt;
    const before = new Set(live);
    const joined = next.filter((id) => !before.has(id));
    const left = live.filter((id) => !next.includes(id));
    live = next;
    view = liveViewOf(live);
    if (joined.length > 0 || left.length > 0) {
      logger.info({ live, liveView: view, joined, left }, 'worker fleet changed');
    }
  }

  async function run() {
    const sentAt = now();
    let answer: string[] | 'timeout';
    try {
      answer = await withTimeout(
        ops.heartbeat({ ttlMs: config.processTtlMs, pruneAfterMs: config.processPruneMs }),
        config.heartbeatTimeoutMs,
      );
    } catch (error) {
      // the fence decides: one failed heartbeat keeps the view (2 × heartbeat + 2 × timeout < fence)
      logger.error(errorLogFields(error), 'worker heartbeat failed');
      return;
    }
    if (answer === 'timeout') {
      logger.warn({ timeoutMs: config.heartbeatTimeoutMs }, 'worker heartbeat timed out');
      return;
    }
    if (stopped) return;
    apply(answer, sentAt);
  }

  function heartbeat(): Promise<void> {
    if (stopped) return Promise.resolve();
    beating ??= run()
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'worker heartbeat threw');
      })
      .finally(() => {
        beating = undefined;
      });
    return beating;
  }

  return {
    start() {
      if (stopped || timer !== undefined) return;
      void heartbeat();
      timer = setInterval(() => void heartbeat(), config.heartbeatMs);
    },
    heartbeat,
    owns(accountId) {
      return live.length > 0 && now() < liveUntil && ownerOf(accountId, live) === ownerId;
    },
    live: () => live,
    get liveView() {
      return view;
    },
    lastAnsweredAt: () => answeredAt,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      live = [];
      view = liveViewOf(live);
      let result: unknown;
      try {
        result = await withTimeout(ops.deregister(), config.heartbeatTimeoutMs);
      } catch (error) {
        // the row lapses on its own after processTtlMs
        logger.error(errorLogFields(error), 'worker deregister failed');
        return;
      }
      if (result === 'timeout') {
        logger.warn({ timeoutMs: config.heartbeatTimeoutMs }, 'worker deregister timed out');
      }
    },
  };
}
