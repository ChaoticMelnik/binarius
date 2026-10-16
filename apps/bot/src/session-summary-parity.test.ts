import { describe, expect, it } from 'vitest';
import {
  pairLabel,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
  type DecimalString,
  type TradingSessionView,
} from '@binarius/shared';
import { intentView, PAIR_EURUSD, sessionView } from './testing';
import { sessionStatusText, sessionTexts } from './texts';

// The summary the backend sends at a session's end (#464) repeats the status message's final
// lines: both are built by session-texts.ts in packages/shared, and this holds the two equal
// line by line, so neither side can grow a line of its own without a red test.

const BALANCES: TradingSessionView['balance'][] = [
  null,
  { available: '10002.5' as DecimalString, ageSec: 90, current: false },
  { available: '10002.5' as DecimalString, ageSec: 0, current: true },
];
const TRADES: TradingSessionView['trades'][] = [
  { settled: 5, rejected: 0, won: 3, lost: 2, tied: 0, profit: '2.5' as DecimalString },
  { settled: 3, rejected: 1, won: 1, lost: 1, tied: 1, profit: '-1' as DecimalString },
];

// what follows the status message's header and settings line, and the blank line under them
const statusBody = (view: TradingSessionView): string[] =>
  sessionStatusText(pairLabel(PAIR_EURUSD), view).value.split('\n').slice(3);
const summaryBody = (view: TradingSessionView): string[] =>
  sessionTexts
    .sessionSummaryText(pairLabel(PAIR_EURUSD), PAIR_EURUSD.id, view)
    .value.split('\n')
    .slice(1);

describe('the summary and the status message of a finished session (#464)', () => {
  const cases = Object.values(TradingSessionStopReason).flatMap((stopReason) =>
    Object.values(TradeMode).flatMap((mode) =>
      BALANCES.flatMap((balance) =>
        TRADES.map((trades) =>
          sessionView({
            mode,
            status: TradingSessionStatus.Stopped,
            stopReason,
            endedAt: '2026-10-07T10:05:00.000Z',
            trades,
            lastIntent: intentView({ status: TradeIntentStatus.Settled }),
            balance,
          }),
        ),
      ),
    ),
  );

  it.each(cases.map((view) => [view.stopReason, view.mode, view]))(
    'print the same closing lines: %s, %s',
    (_reason, _mode, view) => {
      expect(summaryBody(view)).toEqual(statusBody(view));
    },
  );
});
