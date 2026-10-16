import { BrokerRestError, type BrokerRestClient } from '@binarius/broker-rest';
import {
  BrokerRestErrorCode,
  comparePairsByPayout,
  isPairOpen,
  pairAcceptsDuration,
  pairPayoutAccepted,
  PAIR_TYPE_GROUPS,
  pairTypeGroupOf,
  type BinaryPair,
  type Candle,
  type PairTypeGroup,
} from '@binarius/shared';
import {
  assertDigits,
  createCandleBuilder,
  createSignalDecider,
  type CandleBuilder,
} from '@binarius/signal';
import { BrokerEventType, type BrokerEvent } from '../broker/events';
import {
  BrokerSocketState,
  isTerminalBrokerSocketState,
  type BrokerCredentials,
  type BrokerSocketClient,
} from '../broker/socket';
import { chunkAssets } from '../broker/subscriptions';
import {
  compareAggregation,
  compareDecisions,
  compareSeries,
  type CandleComparison,
  type DecisionComparison,
  type SeriesRange,
  type Span,
} from './candle-spike-compare';

// The wiring of the candle spike (#392, docs/broker-socket.md -> The candle spike): one socket of
// the account, phase A (how many subscribed ids the broker serves), phase B (ticks of the chosen pairs into candle builders for
// SPIKE_MINUTES, with the receipt delay, the state changes and the process load), then the same
// window from the public chart and the comparison. Writes nothing to the database, sends no
// trade command, prints no token, URL, payload or broker user id.

export const READY_TIMEOUT_MS = 15_000;
export const CAPACITY_WINDOW_MS = 60_000;
export const REST_PACE_MS = 500;
export const PROGRESS_EVERY_MS = 300_000;
export const SAMPLE_EVERY_MS = 60_000;
// a 429 without Retry-After
const RATE_LIMIT_WAIT_MS = 60_000;
const WAIT_STEP_MS = 1_000;
const SETUP_STEP_MS = 50;

export const SPIKE_INTERVALS = [
  { name: '5s', ms: 5_000 },
  { name: '15s', ms: 15_000 },
] as const;
export type SpikeIntervalName = (typeof SPIKE_INTERVALS)[number]['name'];
// the broker's 1 s chart, end-labelled; a CLI constant, SIGNAL_CHART_INTERVAL_MS is not touched
export const PRICE_INTERVAL = '1s';
// the pair choice and the tick floor are read at the shortest trade the spike serves
const SPIKE_DURATION_SEC = 5;

export interface SpikeTiming {
  readyTimeoutMs: number;
  capacityWindowMs: number;
  restPaceMs: number;
  progressEveryMs: number;
  sampleEveryMs: number;
}

export const SPIKE_TIMING: SpikeTiming = {
  readyTimeoutMs: READY_TIMEOUT_MS,
  capacityWindowMs: CAPACITY_WINDOW_MS,
  restPaceMs: REST_PACE_MS,
  progressEveryMs: PROGRESS_EVERY_MS,
  sampleEveryMs: SAMPLE_EVERY_MS,
};

export interface SpikeOptions {
  minutes: number;
  pairs: number;
  assetIds?: readonly number[];
  subscribeAll: boolean;
}

export interface ProcessSample {
  cpuMicros: number;
  rssBytes: number;
}

export interface SpikeDeps {
  openClient(label: string): BrokerSocketClient;
  rest: Pick<BrokerRestClient, 'listPairs' | 'getChart'>;
  credentials: BrokerCredentials;
  now(): number;
  // always waits ms, after SIGINT too (the fetch keeps its pace); the loops read stop themselves
  sleep(ms: number): Promise<void>;
  say(line: string): void;
  sample(): ProcessSample;
  // SIGINT: phase B ends early, the fetch and the comparison still run
  stop: AbortSignal;
  timing: SpikeTiming;
  options: SpikeOptions;
}

export interface ChosenPair {
  id: number;
  symbol: string;
  digits: number;
  payout: number;
  group: PairTypeGroup;
}

