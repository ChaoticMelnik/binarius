import type { FastifyBaseLogger } from 'fastify';
import {
  DecisionTicksDetail,
  DecisionTicksStatus,
  errorLogFields,
  SignalDecisionContext,
  TradeIntentStatus,
} from '@binarius/shared';
import {
  BrokerTradeStatus,
  insertDecisionTicks,
  listDecisionTicksCandidates,
  sweepSignalDecisions,
  type DecisionTicksCandidate,
  type DecisionTicksInsert,
  type Db,
} from '@binarius/db';
import type { TickStore } from '../market-data/ticks';
import {
  MARKET_DATA_SKEW_MARGIN_MS,
  SIGNAL_DECISION_RETENTION_DAYS,
  SIGNAL_DECISION_SHADOW_RETENTION_DAYS,
  SIGNAL_DECISION_SWEEP_BATCH,
  SIGNAL_DECISION_SWEEP_MAX_BATCHES,
  SIGNAL_DECISION_SWEEP_MS,
  TRADE_TICKS_AFTER_CLOSE_MS,
  TRADE_TICKS_BEFORE_MS,
  TRADE_TICKS_HORIZON_MS,
  TRADE_TICKS_INSERT_CHUNK,
  TRADE_TICKS_MAX_WAIT_MS,
  TRADE_TICKS_SCAN_LIMIT,
  TRADE_TICKS_SCAN_MS,
} from '../timing';

// The trade log keeper (#668, docs/trade-log.md → The ticks around a decision, → Retention): it
// writes one decision_ticks row per captured decision when its window has closed, and sweeps the
// decisions without a trade past their retention. Every ending of a candidate is a row of the
// table in docs/trade-log.md.

export interface TradeLogKeeperConfig {
  scanMs: number;
  horizonMs: number;
  beforeMs: number;
  afterCloseMs: number;
  maxWaitMs: number;
  skewMarginMs: number;
  scanLimit: number;
  insertChunk: number;
  sweepMs: number;
  retentionDays: number;
  shadowRetentionDays: number;
  sweepBatch: number;
  sweepMaxBatches: number;
}

const DEFAULT_TRADE_LOG_KEEPER_CONFIG: TradeLogKeeperConfig = {
  scanMs: TRADE_TICKS_SCAN_MS,
  horizonMs: TRADE_TICKS_HORIZON_MS,
  beforeMs: TRADE_TICKS_BEFORE_MS,
  afterCloseMs: TRADE_TICKS_AFTER_CLOSE_MS,
  maxWaitMs: TRADE_TICKS_MAX_WAIT_MS,
  skewMarginMs: MARKET_DATA_SKEW_MARGIN_MS,
  scanLimit: TRADE_TICKS_SCAN_LIMIT,
  insertChunk: TRADE_TICKS_INSERT_CHUNK,
  sweepMs: SIGNAL_DECISION_SWEEP_MS,
  retentionDays: SIGNAL_DECISION_RETENTION_DAYS,
  shadowRetentionDays: SIGNAL_DECISION_SHADOW_RETENTION_DAYS,
  sweepBatch: SIGNAL_DECISION_SWEEP_BATCH,
  sweepMaxBatches: SIGNAL_DECISION_SWEEP_MAX_BATCHES,
};

export interface TradeLogKeeperOps {
  candidates: typeof listDecisionTicksCandidates;
  insert: typeof insertDecisionTicks;
  sweep: typeof sweepSignalDecisions;
}

export interface TradeLogKeeperDeps {
  db: Db;
  // undefined without BROKER_WS_URL: no capture timer, the sweep only
  ticks: Pick<TickStore, 'between' | 'watermark'> | undefined;
  ops?: Partial<TradeLogKeeperOps>;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  now?: () => number;
  config?: Partial<TradeLogKeeperConfig>;
}

