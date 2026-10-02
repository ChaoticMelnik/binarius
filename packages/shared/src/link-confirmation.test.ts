import { describe, expect, it } from 'vitest';
import {
  CONFIRM_CALLBACK_PATTERN,
  confirmCallbackData,
  LINK_LABELS,
  LINK_TEXTS,
} from './link-confirmation';
import { telegramTextProblems } from './testing';

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

  // The validator is what stands between a typo in a tag and a refused message.
  it.each(Object.entries(LINK_TEXTS))(
    'keeps %s valid Telegram HTML, inside the limit, non-empty, with no padded line',
    (_key, text) => {
      expect(telegramTextProblems(text)).toEqual([]);
    },
  );

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
