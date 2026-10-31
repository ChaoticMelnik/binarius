import { describe, expect, it } from 'vitest';
import { BotLanguage } from './bot-language';
import type { DecimalString } from './money';
import { createBotTexts, defaultBotTextSource } from './bot-texts';
import { enBotTextSource } from './bot-texts-en';
import {
  demoToRealText,
  type DemoToRealBonus,
  type DemoToRealFacts,
  type DemoToRealIntroKey,
} from './demo-to-real-text';
import { plainTextOf } from './telegram-html';

const d = (value: string) => value as DecimalString;
const ru = { ...createBotTexts(defaultBotTextSource), language: BotLanguage.Ru as BotLanguage };
const en = { ...createBotTexts(enBotTextSource), language: BotLanguage.En as BotLanguage };
const FACTS: DemoToRealFacts = {
  sessions: 3,
  settled: 12,
  won: 6,
  lost: 6,
  tied: 0,
  profit: d('-1.50000000'),
};
const BONUS: DemoToRealBonus = {
  tokensPerUsd: d('0.50000000'),
  minAmountUsd: d('10.00000000'),
  maxTokens: d('500.00000000'),
};
const lines = (
  {
    intro = 'demoToRealIntro1h',
    facts = FACTS,
    bonus = BONUS,
  }: { intro?: DemoToRealIntroKey; facts?: DemoToRealFacts; bonus?: DemoToRealBonus | null },
  texts = ru,
) => plainTextOf(demoToRealText(texts, { intro, facts, bonus })).split('\n');

describe('the demo-to-real chain text (#880)', () => {
  it('DT1 the intro, an empty line, the facts, the bonus, the risk and the button', () => {
    expect(lines({})).toEqual([
      '🎓 На демо ты освоился',
      '',
      'Следующий этап — реальный счёт.',
      '',
      '📊 Твоё демо: 3 демо-сессии, 12 сделок — 6 в плюс, 6 в минус, результат -$1.50.',
      '🎁 Токены за пополнение: 0.5 за каждый $1 при сумме от $10.00, не больше 500 за одно пополнение.',
      '⚠️ Реальные деньги — реальный риск: сделки могут закрываться в минус, внесённую сумму можно потерять.',
      '👇 «💳 Пополнить» — пополнить счёт в кассе.',
    ]);
    expect(lines({ intro: 'demoToRealIntro72h' }).slice(0, 3)).toEqual([
      '📌 Ещё раз о реальном счёте',
      '',
      'Пополнение — в кассе по кнопке ниже.',
    ]);
  });

  it('DT2 the result keeps its sign and every digit: minus, plus and a zero without one', () => {
    const facts = (profit: string) =>
      lines({ facts: { ...FACTS, profit: d(profit) }, bonus: null })[4]!.split('результат ')[1];
    expect(facts('-1.75150000')).toBe('-$1.7515.');
    expect(facts('2')).toBe('+$2.00.');
    expect(facts('0')).toBe('$0.00.');
  });

  it('DT3 a minimum of zero prints the line without «from»', () => {
    expect(lines({ bonus: { ...BONUS, minAmountUsd: d('0.00000000') } })[5]).toBe(
      '🎁 Токены за пополнение: 0.5 за каждый $1, не больше 500 за одно пополнение.',
    );
    expect(lines({ bonus: { ...BONUS, minAmountUsd: d('0.5') } })[5]).toContain(
      'при сумме от $0.50',
    );
  });

  it('DT4 without an active deposit_bonus version there is no bonus line', () => {
    const text = lines({ bonus: null });
    expect(text).toHaveLength(7);
    expect(text.join('\n')).not.toContain('🎁');
    expect(text.at(-2)).toMatch(/^⚠️/u);
  });

  it('DT5 the session word follows the number, and English has no Russian word', () => {
    const sessionsOf = (sessions: number, texts = ru) =>
      lines({ facts: { ...FACTS, sessions } }, texts)[4]!.split(', ')[0];
    expect(sessionsOf(1)).toBe('📊 Твоё демо: 1 демо-сессия');
    expect(sessionsOf(5)).toBe('📊 Твоё демо: 5 демо-сессий');
    expect(sessionsOf(22)).toBe('📊 Твоё демо: 22 демо-сессии');
    expect(sessionsOf(1, en)).toBe('📊 Your demo: 1 demo session');
    expect(sessionsOf(3, en)).toBe('📊 Your demo: 3 demo sessions');
    const text = lines({}, en).join('\n');
    expect(text).not.toMatch(/[а-яё]/iu);
    expect(text).toContain('net -$1.50');
    expect(text).toContain('⚠️ Real money is real risk');
  });
});
