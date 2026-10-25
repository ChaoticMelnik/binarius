import { createHash } from 'node:crypto';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type pino from 'pino';
import type { SessionStats } from '../broker/session-manager';
import type { FleetRegistry } from './registry';

// The `worker capacity` line (#94, docs/worker-capacity.md → The capacity line): one per
// interval with this process's share of the fleet, its sessions against the cap, its memory and
// its event-loop lag. The envelope it feeds is measured in #87.

type CapacityLogger = Pick<pino.Logger, 'info'>;

// 8 hex chars of sha256 over the sorted ids: two processes' lines show whether they see one fleet
export function liveViewOf(live: readonly string[]): string {
  return createHash('sha256').update(live.join(','), 'utf8').digest('hex').slice(0, 8);
}

export interface CapacityReporterDeps {
  ownerId: string;
  registry: Pick<FleetRegistry, 'live' | 'liveView' | 'lastAnsweredAt'>;
  // absent: the sockets are off (BROKER_SOCKET_ENABLED)
  sessions?: { stats(): SessionStats };
  cap: number;
  logger: CapacityLogger;
  intervalMs: number;
  monotonicNow?: () => number;
}

export interface CapacityReporter {
  // the first line one interval after start
  start(): void;
  report(): void;
  stop(): void;
}

const MIB = 1024 * 1024;

export function createCapacityReporter(deps: CapacityReporterDeps): CapacityReporter {
  const { ownerId, registry, sessions, cap, logger } = deps;
  const now = deps.monotonicNow ?? (() => performance.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  let lag: IntervalHistogram | undefined;
  let shedBefore = sessions?.stats().shed ?? 0;

  function lagP99Ms(): number {
    if (lag === undefined) return 0;
    const p99 = lag.percentile(99) / 1e6;
    lag.reset();
    return Number.isFinite(p99) ? Math.round(p99 * 10) / 10 : 0;
  }

  function report() {
    const answeredAt = registry.lastAnsweredAt();
    const stats = sessions?.stats();
    const shed = stats === undefined ? 0 : stats.shed - shedBefore;
    shedBefore = stats?.shed ?? shedBefore;
    logger.info(
      {
        ownerId,
        live: registry.live().length,
        liveView: registry.liveView,
        heartbeatAgeMs: answeredAt === undefined ? null : Math.round(now() - answeredAt),
        sockets: stats !== undefined,
        ...(stats === undefined
          ? {}
          : {
              owned: stats.owned,
              sessions: stats.running,
              starting: stats.starting,
              cap,
              cappedOut: stats.cappedOut,
              shed,
            }),
        rssMb: Math.round(process.memoryUsage().rss / MIB),
        eventLoopLagP99Ms: lagP99Ms(),
      },
      'worker capacity',
    );
  }

  return {
    start() {
      if (timer !== undefined) return;
      lag = monitorEventLoopDelay({ resolution: 20 });
      lag.enable();
      timer = setInterval(report, deps.intervalMs);
    },
    report,
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      lag?.disable();
    },
  };
}
