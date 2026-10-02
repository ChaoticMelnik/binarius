import { describe, expect, it } from 'vitest';
import {
  CONFIRM_CALLBACK_PATTERN,
  confirmCallbackData,
  LINK_LABELS,
  LINK_TEXTS,
} from './link-confirmation';
import { plainTextOf, TELEGRAM_MESSAGE_LIMIT, telegramHtmlProblems } from './telegram-html';

const ACCOUNT_ID = '0b7e3a52-8c1d-4f6e-9a2b-3c4d5e6f7a8b';

describe('link confirmation', () => {
  // Bot API: callback_data is 1-64 bytes
  it('keeps the confirm callback data inside 64 bytes', () => {
    expect(new TextEncoder().encode(confirmCallbackData(ACCOUNT_ID)).length).toBeLessThanOrEqual(
      64,
    );
  });

  it('matches its own callback data and returns the account id', () => {
    expect(CONFIRM_CALLBACK_PATTERN.exec(confirmCallbackData(ACCOUNT_ID))?.[1]).toBe(ACCOUNT_ID);
  });

  it.each([
    ['another button', 'connect'],
    ['a short id', 'confirm:abc'],
    ['an uppercase id', `confirm:${ACCOUNT_ID.toUpperCase()}`],
    ['trailing data', `confirm:${ACCOUNT_ID}x`],
  ])('rejects %s', (_name, data) => {
    expect(CONFIRM_CALLBACK_PATTERN.test(data)).toBe(false);
  });

  // Measured as Telegram counts it: on the text after entities parsing, in UTF-16 code units
  // (String#length). The validator is what stands between a typo in a tag and a refused message.
  it.each(Object.entries(LINK_TEXTS))('keeps %s valid Telegram HTML', (_key, text) => {
    expect(telegramHtmlProblems(text.value)).toEqual([]);
    const plain = plainTextOf(text);
    expect(plain.trim().length).toBeGreaterThan(0);
    expect(plain.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    for (const line of plain.split('\n')) expect(line).toBe(line.trim());
  });

  it('labels the confirm button with the email, or without one when the broker sent none', () => {
    expect(LINK_LABELS.confirmButton('ada@example.test')).toBe('✅ Подтвердить: ada@example.test');
    expect(LINK_LABELS.confirmButton(null)).toBe('✅ Подтвердить привязку');
  });

  // a label is not parsed by Telegram: an entity in it would be shown literally
  it("puts the broker's email into the label as it is, unescaped", () => {
    expect(LINK_LABELS.confirmButton('a&b<c>_*@example.test')).toBe(
      '✅ Подтвердить: a&b<c>_*@example.test',
    );
  });
});
