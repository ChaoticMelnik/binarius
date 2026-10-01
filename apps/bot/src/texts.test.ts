import { describe, expect, it } from 'vitest';
import { CAPTION_LIMIT, MESSAGE_LIMIT, TEXTS } from './texts';

// The Bot API counts its 1024/4096 limits in UTF-16 code units, which is what String#length
// returns; counting code points would let an astral character through here and be refused by
// Telegram.
describe('texts', () => {
  // the welcome travels as a caption whenever WELCOME_VIDEO_FILE_ID is set, and a caption over
  // the limit is refused by the Bot API — which would only show up once a video is configured
  it('keeps the welcome inside the caption limit', () => {
    expect(TEXTS.welcome.length).toBeLessThanOrEqual(CAPTION_LIMIT);
  });

  // A function is measured with a 254-character argument, RFC 5321's limit for an address. The
  // wire schema does not bound the email, so this is a margin check, not a guarantee.
  const LONGEST_ARGUMENT = 'x'.repeat(254);
  it.each(Object.entries(TEXTS))(
    'keeps %s inside the message limit and non-empty',
    (_key, entry) => {
      const text = typeof entry === 'function' ? entry(LONGEST_ARGUMENT) : entry;
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    },
  );

  it('names both buttons of the welcome by their labels', () => {
    expect(TEXTS.welcome).toContain(`«${TEXTS.connectButton}»`);
    expect(TEXTS.welcome).toContain(`«${TEXTS.oauthButton}»`);
  });

  // the same button is pressed after a successful login too, where "expired" would read as a
  // failure (review of PR #176, finding 5)
  it('does not tell a user without a dialog that the code expired', () => {
    expect(TEXTS.codeRequestStale).not.toMatch(/истек/i);
  });

  it('labels the confirm button with the email, or without one when the broker sent none', () => {
    expect(TEXTS.confirmButton('ada@example.test')).toBe('Подтвердить: ada@example.test');
    expect(TEXTS.confirmButton(null)).toBe('Подтвердить привязку');
  });
});
