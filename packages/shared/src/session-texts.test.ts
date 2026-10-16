import { describe, expect, it } from 'vitest';
import { createBotTexts, defaultBotTextSource } from './bot-texts';
import { pairLabel, type PairLabel } from './catalog';
import type { DecimalString } from './money';
import { SessionTradeResult } from './session-steps';
import {
  createSessionTexts,
  SESSION_STOP_LINES,
  type SessionClosingView,
  type SessionTradeNotice,
} from './session-texts';
import { TradeMode } from './trading';
import { TradingSessionStopReason } from './trading-session';

const texts = createBotTexts(defaultBotTextSource);
const session = createSessionTexts(texts);
const d = (value: string) => value as DecimalString;

const trade = (patch: Partial<SessionTradeNotice> = {}): SessionTradeNotice => ({
  amount: d('11.50000000'),
  outcome: d('10.58000000'),
  result: SessionTradeResult.Won,
  openPrice: 0.49803,
  closePrice: 0.4982,
  digits: 5,
  cycle: 3,
  step: 1,
  ...patch,
});

const view = (patch: Partial<SessionClosingView> = {}): SessionClosingView => ({
  mode: TradeMode.Demo,
  stopReason: TradingSessionStopReason.Completed,
  trades: { settled: 5, rejected: 0, won: 3, lost: 2, tied: 0, profit: d('2.5') },
  cycles: { planned: 5, closed: 5 },
  balance: { available: d('10002.5'), ageSec: 0, current: true },
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

  it('scores «в ноль» only when a trade tied', () => {
    expect(session.scoreOf({ won: 3, lost: 2, tied: 0 })).toBe('3 в плюс, 2 в минус');
    expect(session.scoreOf({ won: 3, lost: 2, tied: 1 })).toBe('3 в плюс, 2 в минус, 1 в ноль');
  });
});

describe('sessionCycleText (#551)', () => {
  const ADAPTIVE = '🔄 Адаптивная ставка включена';
  const text = (trades: SessionTradeNotice[]) => session.sessionCycleText(trades).value;

  it('a cycle of one trade is its block alone: the cycle and step, stake → profit, the prices', () => {
    expect(text([trade()])).toBe(
      '⚡ Цикл 3 Шаг 1\n<pre>🟢 Ставка: $11.50 → +$10.58\n📊 Цена: 0.49803 → 0.49820</pre>',
    );
  });

  it('prints a loss red with its loss signed, a tie white at $0.00 with its stake returned (#539)', () => {
    expect(text([trade({ result: SessionTradeResult.Lost, outcome: d('-11.5') })])).toContain(
      '🔴 Ставка: $11.50 → -$11.50\n',
    );
    expect(text([trade({ result: SessionTradeResult.Tied, outcome: d('0.00000000') })])).toContain(
      '⚪ Ставка: $11.50 → $0.00, ставка вернулась\n',
    );
  });

  it('lists the steps a blank line apart, the adaptive line once, alone, above step 2', () => {
    const blocks = text([
      trade({ result: SessionTradeResult.Lost, outcome: d('-5'), amount: d('5'), step: 1 }),
      trade({ result: SessionTradeResult.Tied, outcome: d('0'), amount: d('11.5'), step: 2 }),
      trade({ result: SessionTradeResult.Lost, outcome: d('-11.5'), step: 3 }),
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

  it('prints the adaptive line at step 2 whatever its stake, after a tie at the base stake too', () => {
    const tied = text([
      trade({ result: SessionTradeResult.Tied, outcome: d('0'), step: 1 }),
      trade({ step: 2 }),
    ]);
    expect(tied).toContain(`</pre>\n\n${ADAPTIVE}\n\n⚡ Цикл 3 Шаг 2`);
  });

  it('a continuation that starts at step 2 starts with the adaptive line; one past it has none', () => {
    expect(text([trade({ step: 2 })]).startsWith(`${ADAPTIVE}\n\n⚡ Цикл 3 Шаг 2\n`)).toBe(true);
    expect(text([trade({ step: 3 }), trade({ step: 4 })])).not.toContain(ADAPTIVE);
  });

  it('a fixed session has no step 2, so no adaptive line', () => {
    expect(text([trade({ step: 1, cycle: 4 })])).not.toContain(ADAPTIVE);
  });

  it('prints the prices with the pair’s digits, and as the broker sent them without a catalog', () => {
    expect(text([trade({ digits: 2 })])).toContain('0.50 → 0.50');
    expect(text([trade({ digits: null })])).toContain('📊 Цена: 0.49803 → 0.4982');
  });

  it('names no strategy to the user', () => {
    for (const result of Object.values(SessionTradeResult)) {
      const printed = text([trade({ step: 1 }), trade({ result, step: 2 })]);
      expect(printed.toLowerCase()).not.toMatch(/мартингейл|martingale/);
    }
  });
});

describe('sessionSummaryText (#464)', () => {
  const lines = (
    closing: SessionClosingView,
    symbol: PairLabel | null = pairLabel({ symbol: 'EUR/USD', isOtc: true }),
  ) => session.sessionSummaryText(symbol, 42, closing).value.split('\n');

  it('a completed session: the pair, the completion line, the result and the balance', () => {
    expect(lines(view())).toEqual([
      '📈 EUR/USD OTC',
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

  // #509: the line carries the limit in minutes, from the constant the worker stops by
  it('the stop reason no_signal_timeout prints the limit in minutes', () => {
    expect(lines(view({ stopReason: TradingSessionStopReason.NoSignalTimeout }))[1]).toBe(
      '⏳ Сессия остановлена: 2 мин по паре не было сигнала. Выбери другую пару.',
    );
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
