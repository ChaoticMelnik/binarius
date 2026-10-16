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

// The summary the backend sends at a session's end (#464) opens, under its pair, on the line the
// session message ends on (#536): both are built by session-texts.ts in packages/shared, and this
// holds the two equal, so neither side can change that line alone without a red test. The result
// and the balance are the summary's only (#536).

const BALANCES: TradingSessionView['balance'][] = [
  null,
  { available: '10002.5' as DecimalString, ageSec: 90, current: false },
  { available: '10002.5' as DecimalString, ageSec: 0, current: true },
];
const TRADES: TradingSessionView['trades'][] = [
  { settled: 5, rejected: 0, won: 3, lost: 2, tied: 0, profit: '2.5' as DecimalString },
  { settled: 3, rejected: 1, won: 1, lost: 1, tied: 1, profit: '-1' as DecimalString },
];

// the session message's last line: its end line, under the head and the blank line
const statusEnd = (view: TradingSessionView): string | undefined =>
  sessionStatusText(pairLabel(PAIR_EURUSD), view).value.split('\n').at(-1);
// the summary's line under its pair
const summaryFirst = (view: TradingSessionView): string | undefined =>
  sessionTexts
    .sessionSummaryText(pairLabel(PAIR_EURUSD), PAIR_EURUSD.id, view)
    .value.split('\n')[1];

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
    'end the session message on the summary’s first line: %s, %s',
    (_reason, _mode, view) => {
      expect(summaryFirst(view)).toBeDefined();
      expect(summaryFirst(view)).toBe(statusEnd(view));
    },
  );
});
