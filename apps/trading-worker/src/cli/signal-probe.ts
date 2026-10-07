import { createBrokerRestClient } from '@binarius/broker-rest';
import {
  logOptions,
  parseBoundedIntegerEnv,
  parseEnumEnv,
  parseLogLevelEnv,
  parseLoopbackOrHttpsUrlEnv,
  readEnv,
  SIGNAL_INTERVALS,
  SignalFeedOutcome,
  SignalKind,
} from '@binarius/shared';
import { createSignalFeed } from '@binarius/signal';
import { pino } from 'pino';

// One chart fetch and one decision through the signal feed: the journal line on stdout, a summary
// on stderr; exit 0 on a decision (a refusal included), 1 on fetch_failed. The chart endpoint is
// public: no token is read or sent, and no trade is opened (docs/signal.md → Feed and journal).
// BROKER_API_BASE_URL=https://api.binodex.app ASSET_ID=REPLACE_WITH_ID pnpm signal-probe
// (REPLACE_WITH_ID: the asset id; substitute it)

const env = process.env;
const baseUrl = parseLoopbackOrHttpsUrlEnv(
  readEnv(env, 'BROKER_API_BASE_URL'),
  'BROKER_API_BASE_URL',
);
const assetId = parseBoundedIntegerEnv(
  readEnv(env, 'ASSET_ID'),
  'ASSET_ID',
  1,
  Number.MAX_SAFE_INTEGER,
);
const interval = parseEnumEnv(readEnv(env, 'INTERVAL', '1m'), 'INTERVAL', SIGNAL_INTERVALS);
const level = parseLogLevelEnv(readEnv(env, 'LOG_LEVEL', 'info'), 'LOG_LEVEL');

const feed = createSignalFeed({
  rest: createBrokerRestClient({ baseUrl }),
  logger: pino(logOptions(level)),
});
const result = await feed.evaluate({ assetId, interval });

if (result.outcome === SignalFeedOutcome.Decided) {
  const { decision, fetch } = result.entry;
  const summary =
    decision.kind === SignalKind.Signal
      ? `signal ${decision.action}, ${decision.features.closedCandles} closed candles`
      : 'features' in decision
        ? `no_signal ${decision.reason}, ${decision.features.closedCandles} closed candles`
        : `no_signal ${decision.reason} ${JSON.stringify(decision.detail)}`;
  process.stderr.write(`decided: ${summary}; ${fetch.rows} rows in ${fetch.durationMs} ms\n`);
} else {
  const parts = [`fetch_failed ${result.code}`];
  if (result.status !== undefined) parts.push(`status ${result.status}`);
  if (result.retryAfterSec !== undefined) parts.push(`retryAfterSec ${result.retryAfterSec}`);
  process.stderr.write(`${parts.join(' ')}\n`);
  process.exitCode = 1;
}
