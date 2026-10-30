import { describe, expect, it } from 'vitest';
import { BotLanguage } from './bot-language';
import { createBotTexts, defaultBotTextSource } from './bot-texts';
import { BOT_TEXT_SOURCES_EN, enBotTextSource } from './bot-texts-en';
import { pairLabel, type PairLabel } from './catalog';
import type { DecimalString } from './money';
import { AdaptiveLineSlot, SessionStakeStrategy, SessionTradeResult } from './session-steps';
import {
  createSessionTexts,
  SESSION_STOP_LINES,
  type SessionClosingView,
  type SessionOpenNotice,
  type SessionTradeNotice,
} from './session-texts';
import { TradeAction, TradeMode } from './trading';
import { buildH1SessionSettings, TradingSessionStopReason } from './trading-session';

const texts = createBotTexts(defaultBotTextSource);
const session = createSessionTexts({ ...texts, language: BotLanguage.Ru });
const english = createSessionTexts({
  ...createBotTexts(enBotTextSource),
  language: BotLanguage.En,
});
const d = (value: string) => value as DecimalString;

const trade = (patch: Partial<SessionTradeNotice> = {}): SessionTradeNotice => ({
  amount: d('11.50000000'),
  outcome: d('22.08000000'),
  result: SessionTradeResult.Won,
  openPrice: 0.49803,
  closePrice: 0.4982,
  digits: 5,
  cycle: 3,
  step: 1,
  adaptiveLine: null,
  ...patch,
});

const settingsOf = (durationSec: number): SessionClosingView['settings'] => ({
  version: 1,
  assetId: 42,
  durationSec,
  trades: 5,
  stake: { baseStake: d('1.00000000'), stakeScale: 8 },
});

const view = (patch: Partial<SessionClosingView> = {}): SessionClosingView => ({
  mode: TradeMode.Demo,
  stopReason: TradingSessionStopReason.Completed,
  trades: { settled: 5, rejected: 0, won: 3, lost: 2, tied: 0, profit: d('2.5') },
  cycles: { planned: 5, closed: 5 },
  balance: { available: d('10002.5'), ageSec: 0, current: true },
  settings: settingsOf(15),
  ...patch,
});

describe('the session words', () => {
  it.each([
    [1, 'сделка'],
    [2, 'сделки'],
    [5, 'сделок'],
    [11, 'сделок'],
    [21, 'сделка'],
  ])('%i takes «%s»', (count, word) => {
    expect(session.pluralTrades(count)).toBe(word);
  });

  it.each([
    [1, '1 цикл'],
    [2, '2 цикла'],
    [5, '5 циклов'],
    [11, '11 циклов'],
    [21, '21 цикл'],
  ])('%i cycles read «%s» (#552)', (count, words) => {
    expect(session.cyclesCount(count)).toBe(words);
  });

  it.each([
    [1, '1 свеча'],
    [2, '2 свечи'],
    [5, '5 свечей'],
    [11, '11 свечей'],
    [20, '20 свечей'],
  ])('%i candles read «%s» (#637)', (count, words) => {
    expect(session.candlesCount(count)).toBe(words);
  });

  it('scores «в ноль» only when a trade tied', () => {
    expect(session.scoreOf({ won: 3, lost: 2, tied: 0 })).toBe('3 в плюс, 2 в минус');
    expect(session.scoreOf({ won: 3, lost: 2, tied: 1 })).toBe('3 в плюс, 2 в минус, 1 в ноль');
  });
});

describe('the English session words (#633)', () => {
  it.each([
    [1, 'trade'],
    [2, 'trades'],
    [5, 'trades'],
    [11, 'trades'],
    [21, 'trades'],
  ])('W-en1 %i takes «%s»', (count, word) => {
    expect(english.pluralTrades(count)).toBe(word);
  });

  it.each([
    [1, '1 cycle'],
    [2, '2 cycles'],
    [21, '21 cycles'],
  ])('W-en2 %i cycles read «%s»', (count, words) => {
    expect(english.cyclesCount(count)).toBe(words);
  });

  it.each([
    [1, '1 candle'],
    [2, '2 candles'],
    [20, '20 candles'],
    [21, '21 candles'],
  ])('W-en3 %i candles read «%s»', (count, words) => {
    expect(english.candlesCount(count)).toBe(words);
  });

  // the English rule never picks the few form, so its word must be the many one
  it('W-en4 the English few words equal the many words', () => {
    expect(BOT_TEXT_SOURCES_EN.sessionTradeFew).toBe(BOT_TEXT_SOURCES_EN.sessionTradeMany);
    expect(BOT_TEXT_SOURCES_EN.sessionCycleFew).toBe(BOT_TEXT_SOURCES_EN.sessionCycleMany);
    expect(BOT_TEXT_SOURCES_EN.sessionCandleFew).toBe(BOT_TEXT_SOURCES_EN.sessionCandleMany);
  });

  it('W-en5 the English summary prints its completed line in English, with no Cyrillic', () => {
    const summary = english.sessionSummaryText(pairLabel({ symbol: 'EUR/USD' }), 42, view()).value;
    const completed = BOT_TEXT_SOURCES_EN.sessionCompleted
      .replace('{cycles}', '5 cycles')
      .replace('{result}', `5 trades — ${english.scoreOf({ won: 3, lost: 2, tied: 0 })}`);
    expect(summary.split('\n')[1]).toBe(completed);
    expect(summary).not.toMatch(/[А-Яа-яЁё]/u);
  });
});

