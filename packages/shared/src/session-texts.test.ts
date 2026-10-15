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
  outcome: d('22.08000000'),
  result: SessionTradeResult.Won,
  openPrice: 0.49803,
  closePrice: 0.4982,
  digits: 5,
  cycle: 3,
  step: 2,
  baseStake: d('11.5'),
  ...patch,
});

const view = (patch: Partial<SessionClosingView> = {}): SessionClosingView => ({
  mode: TradeMode.Demo,
  stopReason: TradingSessionStopReason.Completed,
  trades: { planned: 5, settled: 5, rejected: 0, won: 3, lost: 2, tied: 0, profit: d('2.5') },
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

  it('scores «в ноль» only when a trade tied', () => {
    expect(session.scoreOf({ won: 3, lost: 2, tied: 0 })).toBe('3 в плюс, 2 в минус');
    expect(session.scoreOf({ won: 3, lost: 2, tied: 1 })).toBe('3 в плюс, 2 в минус, 1 в ноль');
  });
});

describe('sessionTradeText (#464)', () => {
  it('prints a win as the owner’s sample: the cycle and step, stake → payout, the prices', () => {
    expect(session.sessionTradeText(trade()).value).toBe(
      '⚡ Цикл 3 Шаг 2\n<pre>🟢 Ставка: $11.50 → +$22.08\n📊 Цена: 0.49803 → 0.49820</pre>',
    );
  });

  it('prints a loss red with its loss signed, a tie white with its stake returned', () => {
    expect(
      session.sessionTradeText(trade({ result: SessionTradeResult.Lost, outcome: d('-11.5') }))
        .value,
    ).toContain('🔴 Ставка: $11.50 → -$11.50\n');
    expect(
      session.sessionTradeText(trade({ result: SessionTradeResult.Tied, outcome: d('11.5') }))
        .value,
    ).toContain('⚪ Ставка: $11.50 → +$11.50, ставка вернулась\n');
  });

  it('heads the trade with the adaptive line only when its stake is above the base stake', () => {
    const line = '🔄 Адаптивная ставка включена\n';
    expect(session.sessionTradeText(trade({ baseStake: d('5') })).value.startsWith(line)).toBe(
      true,
    );
    // a fixed session trades at its base stake: equal is not above
    expect(session.sessionTradeText(trade({ baseStake: d('11.5') })).value).not.toContain(line);
    expect(session.sessionTradeText(trade({ baseStake: null })).value).not.toContain(line);
  });

  it('prints the prices with the pair’s digits, and as the broker sent them without a catalog', () => {
    expect(session.sessionTradeText(trade({ digits: 2 })).value).toContain('0.50 → 0.50');
    expect(session.sessionTradeText(trade({ digits: null })).value).toContain(
      '📊 Цена: 0.49803 → 0.4982',
    );
  });

  it('names no strategy to the user', () => {
    for (const result of Object.values(SessionTradeResult)) {
      const text = session.sessionTradeText(trade({ result, baseStake: d('1') })).value;
      expect(text.toLowerCase()).not.toMatch(/мартингейл|martingale/);
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
      '🏁 Сессия завершена: 5 сделок — 3 в плюс, 2 в минус',
      '💰 Результат: +$2.50',
      '🧪 Демобаланс: $10\u00a0002.50',
    ]);
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