export interface TradeLogKeeper {
  capture(): Promise<void>;
  sweep(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

// the window's end of a due candidate; undefined while it is not due (an open trade, an intent in
// flight, before the max wait)
function windowEnd(
  candidate: DecisionTicksCandidate,
  now: number,
  config: TradeLogKeeperConfig,
): { untilMs: number; maxWait: boolean } | undefined {
  const cut = candidate.decidedAtMs + config.maxWaitMs;
  if (candidate.context === SignalDecisionContext.Shadow) {
    return { untilMs: candidate.ticksUntilMs ?? Number.NaN, maxWait: false };
  }
  let end: number | undefined;
  if (candidate.tradeStatus === BrokerTradeStatus.Closed && candidate.closeTimestampMs !== null) {
    end = candidate.closeTimestampMs + config.afterCloseMs;
  } else if (
    (candidate.intentStatus === TradeIntentStatus.Rejected ||
      candidate.intentStatus === TradeIntentStatus.Settled) &&
    candidate.intentUpdatedAtMs !== null
  ) {
    end = candidate.intentUpdatedAtMs + config.afterCloseMs;
  }
  // a trade longer than the max wait is cut there too: past it the buffer may have pruned the start
  if (end !== undefined && end <= cut) return { untilMs: end, maxWait: false };
  return now >= cut ? { untilMs: cut, maxWait: true } : undefined;
}

export function createTradeLogKeeper(deps: TradeLogKeeperDeps): TradeLogKeeper {
  const { db, ticks, logger } = deps;
  const config = { ...DEFAULT_TRADE_LOG_KEEPER_CONFIG, ...deps.config };
  const ops: TradeLogKeeperOps = {
    candidates: listDecisionTicksCandidates,
    insert: insertDecisionTicks,
    sweep: sweepSignalDecisions,
    ...deps.ops,
  };
  const now = deps.now ?? Date.now;
  let stopped = false;
  let capturing: Promise<void> | undefined;
  let sweeping: Promise<void> | undefined;
  let captureTimer: NodeJS.Timeout | undefined;
  let sweepTimer: NodeJS.Timeout | undefined;
  // a writer's defect is said once per decision per process, not on every tick
  const warnedInvalid = new Set<string>();

  async function runCapture(): Promise<void> {
    if (ticks === undefined) return;
    const at = now();
    const candidates = await ops.candidates(db, {
      horizonMs: config.horizonMs,
      limit: config.scanLimit,
    });
    const rows: DecisionTicksInsert[] = [];
    let waiting = 0;
    let invalidWindow = 0;
    for (const candidate of candidates) {
      const end = windowEnd(candidate, at, config);
      if (end === undefined) {
        waiting += 1;
        continue;
      }
      const fromMs = candidate.decidedAtMs - config.beforeMs;
      const { untilMs } = end;
      if (
        !Number.isFinite(untilMs) ||
        !Number.isFinite(fromMs) ||
        fromMs <= 0 ||
        untilMs <= fromMs
      ) {
        invalidWindow += 1;
        if (!warnedInvalid.has(candidate.id)) {
          warnedInvalid.add(candidate.id);
          logger.warn(
            { decisionId: candidate.id, fromMs, untilMs },
            'trade log ticks invalid window',
          );
        }
        continue;
      }
      const watermark = ticks.watermark(candidate.assetId);
      const closed =
        (watermark !== undefined && watermark >= untilMs) || at >= untilMs + config.skewMarginMs;
      if (!closed) {
        waiting += 1;
        continue;
      }
      const window = ticks.between(candidate.assetId, fromMs, untilMs);
      const count = window.ticks.length;
      const detail =
        window.coverage === 'uncovered'
          ? DecisionTicksDetail.Uncovered
          : window.coverage === 'hole'
            ? DecisionTicksDetail.Hole
            : end.maxWait
              ? DecisionTicksDetail.MaxWait
              : count === 0
                ? DecisionTicksDetail.Quiet
                : null;
      const status =
        count === 0
          ? DecisionTicksStatus.Unavailable
          : detail === null
            ? DecisionTicksStatus.Complete
            : DecisionTicksStatus.Truncated;
      rows.push({
        decisionId: candidate.id,
        fromMs,
        untilMs,
        status,
        detail,
        count,
        ticks: window.ticks.map((tick) => [tick.timestamp, tick.receivedAtMs, tick.price]),
      });
    }
    const captured = { complete: 0, truncated: 0, unavailable: 0 };
    for (let i = 0; i < rows.length; i += config.insertChunk) {
      if (stopped) break;
      const chunk = rows.slice(i, i + config.insertChunk);
      try {
        await ops.insert(db, chunk);
        for (const row of chunk) captured[row.status] += 1;
      } catch (error) {
        logger.warn(
          { ...errorLogFields(error), rows: chunk.length },
          'trade log ticks insert failed',
        );
      }
    }
    if (rows.length > 0 || invalidWindow > 0) {
      logger.info(
        { scanned: candidates.length, captured, waiting, invalidWindow },
        'trade log ticks',
      );
    }
  }

  async function runSweep(): Promise<void> {
    let decisions = 0;
    let removedTicks = 0;
    let batches = 0;
    while (!stopped && batches < config.sweepMaxBatches) {
      const batch = await ops.sweep(db, {
        retentionDays: config.retentionDays,
        shadowRetentionDays: config.shadowRetentionDays,
        batch: config.sweepBatch,
      });
      batches += 1;
      decisions += batch.decisions;
      removedTicks += batch.ticks;
      if (batch.decisions < config.sweepBatch) break;
    }
    if (decisions > 0) {
      logger.info({ decisions, ticks: removedTicks, batches }, 'trade log sweep');
    }
  }

  // a tick longer than its interval makes the next one a no-op
  function capture(): Promise<void> {
    if (stopped) return Promise.resolve();
    capturing ??= runCapture()
      .catch((error: unknown) => logger.error(errorLogFields(error), 'trade log ticks tick failed'))
      .finally(() => {
        capturing = undefined;
      });
    return capturing;
  }

  function sweep(): Promise<void> {
    if (stopped) return Promise.resolve();
    sweeping ??= runSweep()
      .catch((error: unknown) => logger.error(errorLogFields(error), 'trade log sweep failed'))
      .finally(() => {
        sweeping = undefined;
      });
    return sweeping;
  }

  return {
    capture,
    sweep,
    start() {
      if (stopped || sweepTimer !== undefined) return;
      if (ticks !== undefined) captureTimer = setInterval(() => void capture(), config.scanMs);
      sweepTimer = setInterval(() => void sweep(), config.sweepMs);
    },
    async stop() {
      stopped = true;
      clearInterval(captureTimer);
      clearInterval(sweepTimer);
      captureTimer = undefined;
      sweepTimer = undefined;
      await Promise.all([capturing, sweeping]);
    },
  };
}
