import { describe, expect, it } from 'vitest';
import {
  createBotTexts,
  createSessionTexts,
  defaultBotTextSource,
  pairLabel,
  SessionTradeResult,
  TradingSessionStatus,
  TradingSessionStopReason,
  type BinaryPair,
  type DecimalString,
  type TradingSessionSettings,
  type TradingSessionView,
} from '@binarius/shared';
import type { ClaimedSessionTrade } from '@binarius/db';
import { inlineButtons } from '../admin/testing';
import { CLIENT_LABELS } from '../auth/texts';
import { pairOf, sessionSummaryMessage, sessionTradeMessage } from './session-notice-messages';

const d = (value: string) => value as DecimalString;
const LABEL = pairLabel({ symbol: 'EUR/USD', isOtc: true });
const shared = createSessionTexts(createBotTexts(defaultBotTextSource));
const { Won: W, Lost: L, Tied: T } = SessionTradeResult;

const claimed = (results: SessionTradeResult[], amount = '5'): ClaimedSessionTrade => ({
  trade: {
    amount: d(amount),
    outcome: d('9.6'),
    result: results.at(-1)!,
    openPrice: 1.08765,
    closePrice: 1.08712,
    assetId: 101,
  },
  results,
});
const settings: TradingSessionSettings = {
  version: 1,
  assetId: 101,
  durationSec: 60,
  trades: 5,
  stake: { baseStake: d('5'), stakeScale: 0 },
};

describe('sessionTradeMessage (#464)', () => {
  it('numbers each trade of a fixed session as its own cycle at step 1', () => {
    expect(sessionTradeMessage(claimed([L, L, W, T]), settings, 5).value).toBe(
      shared.sessionTradeText({
        ...claimed([T]).trade,
        digits: 5,
        cycle: 4,
        step: 1,
        baseStake: d('5'),
      }).value,
    );
    expect(
      sessionTradeMessage(claimed([W]), settings, 5).value.startsWith('⚡ Цикл 1 Шаг 1\n'),
    ).toBe(true);
  });

  it('never prints the adaptive line under the v1 settings: the stake is the base stake', () => {
    for (const result of [W, L, T]) {
      expect(sessionTradeMessage(claimed([result]), settings, 5).value).not.toContain('🔄');
    }
    // a stake above the base, as #450's steps will have
    expect(sessionTradeMessage(claimed([W], '11.5'), settings, 5).value).toContain(
      '🔄 Адаптивная ставка включена\n⚡',
    );
  });

  // #450: the steps follow the session's own strategy, read from its settings
  it('numbers the trades of a martingale session by its series', () => {
    const martingale: TradingSessionSettings = {
      version: 2,
      assetId: 101,
      durationSec: 60,
      trades: 5,
      stake: {
        strategy: 'martingale',
        baseStake: d('5'),
        stakeScale: 2,
        limits: {
          maxSteps: 4,
          maxStake: d('60'),
          maxSessionLoss: d('100'),
          maxSessionDurationMs: 3_600_000,
        },
      },
    };
    const third = sessionTradeMessage(claimed([L, L, W], '24.5'), martingale, 5).value;
    expect(third.startsWith('🔄 Адаптивная ставка включена\n⚡ Цикл 1 Шаг 3\n')).toBe(true);
    expect(
      sessionTradeMessage(claimed([L, L, W, W]), martingale, 5).value.startsWith(
        '⚡ Цикл 2 Шаг 1\n',
      ),
    ).toBe(true);
    // a v2 fixed session and a row whose settings cannot be read count every trade as step 1
    const fixed: TradingSessionSettings = {
      ...martingale,
      stake: { strategy: 'fixed', baseStake: d('5'), stakeScale: 2 },
    };
    for (const read of [fixed, settings, null]) {
      expect(
        sessionTradeMessage(claimed([L, L, W]), read, 5).value.startsWith('⚡ Цикл 3 Шаг 1\n'),
      ).toBe(true);
    }
  });

  it('prints the prices as the broker sent them when the catalog has no digits', () => {
    expect(sessionTradeMessage(claimed([W]), null, null).value).toContain(
      '📊 Цена: 1.08765 → 1.08712',
    );
  });
});

describe('sessionSummaryMessage (#464)', () => {
  const view: TradingSessionView = {
    id: '00000000-0000-4000-8000-000000000001',
    mode: 'demo',
    status: TradingSessionStatus.Stopped,
    stopReason: TradingSessionStopReason.UserStopped,
    settings,
    startedAt: '2026-10-07T10:00:00.000Z',
    endedAt: '2026-10-07T10:05:00.000Z',
    trades: { planned: 5, settled: 2, rejected: 0, won: 1, lost: 1, tied: 0, profit: d('-0.4') },
    lastIntent: null,
    balance: null,
    noticesDone: false,
  };

  it('is the shared summary of the view under the menu button', () => {
    const message = sessionSummaryMessage(view, LABEL);
    expect(message.text.value).toBe(shared.sessionSummaryText(LABEL, 101, view).value);
    expect(inlineButtons({ reply_markup: message.reply_markup })).toEqual([
      { text: CLIENT_LABELS.menuButton, callback_data: 'menu' },
    ]);
  });

  it.each([
    [15, 'demo:sig:15'],
    [5, 'demo:sig:5'],
    [60, 'demo:sig'],
  ] as const)(
    'a no_signal_timeout stop (#509) at %i s offers another pair (%s) above the menu',
    (durationSec, data) => {
      const message = sessionSummaryMessage(
        {
          ...view,
          stopReason: TradingSessionStopReason.NoSignalTimeout,
          settings: { ...settings, durationSec },
        },
        LABEL,
      );
      expect(inlineButtons({ reply_markup: message.reply_markup })).toEqual([
        { text: CLIENT_LABELS.otherPairButton, callback_data: data },
        { text: CLIENT_LABELS.menuButton, callback_data: 'menu' },
      ]);
    },
  );

  it('a no_signal_timeout stop without settings offers the duration screen', () => {
    const lastIntent = { assetId: 77 } as TradingSessionView['lastIntent'];
    const message = sessionSummaryMessage(
      { ...view, stopReason: TradingSessionStopReason.NoSignalTimeout, settings: null, lastIntent },
      null,
    );
    expect(inlineButtons({ reply_markup: message.reply_markup })[0]).toEqual({
      text: CLIENT_LABELS.otherPairButton,
      callback_data: 'demo:sig',
    });
  });

  it('names the asset by the last trade without settings, and refuses a session naming none', () => {
    const lastIntent = { assetId: 77 } as TradingSessionView['lastIntent'];
    expect(sessionSummaryMessage({ ...view, settings: null, lastIntent }, null).text.value).toBe(
      shared.sessionSummaryText(null, 77, view).value,
    );
    expect(() => sessionSummaryMessage({ ...view, settings: null }, null)).toThrow();
  });
});

describe('pairOf', () => {
  const pair = { id: 101, symbol: 'EUR/USD', isOtc: true, digits: 5 } as BinaryPair;
  it('reads the label (#428) and digits of the asset, null for each without it', () => {
    const catalog = { pairs: [pair], fetchedAt: 0, ageMs: 0, fresh: false };
    expect(pairOf(catalog, 101)).toEqual({ label: 'EUR/USD OTC', digits: 5 });
    expect(pairOf(catalog, 7)).toEqual({ label: null, digits: null });
    expect(pairOf(undefined, 101)).toEqual({ label: null, digits: null });
  });
});
