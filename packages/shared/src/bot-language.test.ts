import { describe, expect, it } from 'vitest';
import { BotLanguage, botLanguageOf, botLanguageSchema, DEFAULT_BOT_LANGUAGE } from './bot-language';

describe('botLanguageOf', () => {
  it.each([
    [undefined, 'ru'],
    [null, 'ru'],
    ['ru', 'ru'],
    ['ru-RU', 'ru'],
    ['RU', 'ru'],
    ['Ru-ru', 'ru'],
    ['rus', 'en'],
    ['en', 'en'],
    ['en-US', 'en'],
    ['uk', 'en'],
    ['be', 'en'],
    ['kk', 'en'],
    ['de-DE', 'en'],
  ] as const)('%s → %s', (code, language) => {
    expect(botLanguageOf(code)).toBe(language);
  });

  it('the default is Russian, and the schema takes exactly the two languages', () => {
    expect(DEFAULT_BOT_LANGUAGE).toBe(BotLanguage.Ru);
    expect(botLanguageSchema.options).toEqual(['ru', 'en']);
    expect(botLanguageSchema.safeParse('RU').success).toBe(false);
    expect(botLanguageSchema.safeParse('').success).toBe(false);
  });
});
