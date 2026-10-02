import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';

// Watches the Postgres clock for steps backwards. The time-order CHECKs (`*_after_created`,
// `code_sent_at >= created_at`) compare one transaction's now() with a later one's; they hold on
// a monotonic clock and fail on a step back, which the Colima VM's lima-guestagent used to make
// every few tens of seconds (#166, README → The VM clock). Exit 1 when it saw a step back, 2 when
// it never got a sample — a probe that measured nothing must not read as a clean clock.

const USAGE = 'usage: node tooling/db-clock-probe.ts [--seconds N] [--log FILE]  (DATABASE_URL)';
const SAMPLE_INTERVAL_MS = 5;
const SUMMARY_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 1_000;

const { values } = parseArgs({
  options: { seconds: { type: 'string' }, log: { type: 'string' } },
});
const url = process.env.DATABASE_URL;
const seconds = values.seconds === undefined ? undefined : Number(values.seconds);
if (url === undefined || !URL.canParse(url) || (seconds !== undefined && !(seconds > 0))) {
  console.error(USAGE);
  process.exit(64);
}

function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  if (values.log !== undefined) appendFileSync(values.log, `${stamped}\n`);
}

// microseconds since the epoch as text, because a JS Date would round a sub-millisecond step away
const SAMPLE_SQL = 'select (extract(epoch from clock_timestamp()) * 1000000)::bigint::text as us';

let samples = 0;
let steps = 0;
let largestStepUs = 0n;
let previous: { dbUs: bigint; hostMs: number } | undefined;
let client: pg.Client | undefined;
let stopping = false;

function summary(label: string): void {
  log(
    `${label}: ${samples} samples, ${steps} steps back, largest ${Number(largestStepUs) / 1000} ms`,
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
  const result = await active.query<{ us: string }>(SAMPLE_SQL);
  const hostMs = Date.now();
  const row = result.rows[0];
  if (row === undefined) throw new Error('clock_timestamp() returned no row');
  const dbUs = BigInt(row.us);
  samples += 1;
  if (previous !== undefined && dbUs < previous.dbUs) {
    const stepUs = previous.dbUs - dbUs;
    steps += 1;
    if (stepUs > largestStepUs) largestStepUs = stepUs;
    const skewMs = Number(dbUs / 1000n) - hostMs;
    log(
      `STEP BACK ${Number(stepUs) / 1000} ms (sample gap ${hostMs - previous.hostMs} ms, db-host ${skewMs} ms)`,
    );
  }
  previous = { dbUs, hostMs };
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  summary('final');
  void client?.end().catch(() => {});
  process.exit(samples === 0 ? 2 : steps > 0 ? 1 : 0);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (seconds !== undefined) setTimeout(stop, seconds * 1000);
setInterval(() => summary('summary'), SUMMARY_INTERVAL_MS).unref();

log(`probing ${new URL(url).host} every ${SAMPLE_INTERVAL_MS} ms`);
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
