import { afterEach, describe, expect, it } from 'vitest';
import {
  BOT_TEXT_LIMIT,
  botTextMessageOverflows,
  createBotTexts,
  createSessionTexts,
  defaultBotTextSource,
  pairLabel,
  plainTextOf,
  TELEGRAM_MESSAGE_LIMIT,
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
import { CLIENT_LABELS, CLIENT_TEXTS, setBotTextSource } from '../auth/texts';
import {
  pairOf,
  sessionCycleMessage,
  sessionSummaryMessage,
  sessionWaitingMessage,
  type SessionCycleNotice,
} from './session-notice-messages';

const d = (value: string) => value as DecimalString;
const LABEL = pairLabel({ symbol: 'EUR/USD', isOtc: true });
const shared = createSessionTexts(createBotTexts(defaultBotTextSource));
const { Won: W, Lost: L, Tied: T } = SessionTradeResult;

const row = (result: SessionTradeResult, index: number) => ({
  amount: d('5'),
  outcome: d(result === W ? '4.6' : result === L ? '-5' : '0'),
  result,
  openPrice: index + 1,
  closePrice: index + 1.5,
  assetId: 101,
});
const claimed = (
  results: SessionTradeResult[],
  cycleMessage: ClaimedSessionTrade['cycleMessage'] = null,
): ClaimedSessionTrade => ({ trades: results.map(row), cycleMessage });
const settings: TradingSessionSettings = {
  version: 1,
  assetId: 101,
  durationSec: 60,
  trades: 5,
  stake: { baseStake: d('5'), stakeScale: 0 },
};
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
const textOf = (notice: SessionCycleNotice) => notice.text.value;
const heads = (notice: SessionCycleNotice) =>
  textOf(notice)
    .split('\n')
    .filter((line) => line.startsWith('⚡') || line.startsWith('🔄'));

describe('sessionCycleMessage (#551)', () => {
  it('a fixed session: every trade a new message of its own cycle at step 1', () => {
    const notice = sessionCycleMessage(
      claimed([L, L, W, T], { messageId: 7, from: 2 }),
      settings,
      5,
    );
    expect(notice).toEqual({
      kind: 'send',
      text: shared.sessionCycleText([{ ...row(T, 3), digits: 5, cycle: 4, step: 1 }]),
      from: 3,
      split: false,
    });
    // a v2 fixed session and settings that cannot be read count as fixed too
    const fixed: TradingSessionSettings = {
      ...martingale,
      stake: { strategy: 'fixed', baseStake: d('5'), stakeScale: 2 },
    };
    for (const read of [fixed, null]) {
      const other = sessionCycleMessage(claimed([L, L], { messageId: 7, from: 0 }), read, 5);
      expect(other.kind).toBe('send');
      expect(heads(other)).toEqual(['⚡ Цикл 2 Шаг 1']);
    }
  });

  it('a martingale cycle without a cycle message: a new message with the whole cycle so far', () => {
    const first = sessionCycleMessage(claimed([W, L]), martingale, 5);
    expect(first).toMatchObject({ kind: 'send', from: 1, split: false });
    expect(heads(first)).toEqual(['⚡ Цикл 2 Шаг 1']);
    // a session met mid-cycle (a deploy, an unknown send): the cycle's steps so far
    const later = sessionCycleMessage(claimed([W, L, T, L]), martingale, 5);
    expect(later).toMatchObject({ kind: 'send', from: 1 });
    expect(heads(later)).toEqual([
      '⚡ Цикл 2 Шаг 1',
      '🔄 Адаптивная ставка включена',
      '⚡ Цикл 2 Шаг 2',
      '⚡ Цикл 2 Шаг 3',
    ]);
  });

  it('the next step of the same cycle edits the cycle message with every block from its from', () => {
    const notice = sessionCycleMessage(
      claimed([W, L, T, W], { messageId: 42, from: 1 }),
      martingale,
      5,
    );
    expect(notice).toMatchObject({ kind: 'edit', messageId: 42, from: 1 });
    expect(textOf(notice)).toBe(
      [
        '⚡ Цикл 2 Шаг 1\n<pre>🔴 Ставка: $5.00 → -$5.00\n📊 Цена: 2.00000 → 2.50000</pre>',
        '🔄 Адаптивная ставка включена',
        '⚡ Цикл 2 Шаг 2\n<pre>⚪ Ставка: $5.00 → $0.00, ставка вернулась\n📊 Цена: 3.00000 → 3.50000</pre>',
        '⚡ Цикл 2 Шаг 3\n<pre>🟢 Ставка: $5.00 → +$4.60\n📊 Цена: 4.00000 → 4.50000</pre>',
      ].join('\n\n'),
    );
  });

  it('a continuation after a split shows from its own from: the adaptive line only when step 2 is in it', () => {
    const fromTwo = sessionCycleMessage(
      claimed([L, L, L], { messageId: 9, from: 1 }),
      martingale,
      5,
    );
    expect(heads(fromTwo)).toEqual([
      '🔄 Адаптивная ставка включена',
      '⚡ Цикл 1 Шаг 2',
      '⚡ Цикл 1 Шаг 3',
    ]);
    const fromThree = sessionCycleMessage(
      claimed([L, L, L, L], { messageId: 9, from: 2 }),
      martingale,
      5,
    );
    expect(heads(fromThree)).toEqual(['⚡ Цикл 1 Шаг 3', '⚡ Цикл 1 Шаг 4']);
  });

  it('a new cycle sends a new message, whatever the cycle message shows', () => {
    const notice = sessionCycleMessage(
      claimed([L, W, L], { messageId: 42, from: 0 }),
      martingale,
      5,
    );
    expect(notice).toMatchObject({ kind: 'send', from: 2, split: false });
    expect(heads(notice)).toEqual(['⚡ Цикл 2 Шаг 1']);
  });

  it('prints the prices as the broker sent them when the catalog has no digits', () => {
    expect(textOf(sessionCycleMessage(claimed([W]), null, null))).toContain('📊 Цена: 1 → 1.5');
  });

  describe('the length limit, under an override the registry accepts', () => {
    // a loss's block of about 440 characters: eight losses of a cycle fit in BOT_TEXT_LIMIT, nine
    // do not — 4079, inside the Bot API's 4096
    const PAD = 'ж'.repeat(380);
    const source = {
      sourceOf: (key: Parameters<typeof defaultBotTextSource.sourceOf>[0]) =>
        key === 'sessionTradeLost'
          ? `${PAD}\n${defaultBotTextSource.sourceOf(key)}`
          : defaultBotTextSource.sourceOf(key),
    };
    afterEach(() => setBotTextSource(defaultBotTextSource));

    it('the override passes the registry: one block with its adaptive line fits', () => {
      expect(botTextMessageOverflows(source)).toEqual([]);
    });

    it('a block that does not fit opens a new message from the claimed trade', () => {
      setBotTextSource(source);
      const losses = Array.from({ length: 9 }, () => L);
      const edit = sessionCycleMessage(
        claimed(losses.slice(0, 8), { messageId: 9, from: 0 }),
        martingale,
        5,
      );
      expect(edit.kind).toBe('edit');
      expect(plainTextOf(edit.text).length).toBeLessThanOrEqual(BOT_TEXT_LIMIT);
      expect(plainTextOf(edit.text).length).toBeGreaterThan(BOT_TEXT_LIMIT - 450);
      // the nine blocks would fit the Bot API's limit: only the width spacer leaves them out
      const nine = createSessionTexts(createBotTexts(source)).sessionCycleText(
        losses.map((result, i) => ({
          ...row(result, i),
          digits: 5,
          cycle: 1,
          step: i + 1,
        })),
      );
      expect(plainTextOf(nine).length).toBeGreaterThan(BOT_TEXT_LIMIT);
      expect(plainTextOf(nine).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      const split = sessionCycleMessage(claimed(losses, { messageId: 9, from: 0 }), martingale, 5);
      expect(split).toMatchObject({ kind: 'send', from: 8, split: true });
      expect(heads(split)).toEqual(['⚡ Цикл 1 Шаг 9']);
      // without a cycle message, the whole cycle does not fit either
      expect(sessionCycleMessage(claimed(losses), martingale, 5)).toMatchObject({
        kind: 'send',
        from: 8,
        split: true,
      });
      // the continuation is edited from its own from
      expect(
        sessionCycleMessage(claimed([...losses, L], { messageId: 10, from: 8 }), martingale, 5),
      ).toMatchObject({ kind: 'edit', messageId: 10, from: 8 });
    });
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
    trades: { settled: 2, rejected: 0, won: 1, lost: 1, tied: 0, profit: d('-0.4') },
    cycles: { planned: 5, closed: 2 },
    lastIntent: null,
    signalAction: null,
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

describe('sessionWaitingMessage (#536)', () => {
  it('is the wait for a signal under the stop button marked as pressed under it', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const message = sessionWaitingMessage(id);
    expect(message.text.value).toBe(CLIENT_TEXTS.sessionWaitingSignal.value);
    expect(inlineButtons({ reply_markup: message.reply_markup })).toEqual([
      { text: CLIENT_LABELS.sessionStopButton, callback_data: `session:stop:${id}:w` },
    ]);
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