describe('sessionCycleText (#551)', () => {
  const ADAPTIVE = '🔄 Адаптивная ставка';
  const text = (trades: SessionTradeNotice[]) => session.sessionCycleText(trades).value;

  it('a cycle of one trade is its block alone: the cycle and step, stake → stake + profit, the prices', () => {
    expect(text([trade()])).toBe(
      '⚡ Цикл 3 Шаг 1\n<pre>🟢 $11.50 → +$22.08\n📊 0.49803 → 0.49820</pre>',
    );
  });

  it('prints a fractional stake and its return with every fraction digit (#684)', () => {
    expect(text([trade({ amount: d('0.005'), outcome: d('0.0096') })])).toContain(
      '🟢 $0.005 → +$0.0096\n',
    );
  });

  it('prints a loss red with its loss signed, a tie white at $0.00 with its stake returned (#539)', () => {
    expect(text([trade({ result: SessionTradeResult.Lost, outcome: d('-11.5') })])).toContain(
      '🔴 $11.50 → -$11.50\n',
    );
    expect(text([trade({ result: SessionTradeResult.Tied, outcome: d('0.00000000') })])).toContain(
      '⚪ $11.50 → $0.00\n↩️ ставка вернулась\n',
    );
  });

  const { Below, Above } = AdaptiveLineSlot;
  const lost = (patch: Partial<SessionTradeNotice> = {}) =>
    trade({ result: SessionTradeResult.Lost, outcome: d('-11.5'), ...patch });

  it('CT1 a lost step 1 with its slot below: the block, then the adaptive line alone (#718)', () => {
    expect(text([lost({ adaptiveLine: Below })])).toBe(
      `⚡ Цикл 3 Шаг 1\n<pre>🔴 $11.50 → -$11.50\n📊 0.49803 → 0.49820</pre>\n\n${ADAPTIVE}`,
    );
  });

  it('CT2 lists the steps a blank line apart, the adaptive line once, alone, under the lost step 1', () => {
    const blocks = text([
      lost({ outcome: d('-5'), amount: d('5'), step: 1, adaptiveLine: Below }),
      trade({ result: SessionTradeResult.Tied, outcome: d('0'), amount: d('11.5'), step: 2 }),
      lost({ step: 3 }),
      trade({ step: 4 }),
    ]).split('\n\n');
    expect(blocks.map((block) => block.split('\n')[0])).toEqual([
      '⚡ Цикл 3 Шаг 1',
      ADAPTIVE,
      '⚡ Цикл 3 Шаг 2',
      '⚡ Цикл 3 Шаг 3',
      '⚡ Цикл 3 Шаг 4',
    ]);
    expect(blocks[1]).toBe(ADAPTIVE);
  });

  it('CT3 a tie at step 1: the adaptive line above step 2, whatever its stake (#551)', () => {
    const tied = text([
      trade({ result: SessionTradeResult.Tied, outcome: d('0'), step: 1 }),
      trade({ step: 2, adaptiveLine: Above }),
    ]);
    expect(tied).toContain(`</pre>\n\n${ADAPTIVE}\n\n⚡ Цикл 3 Шаг 2`);
    expect(tied.split(ADAPTIVE)).toHaveLength(2);
  });

  it('CT4 a continuation from step 2 starts with the line only when its slot is above', () => {
    expect(text([trade({ step: 2 })])).not.toContain(ADAPTIVE);
    expect(
      text([trade({ step: 2, adaptiveLine: Above })]).startsWith(
        `${ADAPTIVE}\n\n⚡ Цикл 3 Шаг 2\n`,
      ),
    ).toBe(true);
    expect(text([trade({ step: 3 }), trade({ step: 4 })])).not.toContain(ADAPTIVE);
  });

  it('CT5 blocks without a slot, as under fixed, have no adaptive line', () => {
    expect(text([lost({ step: 1, cycle: 4 }), lost({ step: 1, cycle: 5 })])).not.toContain(
      ADAPTIVE,
    );
  });

  it('prints the prices with the pair’s digits, and as the broker sent them without a catalog', () => {
    expect(text([trade({ digits: 2 })])).toContain('0.50 → 0.50');
    expect(text([trade({ digits: null })])).toContain('📊 0.49803 → 0.4982');
  });

  it('CT7 names no strategy to the user', () => {
    for (const result of Object.values(SessionTradeResult)) {
      const printed = text([
        lost({ step: 1, adaptiveLine: Below }),
        trade({ result, step: 2, adaptiveLine: Above }),
      ]);
      expect(printed.toLowerCase()).not.toMatch(/мартингейл|martingale/);
    }
  });
});

