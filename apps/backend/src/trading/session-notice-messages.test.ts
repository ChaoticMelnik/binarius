import { afterEach, describe, expect, it } from 'vitest';
import {
  BotLanguage,
  AdaptiveLineSlot,
  BOT_TEXT_LIMIT,
  BOT_TEXT_SOURCES_EN,
  botTextMessageOverflows,
  createBotTexts,
  createSessionTexts,
  defaultBotTextSource,
  pairLabel,
  plainTextOf,
  TELEGRAM_MESSAGE_LIMIT,
  SessionTradeResult,
  TradeAction,
  TradingSessionStatus,
  TradingSessionStopReason,
  type BinaryPair,
  type DecimalString,
  H1_R1_PARAMS,
  type H1SessionSettings,
  type TradingSessionSettings,
  type TradingSessionView,
} from '@binarius/shared';
import type { ClaimedSessionTrade } from '@binarius/db';
import { inlineButtons } from '../admin/testing';
import {
  clientLabelsOf,
  clientSessionTextsOf,
  clientTextsOf,
  setBotTextSource,
} from '../auth/texts';
import {
  pairOf,
  sessionCycleMessage,
  sessionCycleStopKeyboard,
  sessionSummaryMessage,
  sessionWaitingMessage,
  type SessionCycleNotice,
} from './session-notice-messages';

// the Russian texts, the language of every user these tests make (#633)
const RU_TEXTS = clientTextsOf(BotLanguage.Ru);
const RU_LABELS = clientLabelsOf(BotLanguage.Ru);

const d = (value: string) => value as DecimalString;
const LABEL = pairLabel({ symbol: 'EUR/USD' });
const shared = createSessionTexts({
  ...createBotTexts(defaultBotTextSource),
  language: BotLanguage.Ru,
});
const { Won: W, Lost: L, Tied: T } = SessionTradeResult;

