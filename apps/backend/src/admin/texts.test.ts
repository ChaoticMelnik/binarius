import { describe, expect, it } from 'vitest';
import { ADMIN_TEXTS } from './texts';

describe('the staff bot’s button answers', () => {
  // answerCallbackQuery's text limit, counted in UTF-16 code units, which is what String#length
  // returns. A longer text makes Telegram refuse the answer, and the refusal is only a warn line.
  const CALLBACK_ANSWER_LIMIT = 200;

  it.each([
    ['confirmed', ADMIN_TEXTS.confirmed],
    ['codeFailed', ADMIN_TEXTS.codeFailed],
    ['denied', ADMIN_TEXTS.denied],
    ['stale', ADMIN_TEXTS.stale],
    ['linkFailed', ADMIN_TEXTS.linkFailed],
    ['linkRateLimited', ADMIN_TEXTS.linkRateLimited],
  ] as const)('keeps %s non-empty and inside the limit', (_key, text) => {
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(CALLBACK_ANSWER_LIMIT);
  });
});