describe('sessionCycleText with the open trade (#700)', () => {
  const ADAPTIVE = '🔄 Адаптивная ставка';
  const open = (patch: Partial<SessionOpenNotice> = {}): SessionOpenNotice => ({
    amount: d('11.50000000'),
    action: TradeAction.Up,
    openPrice: 0.4979,
    digits: 5,
    cycle: 2,
    step: 1,
    adaptiveLine: null,
    ...patch,
  });
  const text = (trades: SessionTradeNotice[], block?: SessionOpenNotice) =>
    session.sessionCycleText(trades, block).value;

  it('the open block alone: the cycle and step, the stake, the direction, the open price, no result', () => {
    expect(text([], open({ step: 3 }))).toBe(
      '⚡ Цикл 2 Шаг 3\n<pre>⏳ $11.50 · ⬆️ Вверх\n📊 0.49790 → …</pre>',
    );
  });

  it('names the direction from the catalog, down too', () => {
    expect(text([], open({ action: TradeAction.Down }))).toContain(
      `<pre>⏳ $11.50 · ${texts.plain.actionDown}\n`,
    );
  });

  it('prints the open price with the pair’s digits, and as the broker sent it without a catalog', () => {
    expect(text([], open({ digits: 2 }))).toContain('📊 0.50 → …');
    expect(text([], open({ digits: null }))).toContain('📊 0.4979 → …');
  });

  it('stands last, after the settled blocks, a blank line apart', () => {
    const blocks = text([trade({ cycle: 2, step: 1 })], open({ step: 3 })).split('\n\n');
    expect(blocks.map((block) => block.split('\n')[0])).toEqual([
      '⚡ Цикл 2 Шаг 1',
      '⚡ Цикл 2 Шаг 3',
    ]);
    expect(blocks[1]).toContain('<pre>⏳');
  });

  it('CT6 the open block prints its slot as a settled one: above it once; under a lost step 1 the line stands between (#718)', () => {
    const { Below, Above } = AdaptiveLineSlot;
    const afterTie = text(
      [trade({ result: SessionTradeResult.Tied, outcome: d('0'), cycle: 2, step: 1 })],
      open({ step: 2, adaptiveLine: Above }),
    );
    expect(afterTie).toContain(`</pre>\n\n${ADAPTIVE}\n\n⚡ Цикл 2 Шаг 2\n<pre>⏳`);
    expect(afterTie.split(ADAPTIVE)).toHaveLength(2);
    const afterLoss = text(
      [trade({ result: SessionTradeResult.Lost, cycle: 2, step: 1, adaptiveLine: Below })],
      open({ step: 2 }),
    );
    expect(afterLoss).toContain(`</pre>\n\n${ADAPTIVE}\n\n⚡ Цикл 2 Шаг 2\n<pre>⏳`);
    expect(afterLoss.split(ADAPTIVE)).toHaveLength(2);
    expect(
      text([], open({ step: 2, adaptiveLine: Above })).startsWith(
        `${ADAPTIVE}\n\n⚡ Цикл 2 Шаг 2\n`,
      ),
    ).toBe(true);
    expect(text([], open({ step: 2 }))).not.toContain(ADAPTIVE);
  });

  it('without the open trade, the settled blocks alone', () => {
    expect(text([trade()])).not.toContain('<pre>⏳');
  });
});

