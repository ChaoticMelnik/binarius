import { describe, expect, it } from 'vitest';
import {
  CONFIRM_CALLBACK_PATTERN,
  confirmCallbackData,
  LINK_TEXTS,
  TELEGRAM_MESSAGE_LIMIT,
} from './link-confirmation';

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

  // String#length counts UTF-16 code units, which is what the Bot API limit counts. A function is
  // measured with a 254-character argument, RFC 5321's limit for an address.
  const LONGEST_ARGUMENT = 'x'.repeat(254);
  it.each(Object.entries(LINK_TEXTS))(
    'keeps %s inside the message limit and non-empty',
    (_key, entry) => {
      const text = typeof entry === 'function' ? entry(LONGEST_ARGUMENT) : entry;
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    },
  );

  it('labels the confirm button with the email, or without one when the broker sent none', () => {
    expect(LINK_TEXTS.confirmButton('ada@example.test')).toBe('Подтвердить: ada@example.test');
    expect(LINK_TEXTS.confirmButton(null)).toBe('Подтвердить привязку');
  });
});