const row = (result: SessionTradeResult, index: number) => ({
  amount: d('5'),
  outcome: d(result === W ? '9.6' : result === L ? '-5' : '0'),
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
const ADAPTIVE = '🔄 Адаптивная ставка включена';
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
      BotLanguage.Ru,
    );
    expect(notice).toEqual({
      kind: 'send',
      text: shared.sessionCycleText([
        { ...row(T, 3), digits: 5, cycle: 4, step: 1, adaptiveLine: null },
      ]),
      from: 3,
      split: false,
    });
    // a v2 fixed session and settings that cannot be read count as fixed too
    const fixed: TradingSessionSettings = {
      ...martingale,
      stake: { strategy: 'fixed', baseStake: d('5'), stakeScale: 2 },
    };
    for (const read of [fixed, null]) {
      const other = sessionCycleMessage(
        claimed([L, L], { messageId: 7, from: 0 }),
        read,
        5,
        BotLanguage.Ru,
      );
      expect(other.kind).toBe('send');
      expect(heads(other)).toEqual(['⚡ Цикл 2 Шаг 1']);
    }
  });

  it('a martingale cycle without a cycle message: a new message with the whole cycle so far', () => {
    const first = sessionCycleMessage(claimed([W, L]), martingale, 5, BotLanguage.Ru);
    expect(first).toMatchObject({ kind: 'send', from: 1, split: false });
    expect(heads(first)).toEqual(['⚡ Цикл 2 Шаг 1', '🔄 Адаптивная ставка включена']);
    // a session met mid-cycle (a deploy, an unknown send): the cycle's steps so far
    const later = sessionCycleMessage(claimed([W, L, T, L]), martingale, 5, BotLanguage.Ru);
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
      BotLanguage.Ru,
    );
    expect(notice).toMatchObject({ kind: 'edit', messageId: 42, from: 1 });
    expect(textOf(notice)).toBe(
      [
        '⚡ Цикл 2 Шаг 1\n<pre>🔴 Ставка: $5.00 → -$5.00\n📊 Цена: 2.00000 → 2.50000</pre>',
        '🔄 Адаптивная ставка включена',
        '⚡ Цикл 2 Шаг 2\n<pre>⚪ Ставка: $5.00 → $0.00, ставка вернулась\n📊 Цена: 3.00000 → 3.50000</pre>',
        '⚡ Цикл 2 Шаг 3\n<pre>🟢 Ставка: $5.00 → +$9.60\n📊 Цена: 4.00000 → 4.50000</pre>',
      ].join('\n\n'),
    );
  });

  it('a continuation after a split shows from its own from', () => {
    const fromTwo = sessionCycleMessage(
      claimed([T, L, L], { messageId: 9, from: 1 }),
      martingale,
      5,
      BotLanguage.Ru,
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
      BotLanguage.Ru,
    );
    expect(heads(fromThree)).toEqual(['⚡ Цикл 1 Шаг 3', '⚡ Цикл 1 Шаг 4']);
  });

  it('a new cycle sends a new message, whatever the cycle message shows', () => {
    const notice = sessionCycleMessage(
      claimed([L, W, L], { messageId: 42, from: 0 }),
      martingale,
      5,
      BotLanguage.Ru,
    );
    expect(notice).toMatchObject({ kind: 'send', from: 2, split: false });
    expect(heads(notice)).toEqual(['⚡ Цикл 2 Шаг 1', ADAPTIVE]);
  });

  it('prints the prices as the broker sent them when the catalog has no digits', () => {
    expect(textOf(sessionCycleMessage(claimed([W]), null, null, BotLanguage.Ru))).toContain(
      '📊 Цена: 1 → 1.5',
    );
  });

  describe('the length limit, under an override the registry accepts', () => {
    // a loss's block of about 440 characters: eight losses of a cycle with the adaptive line fit in
    // BOT_TEXT_LIMIT, nine do not — 4079, inside the Bot API's 4096; the line under step 1 (#718)
    // is as long as it was above step 2
    const PAD = 'ж'.repeat(380);
    const source = {
      sourceOf: (key: Parameters<typeof defaultBotTextSource.sourceOf>[0]) =>
        key === 'sessionTradeLost'
          ? `${PAD}\n${defaultBotTextSource.sourceOf(key)}`
          : defaultBotTextSource.sourceOf(key),
    };
    afterEach(() => setBotTextSource(defaultBotTextSource));

    it('B6 the override passes the registry: a lost step 1 with the line under it fits', () => {
      expect(botTextMessageOverflows(source)).toEqual([]);
    });

    it('a block that does not fit opens a new message from the claimed trade', () => {
      setBotTextSource(source);
      const losses = Array.from({ length: 9 }, () => L);
      const edit = sessionCycleMessage(
        claimed(losses.slice(0, 8), { messageId: 9, from: 0 }),
        martingale,
        5,
        BotLanguage.Ru,
      );
      expect(edit.kind).toBe('edit');
      expect(plainTextOf(edit.text).length).toBeLessThanOrEqual(BOT_TEXT_LIMIT);
      expect(plainTextOf(edit.text).length).toBeGreaterThan(BOT_TEXT_LIMIT - 450);
      // the nine blocks would fit the Bot API's limit: only the width spacer leaves them out
      const nine = createSessionTexts({
        ...createBotTexts(source),
        language: BotLanguage.Ru,
      }).sessionCycleText(
        losses.map((result, i) => ({
          ...row(result, i),
          digits: 5,
          cycle: 1,
          step: i + 1,
          adaptiveLine: i === 0 ? AdaptiveLineSlot.Below : null,
        })),
      );
      expect(plainTextOf(nine).length).toBeGreaterThan(BOT_TEXT_LIMIT);
      expect(plainTextOf(nine).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      const split = sessionCycleMessage(
        claimed(losses, { messageId: 9, from: 0 }),
        martingale,
        5,
        BotLanguage.Ru,
      );
      expect(split).toMatchObject({ kind: 'send', from: 8, split: true });
      expect(heads(split)).toEqual(['⚡ Цикл 1 Шаг 9']);
      // without a cycle message, the whole cycle does not fit either
      expect(sessionCycleMessage(claimed(losses), martingale, 5, BotLanguage.Ru)).toMatchObject({
        kind: 'send',
        from: 8,
        split: true,
      });
      // the continuation is edited from its own from
      expect(
        sessionCycleMessage(
          claimed([...losses, L], { messageId: 10, from: 8 }),
          martingale,
          5,
          BotLanguage.Ru,
        ),
      ).toMatchObject({ kind: 'edit', messageId: 10, from: 8 });
    });
  });
});