describe('sessionSummaryText (#464)', () => {
  const lines = (
    closing: SessionClosingView,
    symbol: PairLabel | null = pairLabel({ symbol: 'EUR/USD' }),
  ) => session.sessionSummaryText(symbol, 42, closing).value.split('\n');

  it('a completed session: the pair, the completion line, the result and the balance', () => {
    expect(lines(view())).toEqual([
      '📈 EUR/USD',
      '🏁 Сессия завершена: 5 циклов, 5 сделок — 3 в плюс, 2 в минус',
      '💰 Результат: +$2.50',
      '🧪 Демобаланс: $10\u00a0002.50',
    ]);
  });

  // #552: the cycles are the session's length, the trades and the score stay by trade
  it('a completed session counts its cycles apart from its trades: 5 циклов, 8 сделок', () => {
    const summary = lines(
      view({
        cycles: { planned: 5, closed: 5 },
        trades: { settled: 8, rejected: 0, won: 5, lost: 3, tied: 0, profit: d('2.5') },
      }),
    );
    expect(summary[1]).toBe('🏁 Сессия завершена: 5 циклов, 8 сделок — 5 в плюс, 3 в минус');
  });

  it('a session the user stopped: its stop line and the total, never «завершена»', () => {
    const summary = lines(view({ stopReason: TradingSessionStopReason.UserStopped }));
    expect(summary[1]).toBe(texts.html.sessionStopUserStopped.value);
    expect(summary[2]).toBe('📊 Итог: 5 сделок — 3 в плюс, 2 в минус');
    expect(summary.join('\n')).not.toContain('завершена');
  });

  it.each(Object.entries(SESSION_STOP_LINES))(
    'the stop reason %s prints its own line',
    (reason, key) => {
      expect(lines(view({ stopReason: reason as keyof typeof SESSION_STOP_LINES }))[1]).toBe(
        texts.html[key].value,
      );
    },
  );

  // #450: the four martingale limits, each its own text with no promise of a result
  it.each([
    [
      TradingSessionStopReason.MaxStepsExceeded,
      '🛑 Сессия остановлена: серия проигрышей дошла до лимита повышений ставки.',
    ],
    [
      TradingSessionStopReason.MaxStakeExceeded,
      '🛑 Сессия остановлена: следующая ставка вышла бы за лимит размера ставки.',
    ],
    [
      TradingSessionStopReason.MaxSessionLossExceeded,
      '🛑 Сессия остановлена: следующая сделка могла бы превысить лимит убытка сессии.',
    ],
    [
      TradingSessionStopReason.SessionDurationExceeded,
      '⏱ Сессия остановлена: истёк час на сессию.',
    ],
  ])('the stop reason %s prints its text', (stopReason, line) => {
    expect(lines(view({ stopReason }))[1]).toBe(line);
  });

  // #509, #637: the line carries the limit in candles of the session's signal interval, from the
  // constant the worker stops by; the candle, not the trade (a 20 s session waits on 15 s candles)
  it.each([
    [15, '15'],
    [5, '5'],
    [20, '15'],
  ])(
    'the stop reason no_signal_timeout of a %i s session prints 20 candles of %s s',
    (durationSec, sec) => {
      expect(
        lines(
          view({
            stopReason: TradingSessionStopReason.NoSignalTimeout,
            settings: settingsOf(durationSec),
          }),
        )[1],
      ).toBe(
        `⏳ Сессия остановлена: по паре не было сигнала 20 свечей по ${sec} с. Выбери другую пару.`,
      );
    },
  );

  it('the stop reason no_signal_timeout without readable settings prints no figure (#637)', () => {
    expect(
      lines(view({ stopReason: TradingSessionStopReason.NoSignalTimeout, settings: null }))[1],
    ).toBe('⏳ Сессия остановлена: по паре долго не было сигнала. Выбери другую пару.');
  });

  it('a real session prints the real balance; a balance read before the last trade, its age', () => {
    expect(
      lines(
        view({
          mode: TradeMode.Real,
          balance: { available: d('250'), ageSec: 90, current: false },
        }),
      ).slice(-2),
    ).toEqual(['💵 Реальный баланс: $250.00', texts.html.statusStale({ age: 90 }).value]);
  });

  it('no balance: the result alone', () => {
    expect(lines(view({ balance: null })).at(-1)).toBe('💰 Результат: +$2.50');
  });

  it('the asset by its id when the catalog could not say', () => {
    expect(lines(view(), null)[0]).toBe(`📈 ${texts.plain.intentAssetFallback({ assetId: '42' })}`);
  });
});

describe('the completed line of an H1 session (#775)', () => {
  const h1 = buildH1SessionSettings({
    assetId: 42,
    cycles: 5,
    stake: { baseStake: d('1.00'), stakeScale: 2 },
    strategy: SessionStakeStrategy.Martingale,
  });
  if (!h1.success) throw new Error('fixture: H1 settings');
  const completed = view({
    settings: h1.data,
    cycles: { planned: 5, closed: 5 },
    trades: { settled: 8, rejected: 0, won: 5, lost: 3, tied: 0, profit: d('5') },
  });

  it('H1-F1′ counts the cycles as any session, in the summary and the end line', () => {
    const line = '🏁 Сессия завершена: 5 циклов, 8 сделок — 5 в плюс, 3 в минус';
    const summary = session.sessionSummaryText(pairLabel({ symbol: 'EUR/USD' }), 42, completed);
    expect(summary.value.split('\n')[1]).toBe(line);
    expect(session.sessionEndLine(completed).value).toBe(line);
  });

  it('a completed v1 session keeps its cycles line', () => {
    expect(session.sessionEndLine(view()).value).toBe(
      '🏁 Сессия завершена: 5 циклов, 5 сделок — 3 в плюс, 2 в минус',
    );
  });
});