export interface PairChoice {
  chosen: ChosenPair[];
  skippedDigits: number;
  emptyGroups: PairTypeGroup[];
}

const digitsValid = (digits: number) => {
  try {
    assertDigits(digits);
    return true;
  } catch {
    return false;
  }
};

const toChosen = (pair: BinaryPair): ChosenPair => ({
  id: pair.id,
  symbol: pair.symbol,
  digits: pair.digits,
  payout: pair.payout,
  group: pairTypeGroupOf(pair.type),
});

// The scanner's rule (#460) without its rotation: one pair per type group in PAIR_TYPE_GROUPS
// order, round after round, best payout first inside a group.
export function choosePairs(
  pairs: readonly BinaryPair[],
  nowMs: number,
  count: number,
): PairChoice {
  let skippedDigits = 0;
  const groups = new Map<PairTypeGroup, BinaryPair[]>();
  for (const pair of pairs) {
    if (!isPairOpen(pair, nowMs) || !pairAcceptsDuration(pair, SPIKE_DURATION_SEC)) continue;
    if (!pairPayoutAccepted(pair)) continue;
    if (!digitsValid(pair.digits)) {
      skippedDigits += 1;
      continue;
    }
    const group = pairTypeGroupOf(pair.type);
    groups.set(group, [...(groups.get(group) ?? []), pair]);
  }
  for (const members of groups.values()) members.sort(comparePairsByPayout);
  const chosen: ChosenPair[] = [];
  for (let round = 0; chosen.length < count; round++) {
    const taken = PAIR_TYPE_GROUPS.map((group) => groups.get(group)?.[round]).filter(
      (pair): pair is BinaryPair => pair !== undefined,
    );
    if (taken.length === 0) break;
    for (const pair of taken.slice(0, count - chosen.length)) chosen.push(toChosen(pair));
  }
  const emptyGroups = PAIR_TYPE_GROUPS.filter((group) => !groups.has(group));
  return { chosen, skippedDigits, emptyGroups };
}

// The broker's first chart row has open = the first tick inside the requested window, not the
// previous close (docs/signal-stand.md -> The cache): every request starts one step early and
// this drops that row, whatever its timestamp.
export const dropFirstRow = (rows: readonly Candle[]): Candle[] => rows.slice(1);

export interface ChunkCoverage {
  size: number;
  withTicks: number;
}

export interface CapacityResult {
  subscribed: number;
  withTicks: number;
  open: { subscribed: number; withTicks: number };
  closed: { subscribed: number; withTicks: number };
  chunks: ChunkCoverage[];
  firstTickDelayMs?: { median: number; max: number };
  // the window was cut short: its coverage is no cap
  cut?: 'interrupted' | 'a drop';
}

export interface StateChangeRecord {
  at: number;
  from: string;
  to: string;
  reason?: string;
  watermark?: number;
}

export interface HoleRecord {
  // local clock: the first drop -> the last return to ready before the first tick (or the end of
  // phase B)
  leftAt: number;
  backAt?: number;
  // broker time: the last tick before it -> the first tick after it
  span: Span;
}

export type SeriesStatus = { ok: true } | { ok: false; code: string };

export interface IntervalResult {
  interval: SpikeIntervalName;
  range?: SeriesRange;
  rest: SeriesStatus;
  candles?: CandleComparison;
  decisions?: DecisionComparison;
  aggregation?: CandleComparison;
  aggregationRest: SeriesStatus;
}

export interface PairResult {
  pair: ChosenPair;
  ticks: number;
  intervals: IntervalResult[];
}

export interface Distribution {
  count: number;
  median: number;
  p95: number;
  min: number;
}

export interface SpikeReportInput {
  startedAt: number;
  minutes: number;
  interrupted: boolean;
  // a terminal state that ended phase B
  endedBy?: string;
  phaseBMs: number;
  choice: PairChoice;
  operatorChoice: boolean;
  catalog: { rest: number; socket: number; socketOnly: number; restOnly: number };
  capacity: CapacityResult;
  pairs: PairResult[];
  delay?: Distribution;
  ticks: { total: number; late: number; invalid: number };
  process: { cpuPct?: number; maxRssMb?: number };
  stateChanges: StateChangeRecord[];
  holes: HoleRecord[];
}

