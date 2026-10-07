import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { pino } from 'pino';
import { brokerAccounts, createDb } from '@binarius/db';
import {
  DATABASE_URL_RULES,
  decimalStringSchema,
  logOptions,
  parseInternalTokenEnv,
  parseLogLevelEnv,
  parseUrlEnv,
  readEnv,
  TradeAction,
  TradeMode,
  type BinaryPair,
  type DecimalString,
} from '@binarius/shared';
import { createBackendAccessTokenSource } from '../broker/access-token';
import { BrokerEventType, type BrokerEvent } from '../broker/events';
import {
  BrokerSocketState,
  createBrokerSocketClient,
  type BrokerSocketClient,
  type SocketOpenTradeResult,
} from '../broker/socket';
import { BACKEND_URL_RULES, BROKER_WS_URL_RULES } from '../env';
import {
  compareDecimal,
  renderVerdict,
  verdict,
  type HeardAnswers,
  type ProbeOutcomes,
} from './socket-probe-verdict';

// The two-socket probe of #101 (docs/broker-socket.md → Observed live): does the live broker send
// an open_trade answer to every socket of a user, or only to the one that sent the command?
// Two sockets, A and B, authenticate with the same account's token; A sends two DEMO commands —
// one at min_trade_amount (expected success) and one below it (expected fail) — and the probe
// prints which event types each socket heard and one verdict line (socket-probe-verdict.ts); the
// exit code is 0 only when the verdict is that answers go to the sender. Only event types, counts,
// trade ids, the outcomes and the verdict are printed:
// no token, no URL, no payload. The token is taken with mayRefresh: false (never an exchange).
// The demo trade it opens is not linked to any intent (not_ours for the catch-up); a running
// worker session of the same account applies the update_balance it causes.
//
// docker compose exec -T -e ACCOUNT_ID=REPLACE_WITH_ID -e BROKER_WS_URL=https://broker-ws.binodex.app \
//   trading-worker pnpm --filter @binarius/trading-worker socket-probe
// (REPLACE_WITH_ID: the broker_accounts.id uuid; substitute it)

const COMMAND_TIMEOUT_MS = 10_000;
const PROBE_WINDOW_MS = 15_000;
const READY_TIMEOUT_MS = 15_000;
const BELOW_MINIMUM = decimalStringSchema.parse('0.01');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const env = process.env;
const url = parseUrlEnv(readEnv(env, 'BROKER_WS_URL'), 'BROKER_WS_URL', BROKER_WS_URL_RULES);
const backendUrl = parseUrlEnv(readEnv(env, 'BACKEND_URL'), 'BACKEND_URL', BACKEND_URL_RULES);
const internalToken = parseInternalTokenEnv(
  readEnv(env, 'INTERNAL_API_TOKEN'),
  'INTERNAL_API_TOKEN',
);
const databaseUrl = parseUrlEnv(readEnv(env, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES);
const accountId = readEnv(env, 'ACCOUNT_ID');
if (!UUID.test(accountId)) throw new Error('Env ACCOUNT_ID must be a broker_accounts.id (uuid)');
const level = parseLogLevelEnv(readEnv(env, 'LOG_LEVEL', 'warn'), 'LOG_LEVEL');
const logger = pino(logOptions(level), process.stderr);

const say = (line: string) => void process.stderr.write(`${line}\n`);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, condition: () => boolean, timeoutMs: number) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await pause(50);
  }
}

interface Recorder {
  types: Map<string, number>;
  tradeIds: string[];
  user?: { minTradeAmount: DecimalString };
  pairs?: BinaryPair[];
}

function record(client: BrokerSocketClient): Recorder {
  const recorder: Recorder = { types: new Map(), tradeIds: [] };
  client.onEvent((event: BrokerEvent) => {
    recorder.types.set(event.type, (recorder.types.get(event.type) ?? 0) + 1);
    if (event.type === BrokerEventType.OpenTradeSuccess) recorder.tradeIds.push(event.trade.id);
    if (event.type === BrokerEventType.CloseTradeSuccess) {
      for (const trade of event.trades) recorder.tradeIds.push(trade.id);
    }
    if (event.type === BrokerEventType.UserData) {
      recorder.user = { minTradeAmount: event.user.minTradeAmount };
    }
    if (event.type === BrokerEventType.AssetsList) recorder.pairs = event.pairs;
  });
  return recorder;
}

