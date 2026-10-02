import { describe, expect, it } from 'vitest';
import { plainTextOf, TELEGRAM_CAPTION_LIMIT } from '@binarius/shared';
import { telegramTextProblems } from '@binarius/shared/testing';
import { LABELS, TEXTS } from './texts';

describe('texts', () => {
  // the welcome travels as a caption whenever WELCOME_VIDEO_FILE_ID is set, and a caption over
  // the limit is refused by the Bot API — which would only show up once a video is configured
  it('keeps the welcome inside the caption limit', () => {
    expect(telegramTextProblems(TEXTS.welcome, TELEGRAM_CAPTION_LIMIT)).toEqual([]);
  });

  // A function is called with a 254-character argument, RFC 5321's limit for an address, made of
  // every character that means something in HTML or Markdown. The wire schema does not bound the
  // email, so the length is a margin check, not a guarantee.
  const HOSTILE_ARGUMENT = `<&>_*"`.repeat(43).slice(0, 254);
  const textOf = (entry: (typeof TEXTS)[keyof typeof TEXTS]) =>
    typeof entry === 'function' ? entry(HOSTILE_ARGUMENT) : entry;

  it.each(Object.entries(TEXTS))(
    'keeps %s valid Telegram HTML, inside the limit, non-empty, with no padded line',
    (_key, entry) => {
      expect(telegramTextProblems(textOf(entry))).toEqual([]);
    },
  );

  it.each(
    Object.entries(TEXTS).filter(
      (pair): pair is [string, (value: string) => ReturnType<typeof TEXTS.codeSent>] =>
        typeof pair[1] === 'function',
    ),
  )('shows what went into %s as it is, escaped in the markup', (_key, entry) => {
    const text = entry(HOSTILE_ARGUMENT);
    expect(plainTextOf(text)).toContain(HOSTILE_ARGUMENT);
    expect(text.value).toContain(
      HOSTILE_ARGUMENT.replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    );
  });

  // labels are not parsed by Telegram: markup or an entity in one would be shown literally
  it.each(Object.entries(LABELS))('keeps the label %s plain and non-empty', (_key, entry) => {
    const label = typeof entry === 'function' ? entry('ada@example.test') : entry;
    expect(label.trim().length).toBeGreaterThan(0);
    expect(label).not.toMatch(/[<>]|&(?:lt|gt|amp|quot|#\d+|#x[0-9a-f]+);/i);
  });

  it('starts every button label with an emoji, and the command description without one', () => {
    const { startCommand, ...buttons } = LABELS;
    for (const entry of Object.values(buttons)) {
      const label = typeof entry === 'function' ? entry(null) : entry;
      expect(label).toMatch(/^\p{Extended_Pictographic}/u);
    }
    expect(startCommand).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('names both buttons of the welcome by their labels', () => {
    expect(plainTextOf(TEXTS.welcome)).toContain(`«${LABELS.connectButton}»`);
    expect(plainTextOf(TEXTS.welcome)).toContain(`«${LABELS.oauthButton}»`);
  });

  it('names the resend button by its label where it tells the user to press it', () => {
    expect(plainTextOf(TEXTS.codeSentUnknown('ada@example.test'))).toContain(
      `«${LABELS.resendButton}»`,
    );
  });

  // the same button is pressed after a successful login too, where "expired" would read as a
  // failure (review of PR #176, finding 5)
  it('does not tell a user without a dialog that the code expired', () => {
    expect(plainTextOf(TEXTS.codeRequestStale)).not.toMatch(/ист[её]к/i);
  });
});
