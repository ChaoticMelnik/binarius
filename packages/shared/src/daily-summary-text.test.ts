import { describe, expect, it } from 'vitest';
import { BotLanguage } from './bot-language';
import { createBotTexts, defaultBotTextSource } from './bot-texts';
import { enBotTextSource } from './bot-texts-en';
import { dailySummaryCaption, formatDay } from './daily-summary-text';
import type { DailySummaryPayload } from './mailing';
import type { DecimalString } from './money';
import { plainTextOf } from './telegram-html';

const d = (value: string) => value as DecimalString;
const ru = { ...createBotTexts(defaultBotTextSource), language: BotLanguage.Ru as BotLanguage };
const en = { ...createBotTexts(enBotTextSource), language: BotLanguage.En as BotLanguage };
const DAY: DailySummaryPayload = {
  day: '2024-03-12',
  demo: { sessions: 1, settled: 4, won: 2, lost: 1, tied: 1, profit: d('3.00000000') },
  real: { sessions: 0, settled: 1, won: 0, lost: 1, tied: 0, profit: d('-2.50000000') },
};
const lines = (payload: DailySummaryPayload, texts = ru) =>
  plainTextOf(dailySummaryCaption(texts, payload)).split('\n');

describe('the daily summary caption (#881)', () => {
  it('DT-DS1 prints the day as dd.mm.yyyy', () => {
    expect(formatDay('2026-10-30')).toBe('30.10.2026');
    expect(formatDay('2024-03-02')).toBe('02.03.2024');
  });

  it('DT-DS2 the title with the day, an empty line, demo, real and the button line; a loss keeps its sign, zero is $0.00', () => {
    expect(lines(DAY)).toEqual([
      '📊 Итоги дня: 12.03.2024',
      '',
      '🎮 Демо: 4 сделки — 2 в плюс, 1 в минус, 1 в ноль, результат +$3.00.',
      '🚀 Реал: 1 сделка — 0 в плюс, 1 в минус, результат -$2.50.',
      '👇 Торговля — по кнопке ниже.',
    ]);
    const quiet = { sessions: 2, settled: 0, won: 0, lost: 0, tied: 0, profit: d('0') };
    expect(lines({ ...DAY, real: quiet })[3]).toBe(
      '🚀 Реал: 0 сделок — 0 в плюс, 0 в минус, результат $0.00.',
    );
  });

  it('DT-DS3 the English catalog prints the English caption', () => {
    const text = lines(DAY, en);
    expect(text[0]).toBe('📊 Day results: 12.03.2024');
    expect(text.join('\n')).not.toMatch(/[а-яё]/i);
  });
});