function describeOutcome(result: SocketOpenTradeResult): string {
  switch (result.outcome) {
    case 'success':
      return `success, trade ${result.trade.id}`;
    case 'fail':
      return `fail, ${result.failures.length} message(s)`;
    case 'not_sent':
    case 'unknown':
      return `${result.outcome} (${result.reason}, ${result.state})`;
  }
}

const detailOf = (result: SocketOpenTradeResult) =>
  result.outcome === 'not_sent' || result.outcome === 'unknown'
    ? `${result.reason}, ${result.state}`
    : undefined;

const answersOf = (recorder: Recorder): HeardAnswers => ({
  openTradeSuccess: recorder.types.get(BrokerEventType.OpenTradeSuccess) ?? 0,
  openTradeFail: recorder.types.get(BrokerEventType.OpenTradeFail) ?? 0,
});

const pool = new Pool({ connectionString: databaseUrl });
const clients: BrokerSocketClient[] = [];
try {
  const [account] = await createDb(pool)
    .select({ brokerUserId: brokerAccounts.brokerUserId })
    .from(brokerAccounts)
    .where(eq(brokerAccounts.id, accountId));
  if (account === undefined) throw new Error('no broker account with this ACCOUNT_ID');

  const tokens = createBackendAccessTokenSource({ baseUrl: backendUrl, token: internalToken });
  const token = await tokens.accessToken(accountId, { mayRefresh: false });
  if (!token.ok) {
    say(
      `token unavailable: ${token.reason}${token.status === undefined ? '' : ` ${token.status}`}`,
    );
    process.exitCode = 1;
  } else {
    const credentials = { brokerUserId: account.brokerUserId, accessToken: token.accessToken };
    const a = createBrokerSocketClient({ url, logger: logger.child({ socket: 'A' }) });
    const b = createBrokerSocketClient({ url, logger: logger.child({ socket: 'B' }) });
    clients.push(a, b);
    const heardA = record(a);
    const heardB = record(b);
    a.start(credentials);
    b.start(credentials);
    await waitFor(
      'both sockets ready with the burst',
      () =>
        a.state === BrokerSocketState.Ready &&
        b.state === BrokerSocketState.Ready &&
        heardA.user !== undefined &&
        heardA.pairs !== undefined,
      READY_TIMEOUT_MS,
    );

    const minimum = heardA.user!.minTradeAmount;
    const pair = heardA.pairs!.find((p) => p.scheduledUntil === 0 && p.payout > 0);
    if (pair === undefined) throw new Error('no tradable pair in common.assets_list');
    const command = (amount: DecimalString) =>
      a.openTrade(
        TradeMode.Demo,
        { assetId: pair.id, action: TradeAction.Up, durationSec: pair.minTimeframe, amount },
        AbortSignal.timeout(COMMAND_TIMEOUT_MS),
      );

    const outcomes: ProbeOutcomes = { command1: 'not_run', command2: 'not_run', detail: {} };
    const first = await command(minimum);
    outcomes.command1 = first.outcome;
    outcomes.detail!.command1 = detailOf(first);
    say(`command 1 (demo, min_trade_amount): ${describeOutcome(first)}`);
    if (compareDecimal(minimum, BELOW_MINIMUM) > 0) {
      const second = await command(BELOW_MINIMUM);
      outcomes.command2 = second.outcome;
      outcomes.detail!.command2 = detailOf(second);
      say(`command 2 (demo, below the minimum): ${describeOutcome(second)}`);
    } else {
      outcomes.command2 = 'skipped';
      say('command 2 (demo, below the minimum): skipped, min_trade_amount <= 0.01');
    }

    await pause(PROBE_WINDOW_MS);
    const types = [...new Set([...heardA.types.keys(), ...heardB.types.keys()])].sort();
    say('event type | A | B');
    for (const type of types) {
      say(`${type} | ${heardA.types.get(type) ?? 0} | ${heardB.types.get(type) ?? 0}`);
    }
    say(`trade ids heard: A [${heardA.tradeIds.join(', ')}], B [${heardB.tradeIds.join(', ')}]`);
    const result = verdict(outcomes, answersOf(heardA), answersOf(heardB));
    say(renderVerdict(result));
    process.exitCode = result.kind === 'sender_only' ? 0 : 1;
  }
} finally {
  for (const client of clients) client.stop();
  await pool.end();
}