describe('sessionCycleMessage with the open trade (#700)', () => {
  const OPEN = { amount: d('11.5'), action: TradeAction.Down, openPrice: 7, assetId: 101 };
  const withOpen = (
    results: SessionTradeResult[],
    cycleMessage: ClaimedSessionTrade['cycleMessage'] = null,
  ) => ({ ...claimed(results, cycleMessage), open: OPEN });

  it('step 1: a new message with the open block alone, from the index the trade settles at', () => {
    const notice = sessionCycleMessage(
      withOpen([L, W], { messageId: 42, from: 0 }),
      martingale,
      5,
      BotLanguage.Ru,
    );
    expect(notice).toEqual({
      kind: 'send',
      text: shared.sessionCycleText([], {
        amount: d('11.5'),
        action: TradeAction.Down,
        openPrice: 7,
        digits: 5,
        cycle: 2,
        step: 1,
        adaptiveLine: null,
      }),
      from: 2,
      split: false,
    });
    expect(textOf(notice)).toBe(
      '⚡ Цикл 2 Шаг 1\n<pre>⏳ Ставка: $11.50 · ⬇️ Вниз · сделка открыта\n📊 Цена: 7.00000 → …</pre>',
    );
    // the first trade of the session
    expect(sessionCycleMessage(withOpen([]), martingale, 5, BotLanguage.Ru)).toMatchObject({
      kind: 'send',
      from: 0,
    });
  });

  it('a later step edits the cycle message: its settled blocks, then the open block last', () => {
    const notice = sessionCycleMessage(
      withOpen([W, L, T], { messageId: 42, from: 1 }),
      martingale,
      5,
      BotLanguage.Ru,
    );
    expect(notice).toMatchObject({ kind: 'edit', messageId: 42, from: 1 });
    expect(heads(notice)).toEqual([
      '⚡ Цикл 2 Шаг 1',
      '🔄 Адаптивная ставка включена',
      '⚡ Цикл 2 Шаг 2',
      '⚡ Цикл 2 Шаг 3',
    ]);
    expect(textOf(notice).split('\n\n').at(-1)).toContain('сделка открыта');
    // step 2 open after a lost step 1: the line under step 1, above the open block
    expect(
      heads(
        sessionCycleMessage(
          withOpen([L], { messageId: 42, from: 0 }),
          martingale,
          5,
          BotLanguage.Ru,
        ),
      ),
    ).toEqual(['⚡ Цикл 1 Шаг 1', '🔄 Адаптивная ставка включена', '⚡ Цикл 1 Шаг 2']);
  });

  it('then its result edits the same message from the same from', () => {
    // the open block went as a new message from 2; the trade settled as a loss
    const result = sessionCycleMessage(
      claimed([L, W, L], { messageId: 50, from: 2 }),
      martingale,
      5,
      BotLanguage.Ru,
    );
    expect(result).toMatchObject({ kind: 'edit', messageId: 50, from: 2 });
    expect(heads(result)).toEqual(['⚡ Цикл 2 Шаг 1', '🔄 Адаптивная ставка включена']);
    expect(textOf(result)).not.toContain('сделка открыта');
  });

  it('a cycle message of another cycle, or none: a new message with the cycle so far', () => {
    const other = sessionCycleMessage(
      withOpen([L, W, L], { messageId: 42, from: 0 }),
      martingale,
      5,
      BotLanguage.Ru,
    );
    expect(other).toMatchObject({ kind: 'send', from: 2, split: false });
    expect(heads(other)).toEqual([
      '⚡ Цикл 2 Шаг 1',
      '🔄 Адаптивная ставка включена',
      '⚡ Цикл 2 Шаг 2',
    ]);
    expect(sessionCycleMessage(withOpen([L, W, L]), martingale, 5, BotLanguage.Ru)).toMatchObject({
      kind: 'send',
      from: 2,
    });
  });

  it('fixed: every open block a new message of its own cycle', () => {
    const notice = sessionCycleMessage(
      withOpen([L, L], { messageId: 7, from: 1 }),
      settings,
      5,
      BotLanguage.Ru,
    );
    expect(notice).toMatchObject({ kind: 'send', from: 2 });
    expect(heads(notice)).toEqual(['⚡ Цикл 3 Шаг 1']);
    expect(heads(sessionCycleMessage(withOpen([L]), null, 5, BotLanguage.Ru))).toEqual([
      '⚡ Цикл 2 Шаг 1',
    ]);
  });

  describe('the length limit', () => {
    const PAD = 'ж'.repeat(380);
    const source = {
      sourceOf: (key: Parameters<typeof defaultBotTextSource.sourceOf>[0]) =>
        key === 'sessionTradeLost' || key === 'sessionTradeOpen'
          ? `${PAD}\n${defaultBotTextSource.sourceOf(key)}`
          : defaultBotTextSource.sourceOf(key),
    };
    afterEach(() => setBotTextSource(defaultBotTextSource));

    it('an open block that does not fit opens a new message of its own', () => {
      setBotTextSource(source);
      const losses = Array.from({ length: 8 }, () => L);
      const split = sessionCycleMessage(
        withOpen(losses, { messageId: 9, from: 0 }),
        martingale,
        5,
        BotLanguage.Ru,
      );
      expect(split).toMatchObject({ kind: 'send', from: 8, split: true });
      expect(heads(split)).toEqual(['⚡ Цикл 1 Шаг 9']);
      expect(textOf(split)).toContain('сделка открыта');
    });
  });
});