export type SpikeRun =
  | { kind: 'setup_failed'; what: string }
  | { kind: 'ran'; report: SpikeReportInput; compared: number; windowCompleted: boolean };

const sorted = (values: readonly number[]) => [...values].sort((a, b) => a - b);

export function distribution(values: readonly number[]): Distribution | undefined {
  if (values.length === 0) return undefined;
  const s = sorted(values);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { count: s.length, median: at(0.5), p95: at(0.95), min: s[0]! };
}

export async function runSpike(deps: SpikeDeps): Promise<SpikeRun> {
  const { timing, options, say } = deps;
  const startedAt = deps.now();

  let restPairs: BinaryPair[];
  try {
    restPairs = await deps.rest.listPairs();
  } catch (error) {
    if (!(error instanceof BrokerRestError)) throw error;
    return { kind: 'setup_failed', what: `pairs catalog: ${error.code}` };
  }

  let choice: PairChoice;
  if (options.assetIds !== undefined) {
    const chosen: ChosenPair[] = [];
    for (const [index, id] of options.assetIds.entries()) {
      const pair = restPairs.find((candidate) => candidate.id === id);
      // the index, not the id: ids are the operator's data
      if (pair === undefined) return { kind: 'setup_failed', what: `unknown asset id ${index}` };
      if (!digitsValid(pair.digits)) {
        return { kind: 'setup_failed', what: `asset id ${index} has digits out of range` };
      }
      chosen.push(toChosen(pair));
    }
    choice = { chosen, skippedDigits: 0, emptyGroups: [] };
  } else {
    choice = choosePairs(restPairs, startedAt, options.pairs);
    if (choice.chosen.length === 0) return { kind: 'setup_failed', what: 'no pair to compare' };
  }
  const chosenIds = new Set(choice.chosen.map((pair) => pair.id));

  type Phase = 'setup' | 'A' | 'B' | 'done';
  let phase: Phase = 'setup';
  let socketPairs: BinaryPair[] | undefined;
  let ownUser = false;
  let foreignUser = false;
  let watermark: number | undefined;
  const stateChanges: StateChangeRecord[] = [];
  const holes: HoleRecord[] = [];
  let openHole: HoleRecord | undefined;
  let terminal: string | undefined;
  let droppedInA = false;

  const firstTickAt = new Map<number, number>();
  const builders = new Map<number, Record<SpikeIntervalName, CandleBuilder>>();
  const tickSpan = new Map<number, { first: number; last: number; count: number }>();
  const delays: number[] = [];
  let phaseBTicks = 0;
  const capacity = options.minutes * 12 + 4;
  for (const pair of choice.chosen) {
    builders.set(pair.id, {
      '5s': createCandleBuilder({ intervalMs: 5_000, digits: pair.digits, capacity }),
      '15s': createCandleBuilder({ intervalMs: 15_000, digits: pair.digits, capacity }),
    });
  }

  const client = deps.openClient('A');
  client.onState((change) => {
    if (phase === 'done') return;
    if (phase === 'A' || phase === 'B') {
      stateChanges.push({
        at: deps.now(),
        from: change.from,
        to: change.to,
        ...(change.reason === undefined ? {} : { reason: change.reason }),
        ...(watermark === undefined ? {} : { watermark }),
      });
    }
    const left = change.from === BrokerSocketState.Ready && change.to !== BrokerSocketState.Ready;
    if (phase === 'A' && left) droppedInA = true;
    if (phase === 'B') {
      if (left && openHole !== undefined) {
        // no tick since the last drop: the same gap in the tick series, one hole
        delete openHole.backAt;
      } else if (left) {
        const from = watermark ?? deps.now();
        openHole = { leftAt: deps.now(), span: { fromMs: from, toMs: Number.POSITIVE_INFINITY } };
        holes.push(openHole);
      }
      if (change.to === BrokerSocketState.Ready && openHole !== undefined) {
        openHole.backAt = deps.now();
      }
    }
    if (isTerminalBrokerSocketState(change.to)) terminal = change.to;
  });
  client.onEvent((event: BrokerEvent) => {
    if (phase === 'done') return;
    if (event.type === BrokerEventType.UserData) {
      if (event.user.id === deps.credentials.brokerUserId) ownUser = true;
      else foreignUser = true;
      return;
    }
    if (event.type === BrokerEventType.AssetsList) {
      socketPairs ??= event.pairs;
      return;
    }
    if (event.type !== BrokerEventType.PriceUpdate) return;
    const { assetId, price, timestamp } = event.update;
    if (phase === 'A') {
      if (!firstTickAt.has(assetId)) firstTickAt.set(assetId, deps.now());
      return;
    }
    if (phase !== 'B') return;
    phaseBTicks += 1;
    delays.push(deps.now() - timestamp);
    const pairBuilders = builders.get(assetId);
    if (pairBuilders === undefined) return;
    for (const { name } of SPIKE_INTERVALS) pairBuilders[name].push({ price, timestamp });
    const span = tickSpan.get(assetId);
    if (span === undefined) tickSpan.set(assetId, { first: timestamp, last: timestamp, count: 1 });
    else {
      span.last = Math.max(span.last, timestamp);
      span.count += 1;
    }
    watermark = watermark === undefined ? timestamp : Math.max(watermark, timestamp);
    if (openHole?.backAt !== undefined && openHole.span.toMs === Number.POSITIVE_INFINITY) {
      openHole.span.toMs = timestamp;
      openHole = undefined;
    }
  });
  client.start(deps.credentials);

  const deadline = deps.now() + timing.readyTimeoutMs;
  for (;;) {
    if (deps.stop.aborted) return { kind: 'setup_failed', what: 'interrupted' };
    if (foreignUser) return { kind: 'setup_failed', what: 'user.data of another user' };
    const missing = [
      client.state === BrokerSocketState.Ready ? undefined : 'ready',
      ownUser ? undefined : 'user.data',
      socketPairs === undefined ? 'assets_list' : undefined,
    ].filter((fact): fact is string => fact !== undefined);
    if (missing.length === 0) break;
    if (deps.now() >= deadline) {
      return {
        kind: 'setup_failed',
        what: `not within ${timing.readyTimeoutMs} ms: ${missing.join(', ')}`,
      };
    }
    await deps.sleep(SETUP_STEP_MS);
  }
  const socketCatalog = socketPairs ?? [];
  const restIds = new Set(restPairs.map((pair) => pair.id));
  const socketIds = new Set(socketCatalog.map((pair) => pair.id));
  const catalog = {
    rest: restIds.size,
    socket: socketIds.size,
    socketOnly: [...socketIds].filter((id) => !restIds.has(id)).length,
    restOnly: [...restIds].filter((id) => !socketIds.has(id)).length,
  };

  for (const pair of choice.chosen) {
    say(`pair ${pair.id} ${pair.symbol} digits ${pair.digits} payout ${pair.payout} ${pair.group}`);
  }

  // phase A: capacity
  phase = 'A';
  say('phase A: subscription capacity');
  const subscribeAt = deps.now();
  client.subscribe(
    options.subscribeAll ? [...new Set([...socketIds, ...chosenIds])] : [...chosenIds],
  );
  await waitFor(deps, timing.capacityWindowMs);
  const capacityResult = measureCapacity(client.subscriptions(), socketCatalog, firstTickAt, {
    subscribeAt,
    nowMs: deps.now(),
  });
  const cut = deps.stop.aborted ? 'interrupted' : droppedInA ? 'a drop' : undefined;
  if (cut !== undefined) capacityResult.cut = cut;

  // phase B: accuracy
  phase = 'B';
  const phaseBStart = deps.now();
  const phaseBEnd = phaseBStart + options.minutes * 60_000;
  say(`phase B: ${options.minutes} min on ${choice.chosen.length} pairs`);
  const samples: (ProcessSample & { at: number })[] = [{ ...deps.sample(), at: deps.now() }];
  let nextSample = phaseBStart + timing.sampleEveryMs;
  let nextProgress = phaseBStart + timing.progressEveryMs;
  while (deps.now() < phaseBEnd && !deps.stop.aborted && terminal === undefined) {
    await deps.sleep(Math.min(WAIT_STEP_MS, phaseBEnd - deps.now()));
    const now = deps.now();
    if (now >= nextSample) {
      samples.push({ ...deps.sample(), at: now });
      nextSample += timing.sampleEveryMs;
    }
    if (now >= nextProgress) {
      say(`phase B: ${Math.round((now - phaseBStart) / 60_000)} min, ${phaseBTicks} ticks`);
      nextProgress += timing.progressEveryMs;
    }
  }
  const phaseBStop = deps.now();
  samples.push({ ...deps.sample(), at: phaseBStop });
  const interrupted = deps.stop.aborted && phaseBStop < phaseBEnd;
  const windowCompleted = phaseBStop >= phaseBEnd && terminal === undefined;
  for (const hole of holes) {
    // no tick after it: the hole runs to the end of phase B
    if (hole.span.toMs === Number.POSITIVE_INFINITY) hole.span.toMs = phaseBStop;
  }
  phase = 'done';
  client.stop();

  // the REST fetch and the comparison
  say('fetching the same window from the chart');
  const pacer = { first: true };
  const decider = createSignalDecider();
  const holeSpans = holes.map((hole) => hole.span);
  const pairs: PairResult[] = [];
  let compared = 0;
  for (const pair of choice.chosen) {
    const span = tickSpan.get(pair.id);
    const pairBuilders = builders.get(pair.id)!;
    const intervals: IntervalResult[] = [];
    if (span === undefined) {
      for (const { name } of SPIKE_INTERVALS) {
        const none: SeriesStatus = { ok: false, code: 'no_ticks' };
        intervals.push({ interval: name, rest: none, aggregationRest: none });
      }
      pairs.push({ pair, ticks: 0, intervals });
      continue;
    }
    const ranges = Object.fromEntries(
      SPIKE_INTERVALS.map(({ name, ms }) => [name, rangeOf(span, ms)]),
    ) as Record<SpikeIntervalName, SeriesRange | undefined>;
    const range5 = ranges['5s'];
    const seconds =
      range5 === undefined
        ? undefined
        : await fetchSeries(deps, pacer, {
            assetId: pair.id,
            interval: PRICE_INTERVAL,
            startTime: range5.firstMs,
            limit: options.minutes * 60 + 6,
          });
    for (const { name, ms } of SPIKE_INTERVALS) {
      const range = ranges[name];
      if (range === undefined) {
        const none: SeriesStatus = { ok: false, code: 'no_full_candle' };
        intervals.push({ interval: name, rest: none, aggregationRest: none });
        continue;
      }
      const native = await fetchSeries(deps, pacer, {
        assetId: pair.id,
        interval: name,
        startTime: range.firstMs - ms,
        limit: (range.lastMs - range.firstMs) / ms + 1 + 3,
      });
      const context = { range, intervalMs: ms, digits: pair.digits, holes: holeSpans };
      const result: IntervalResult = {
        interval: name,
        range,
        rest: native.ok ? { ok: true } : native,
        aggregationRest:
          seconds === undefined
            ? { ok: false, code: 'no_full_candle' }
            : seconds.ok
              ? { ok: true }
              : seconds,
      };
      if (native.ok) {
        const ticks = pairBuilders[name].candles();
        result.candles = compareSeries(ticks, native.rows, context);
        result.decisions = compareDecisions(ticks, native.rows, { ...context, decider });
        if (seconds?.ok === true) {
          result.aggregation = compareAggregation(seconds.rows, native.rows, context);
        }
        compared += result.candles.compared;
      }
      intervals.push(result);
    }
    pairs.push({ pair, ticks: span.count, intervals });
  }

  const allBuilders = [...builders.values()].flatMap((pair) => Object.values(pair));
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const wallMs = last.at - first.at;
  const delay = distribution(delays);
  const report: SpikeReportInput = {
    startedAt,
    minutes: options.minutes,
    interrupted,
    ...(terminal === undefined ? {} : { endedBy: terminal }),
    phaseBMs: phaseBStop - phaseBStart,
    choice,
    operatorChoice: options.assetIds !== undefined,
    catalog,
    capacity: capacityResult,
    pairs,
    ...(delay === undefined ? {} : { delay }),
    ticks: {
      total: phaseBTicks,
      late: allBuilders.reduce((sum, builder) => sum + builder.late, 0),
      invalid: allBuilders.reduce((sum, builder) => sum + builder.invalid, 0),
    },
    process: {
      ...(wallMs > 0 ? { cpuPct: ((last.cpuMicros - first.cpuMicros) / 1000 / wallMs) * 100 } : {}),
      maxRssMb: Math.max(...samples.map((sample) => sample.rssBytes)) / (1024 * 1024),
    },
    stateChanges,
    holes,
  };
  return { kind: 'ran', report, compared, windowCompleted };
}

