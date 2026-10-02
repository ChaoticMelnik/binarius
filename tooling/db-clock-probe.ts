import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';

// Watches the test database's clock against this process's. The time-order CHECKs
// (`*_after_created`, `code_sent_at >= created_at`) compare one transaction's now() with a later
// one's and fail on a step back; tests that compare a column with Date.now() fail when the two
// clocks disagree. A Postgres in the Colima VM did both: the Lima agent stepped its clock back
// ~100 ms every 10 s, and after a Mac sleep it lagged by tens of minutes (#166, README → Test
// database).
//
// Exit codes: 0 clean; 1 a step back or a skew past SKEW_LIMIT_MS; 2 no sample at all (a probe
// that measured nothing must not read as a clean clock); 64 bad usage; 70 the probe itself failed.

export const SKEW_LIMIT_MS = 1_000;
const USAGE =
  'usage: node tooling/db-clock-probe.ts [--seconds N] [--log FILE]  (TEST_DATABASE_URL)';
const SAMPLE_INTERVAL_MS = 5;
const SUMMARY_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 1_000;

export interface ClockSample {
  dbUs: bigint;
  // the middle of the round trip, so the query's own latency splits evenly around it
  hostMs: number;
}

export interface Classified {
  stepBackUs: bigint | undefined;
  skewMs: number;
  skewed: boolean;
}

export function classifySample(
  previous: ClockSample | undefined,
  current: ClockSample,
  skewLimitMs: number = SKEW_LIMIT_MS,
): Classified {
  const stepBackUs =
    previous !== undefined && current.dbUs < previous.dbUs
      ? previous.dbUs - current.dbUs
      : undefined;
  const skewMs = Number(current.dbUs) / 1000 - current.hostMs;
  return { stepBackUs, skewMs, skewed: Math.abs(skewMs) > skewLimitMs };
}

export function exitCode(samples: number, steps: number, skewedSamples: number): number {
  if (samples === 0) return 2;
  return steps > 0 || skewedSamples > 0 ? 1 : 0;
}

// microseconds since the epoch as text, because a JS Date would round a sub-millisecond step away
const SAMPLE_SQL = 'select (extract(epoch from clock_timestamp()) * 1000000)::bigint::text as us';

function main(): void {
  let values: { seconds?: string; log?: string };
  try {
    ({ values } = parseArgs({ options: { seconds: { type: 'string' }, log: { type: 'string' } } }));
  } catch {
    console.error(USAGE);
    process.exit(64);
  }
  const url = process.env.TEST_DATABASE_URL;
  const seconds = values.seconds === undefined ? undefined : Number(values.seconds);
  if (url === undefined || !URL.canParse(url) || (seconds !== undefined && !(seconds > 0))) {
    console.error(USAGE);
    process.exit(64);
  }
  const logFile = values.log;

  function log(line: string): void {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    if (logFile !== undefined) appendFileSync(logFile, `${stamped}\n`);
  }

  let samples = 0;
  let steps = 0;
  let largestStepUs = 0n;
  let skewedSamples = 0;
  let worstSkewMs = 0;
  let skewLoggedAt: number | undefined;
  let previous: ClockSample | undefined;
  let client: pg.Client | undefined;
  let stopping = false;

  function summary(label: string): void {
    log(
      `${label}: ${samples} samples, ${steps} steps back, largest ${Number(largestStepUs) / 1000} ms, ` +
        `${skewedSamples} skewed samples, worst ${worstSkewMs.toFixed(0)} ms`,
    );
  }

  async function connect(): Promise<pg.Client> {
    const next = new pg.Client({ connectionString: url });
    // without a listener an idle connection dropped by the server crashes the process
    next.on('error', () => {});
    await next.connect();
    return next;
  }

  async function sample(active: pg.Client): Promise<void> {
    const sentMs = Date.now();
    const result = await active.query<{ us: string }>(SAMPLE_SQL);
    const hostMs = (sentMs + Date.now()) / 2;
    const row = result.rows[0];
    if (row === undefined) throw new Error('clock_timestamp() returned no row');
    const current = { dbUs: BigInt(row.us), hostMs };
    const verdict = classifySample(previous, current);
    samples += 1;
    if (verdict.stepBackUs !== undefined) {
      steps += 1;
      if (verdict.stepBackUs > largestStepUs) largestStepUs = verdict.stepBackUs;
      log(
        `STEP BACK ${Number(verdict.stepBackUs) / 1000} ms (sample gap ${hostMs - (previous?.hostMs ?? hostMs)} ms, db-host ${verdict.skewMs.toFixed(0)} ms)`,
      );
    }
    if (Math.abs(verdict.skewMs) > Math.abs(worstSkewMs)) worstSkewMs = verdict.skewMs;
    if (verdict.skewed) {
      skewedSamples += 1;
      // on entering the state and every summary interval inside it, not on every 5 ms sample
      if (skewLoggedAt === undefined || hostMs - skewLoggedAt >= SUMMARY_INTERVAL_MS) {
        log(`SKEW db-host ${verdict.skewMs.toFixed(0)} ms (limit ±${SKEW_LIMIT_MS} ms)`);
        skewLoggedAt = hostMs;
      }
    } else {
      skewLoggedAt = undefined;
    }
    previous = current;
  }

  function stop(): void {
    if (stopping) return;
    stopping = true;
    summary('final');
    void client?.end().catch(() => {});
    process.exit(exitCode(samples, steps, skewedSamples));
  }

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (seconds !== undefined) setTimeout(stop, seconds * 1000);
  setInterval(() => summary('summary'), SUMMARY_INTERVAL_MS).unref();

  log(`probing ${new URL(url).host} every ${SAMPLE_INTERVAL_MS} ms`);
  void (async () => {
    for (;;) {
      try {
        client ??= await connect();
        await sample(client);
        await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS));
      } catch (error) {
        // a dropped connection is not the end of the run: the clock is still worth watching
        const code = (error as { code?: unknown }).code;
        log(`query failed: ${(error as Error).name}${typeof code === 'string' ? ` ${code}` : ''}`);
        void client?.end().catch(() => {});
        client = undefined;
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
      }
    }
  })().catch(fail);
}

function fail(error: unknown): never {
  console.error(`db-clock-probe failed: ${(error as Error).name}: ${(error as Error).message}`);
  process.exit(70);
}

if (import.meta.main) {
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  main();
}