describe('sessionCycleMessage: the adaptive line (#718)', () => {
  const OPEN = { amount: d('11.5'), action: TradeAction.Down, openPrice: 7, assetId: 101 };
  const withOpen = (
    results: SessionTradeResult[],
    cycleMessage: ClaimedSessionTrade['cycleMessage'] = null,
  ) => ({ ...claimed(results, cycleMessage), open: OPEN });

  it('B1 a lost step 1: its new message carries the line under its block at once', () => {
    const notice = sessionCycleMessage(claimed([W, L]), martingale, 5, BotLanguage.Ru);
    expect(notice).toMatchObject({ kind: 'send', from: 1 });
    expect(textOf(notice)).toBe(
      `⚡ Цикл 2 Шаг 1\n<pre>🔴 Ставка: $5.00 → -$5.00\n📊 Цена: 2.00000 → 2.50000</pre>\n\n${ADAPTIVE}`,
    );
  });

  it('B2 step 2 opens and settles under the line, which stays one', () => {
    const opened = sessionCycleMessage(
      withOpen([W, L], { messageId: 42, from: 1 }),
      martingale,
      5,
      BotLanguage.Ru,
    );
    expect(opened).toMatchObject({ kind: 'edit', messageId: 42, from: 1 });
    expect(heads(opened)).toEqual(['⚡ Цикл 2 Шаг 1', ADAPTIVE, '⚡ Цикл 2 Шаг 2']);
    const settled = sessionCycleMessage(
      claimed([W, L, L], { messageId: 42, from: 1 }),
      martingale,
      5,
      BotLanguage.Ru,
    );
    expect(heads(settled)).toEqual(['⚡ Цикл 2 Шаг 1', ADAPTIVE, '⚡ Цикл 2 Шаг 2']);
    expect(textOf(settled).split(ADAPTIVE)).toHaveLength(2);
  });

  it('B3 a tie at step 1: nothing under it, the line comes with step 2, open or settled', () => {
    expect(heads(sessionCycleMessage(claimed([T]), martingale, 5, BotLanguage.Ru))).toEqual([
      '⚡ Цикл 1 Шаг 1',
    ]);
    expect(
      heads(
        sessionCycleMessage(
          withOpen([T], { messageId: 42, from: 0 }),
          martingale,
          5,
          BotLanguage.Ru,
        ),
      ),
    ).toEqual(['⚡ Цикл 1 Шаг 1', ADAPTIVE, '⚡ Цикл 1 Шаг 2']);
    expect(
      heads(
        sessionCycleMessage(
          claimed([T, L], { messageId: 42, from: 0 }),
          martingale,
          5,
          BotLanguage.Ru,
        ),
      ),
    ).toEqual(['⚡ Цикл 1 Шаг 1', ADAPTIVE, '⚡ Цикл 1 Шаг 2']);
  });

  it('B4 a continuation from step 2: the line only after a tie, the lost step 1 already carried it', () => {
    expect(
      heads(
        sessionCycleMessage(
          claimed([L, L, L], { messageId: 9, from: 1 }),
          martingale,
          5,
          BotLanguage.Ru,
        ),
      ),
    ).toEqual(['⚡ Цикл 1 Шаг 2', '⚡ Цикл 1 Шаг 3']);
    expect(
      heads(
        sessionCycleMessage(
          claimed([T, L, L], { messageId: 9, from: 1 }),
          martingale,
          5,
          BotLanguage.Ru,
        ),
      ),
    ).toEqual([ADAPTIVE, '⚡ Цикл 1 Шаг 2', '⚡ Цикл 1 Шаг 3']);
  });

  it('B5 fixed and settings that cannot be read: a loss without the line', () => {
    const fixed: TradingSessionSettings = {
      ...martingale,
      stake: { strategy: 'fixed', baseStake: d('5'), stakeScale: 2 },
    };
    for (const read of [settings, fixed, null]) {
      expect(textOf(sessionCycleMessage(claimed([L]), read, 5, BotLanguage.Ru))).not.toContain(
        ADAPTIVE,
      );
      expect(textOf(sessionCycleMessage(withOpen([T]), read, 5, BotLanguage.Ru))).not.toContain(
        ADAPTIVE,
      );
    }
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
    const message = sessionSummaryMessage(view, LABEL, BotLanguage.Ru);
    expect(message.text.value).toBe(shared.sessionSummaryText(LABEL, 101, view).value);
    expect(inlineButtons({ reply_markup: message.reply_markup })).toEqual([
      { text: RU_LABELS.menuButton, callback_data: 'menu' },
    ]);
  });

  // #775: an H1 session completes on its cycles, as any session
  it('H1-F1′ the fallback summary of a completed H1 session counts its cycles', () => {
    const h1: H1SessionSettings = {
      version: 5,
      assetId: 101,
      durationSec: 5,
      cycles: 5,
      stake: { strategy: 'fixed', baseStake: d('1'), stakeScale: 2 },
      signal: { kind: 'h1', params: { ...H1_R1_PARAMS }, entryDelaySec: 1, expirySec: 5 },
    };
    const completed = {
      ...view,
      settings: h1,
      stopReason: TradingSessionStopReason.Completed,
      cycles: { planned: 5, closed: 5 },
      trades: { settled: 8, rejected: 0, won: 5, lost: 3, tied: 0, profit: d('5') },
    };
    const lines = sessionSummaryMessage(completed, LABEL, BotLanguage.Ru).text.value.split('\n');
    expect(lines[1]).toBe('🏁 Сессия завершена: 5 циклов, 8 сделок — 5 в плюс, 3 в минус');
  });

  // #685: the signals list is one, so its data is `demo:sig` at every duration
  it.each([5, 15, 60] as const)(
    'a no_signal_timeout stop at %i s offers another pair with demo:sig above the menu',
    (durationSec) => {
      const data = 'demo:sig';
      const message = sessionSummaryMessage(
        {
          ...view,
          stopReason: TradingSessionStopReason.NoSignalTimeout,
          settings: { ...settings, durationSec },
        },
        LABEL,
        BotLanguage.Ru,
      );
      expect(inlineButtons({ reply_markup: message.reply_markup })).toEqual([
        { text: RU_LABELS.otherPairButton, callback_data: data },
        { text: RU_LABELS.menuButton, callback_data: 'menu' },
      ]);
    },
  );

  it('a no_signal_timeout stop without settings offers the signals list too', () => {
    const lastIntent = { assetId: 77 } as TradingSessionView['lastIntent'];
    const message = sessionSummaryMessage(
      { ...view, stopReason: TradingSessionStopReason.NoSignalTimeout, settings: null, lastIntent },
      null,
      BotLanguage.Ru,
    );
    expect(inlineButtons({ reply_markup: message.reply_markup })[0]).toEqual({
      text: RU_LABELS.otherPairButton,
      callback_data: 'demo:sig',
    });
  });

  it('names the asset by the last trade without settings, and refuses a session naming none', () => {
    const lastIntent = { assetId: 77 } as TradingSessionView['lastIntent'];
    expect(
      sessionSummaryMessage({ ...view, settings: null, lastIntent }, null, BotLanguage.Ru).text
        .value,
    ).toBe(shared.sessionSummaryText(null, 77, view).value);
    expect(() =>
      sessionSummaryMessage({ ...view, settings: null }, null, BotLanguage.Ru),
    ).toThrow();
  });
});