// [the first candle after the builder's first, whose open is its own first tick; the last one that
// ended by the last tick]
export function rangeOf(
  span: { first: number; last: number },
  intervalMs: number,
): SeriesRange | undefined {
  const firstMs = Math.floor(span.first / intervalMs) * intervalMs + intervalMs;
  const lastMs = Math.floor(span.last / intervalMs) * intervalMs - intervalMs;
  return lastMs < firstMs ? undefined : { firstMs, lastMs };
}

async function waitFor(deps: SpikeDeps, ms: number) {
  const until = deps.now() + ms;
  while (deps.now() < until && !deps.stop.aborted) {
    await deps.sleep(Math.min(WAIT_STEP_MS, until - deps.now()));
  }
}

function measureCapacity(
  subscribed: readonly number[],
  catalog: readonly BinaryPair[],
  firstTickAt: ReadonlyMap<number, number>,
  clock: { subscribeAt: number; nowMs: number },
): CapacityResult {
  const open = new Set(
    catalog.filter((pair) => isPairOpen(pair, clock.nowMs)).map((pair) => pair.id),
  );
  const ticked = (id: number) => firstTickAt.has(id);
  const count = (ids: readonly number[]) => ({
    subscribed: ids.length,
    withTicks: ids.filter(ticked).length,
  });
  const delays = subscribed.filter(ticked).map((id) => firstTickAt.get(id)! - clock.subscribeAt);
  const delay = distribution(delays);
  return {
    ...count(subscribed),
    open: count(subscribed.filter((id) => open.has(id))),
    closed: count(subscribed.filter((id) => !open.has(id))),
    chunks: chunkAssets(subscribed).map((chunk) => ({
      size: chunk.length,
      withTicks: chunk.filter(ticked).length,
    })),
    ...(delay === undefined
      ? {}
      : { firstTickDelayMs: { median: delay.median, max: sorted(delays).at(-1)! } }),
  };
}

type Fetched = { ok: true; rows: Candle[] } | { ok: false; code: string };

async function fetchSeries(
  deps: SpikeDeps,
  pacer: { first: boolean },
  request: { assetId: number; interval: string; startTime: number; limit: number },
): Promise<Fetched> {
  for (let attempt = 0; ; attempt++) {
    if (!pacer.first) await deps.sleep(deps.timing.restPaceMs);
    pacer.first = false;
    try {
      return { ok: true, rows: dropFirstRow(await deps.rest.getChart(request)) };
    } catch (error) {
      if (!(error instanceof BrokerRestError)) throw error;
      if (error.code === BrokerRestErrorCode.RateLimited && attempt === 0) {
        await deps.sleep(
          error.retryAfterSec === undefined ? RATE_LIMIT_WAIT_MS : error.retryAfterSec * 1000,
        );
        continue;
      }
      return { ok: false, code: error.code };
    }
  }
}