describe('sessionWaitingMessage (#536)', () => {
  it('is the wait for a signal under the stop button marked as pressed under it', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const message = sessionWaitingMessage(id, BotLanguage.Ru);
    expect(message.text.value).toBe(RU_TEXTS.sessionWaitingSignal.value);
    expect(inlineButtons({ reply_markup: message.reply_markup })).toEqual([
      { text: RU_LABELS.sessionStopButton, callback_data: `session:stop:${id}:w` },
    ]);
  });
});

// #633: every notice in the session owner's language
describe('the session notices in English (#633)', () => {
  const En = BotLanguage.En;
  const CYRILLIC = /[А-Яа-яЁё]/u;
  const OPEN = { amount: d('11.5'), action: TradeAction.Down, openPrice: 7, assetId: 101 };
  const labelsOf = (reply_markup: unknown) =>
    inlineButtons({ reply_markup }).map((button) => button.text);

  it('N-lang1 the cycle message prints its won, lost, tied and open blocks and the adaptive line in English', () => {
    const settled = textOf(
      sessionCycleMessage(claimed([L, T, W], { messageId: 42, from: 0 }), martingale, 5, En),
    );
    const opened = textOf(sessionCycleMessage({ ...claimed([W]), open: OPEN }, martingale, 5, En));
    const text = `${settled}\n${opened}`;
    for (const line of [
      '⚡ Cycle 1 Step 1',
      '<pre>🔴 Stake: $5.00 → -$5.00',
      '<pre>⚪ Stake: $5.00 → $0.00, the stake returned',
      '<pre>🟢 Stake: $5.00 → +$9.60',
      `<pre>⏳ Stake: $11.50 · ${BOT_TEXT_SOURCES_EN.actionDown} · trade open`,
      BOT_TEXT_SOURCES_EN.sessionAdaptiveStake,
    ]) {
      expect(text).toContain(line);
    }
    expect(text).not.toMatch(CYRILLIC);
  });

  it('N-lang2 the fallback summary and its buttons are English', () => {
    const view: TradingSessionView = {
      id: '00000000-0000-4000-8000-000000000001',
      mode: 'demo',
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.NoSignalTimeout,
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
    const message = sessionSummaryMessage(view, LABEL, En);
    expect(message.text.value).toBe(
      clientSessionTextsOf(En).sessionSummaryText(LABEL, 101, view).value,
    );
    expect(message.text.value).not.toMatch(CYRILLIC);
    expect(labelsOf(message.reply_markup)).toEqual([
      BOT_TEXT_SOURCES_EN.otherPairButton,
      BOT_TEXT_SOURCES_EN.menuButton,
    ]);
  });

  it('N-lang3 the waiting message and the open block’s «⏹» are English', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const waiting = sessionWaitingMessage(id, En);
    expect(waiting.text.value).toBe(BOT_TEXT_SOURCES_EN.sessionWaitingSignal);
    expect(labelsOf(waiting.reply_markup)).toEqual([BOT_TEXT_SOURCES_EN.sessionStopButton]);
    expect(labelsOf(sessionCycleStopKeyboard(id, En))).toEqual([
      BOT_TEXT_SOURCES_EN.sessionStopButton,
    ]);
  });
});

describe('pairOf', () => {
  const pair = { id: 101, symbol: 'EUR/USD', isOtc: true, digits: 5 } as BinaryPair;
  it('reads the label (#428) and digits of the asset, null for each without it', () => {
    const catalog = { pairs: [pair], fetchedAt: 0, ageMs: 0, fresh: false };
    expect(pairOf(catalog, 101)).toEqual({ label: 'EUR/USD', digits: 5 });
    expect(pairOf(catalog, 7)).toEqual({ label: null, digits: null });
    expect(pairOf(undefined, 101)).toEqual({ label: null, digits: null });
  });
});
