import { describe, expect, it } from 'vitest';
import { plainTextOf, TELEGRAM_CAPTION_LIMIT, type LinkBonusGrantView } from '@binarius/shared';
import { telegramTextProblems } from '@binarius/shared/testing';
import { accountCard, LABELS, TEXTS, type AccountCardInput } from './texts';

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

  describe('the account card', () => {
    // Each hole at its real maximum, made of the characters that mean something in markup:
    // Telegram's 64 for a first name, RFC 5321's 254 for an address, 19 digits for a bigint.
    const NAME = `<&>_*"`.repeat(11).slice(0, 64);
    const ADDRESS = HOSTILE_ARGUMENT;
    const TOKENS = '9'.repeat(19);
    const escaped = (value: string) =>
      value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');

    const GRANTS: readonly [string, LinkBonusGrantView | null][] = [
      ['granted', { granted: true, tokens: TOKENS }],
      ['not partner', { granted: false, reason: 'not_partner_client' }],
      ['already', { granted: false, reason: 'already_granted' }],
      ['unknown', null],
    ];
    const VARIANTS: readonly [string, AccountCardInput][] = GRANTS.flatMap(([label, grant]) => [
      [`email, ${label}`, { firstName: NAME, email: ADDRESS, grant }] as const,
      [`no email, ${label}`, { firstName: NAME, email: null, grant }] as const,
    ]);

    it.each(VARIANTS)('keeps the card (%s) valid and inside the caption limit', (_label, input) => {
      expect(telegramTextProblems(accountCard(input), TELEGRAM_CAPTION_LIMIT)).toEqual([]);
    });

    it.each(VARIANTS)('shows the name and the address (%s) as typed', (_label, input) => {
      const card = accountCard(input);
      expect(plainTextOf(card)).toContain(NAME);
      expect(card.value).toContain(escaped(NAME));
      if (input.email === null) {
        expect(plainTextOf(card)).not.toContain('📧');
      } else {
        expect(plainTextOf(card)).toContain(ADDRESS);
        expect(card.value).toContain(escaped(ADDRESS));
      }
    });

    it('is the greeting, the address, the body and the pack, one blank line apart', () => {
      const card = accountCard({
        firstName: 'Ada',
        email: 'ada@example.test',
        grant: { granted: true, tokens: '7' },
      });
      expect(card.value).toBe(
        [
          `${TEXTS.cardGreeting('Ada').value}\n${TEXTS.cardEmail('ada@example.test').value}`,
          TEXTS.cardBody.value,
          TEXTS.cardBonusGranted('7').value,
        ].join('\n\n'),
      );
    });

    it('says why no pack was paid, and nothing about a pack when that is unknown', () => {
      const card = (grant: LinkBonusGrantView | null) =>
        plainTextOf(accountCard({ firstName: 'Ada', email: null, grant }));
      expect(card({ granted: false, reason: 'not_partner_client' })).toContain(
        plainTextOf(TEXTS.cardBonusNotPartner),
      );
      expect(card({ granted: false, reason: 'already_granted' })).toContain(
        plainTextOf(TEXTS.cardBonusAlready),
      );
      const unknown = card(null);
      expect(unknown).not.toMatch(/🎁|ℹ️/u);
      expect(unknown.endsWith(plainTextOf(TEXTS.cardBody))).toBe(true);
    });

    // the Bot API guarantees a first name non-empty, not non-blank
    it('greets a blank name without it, and trims a padded one', () => {
      expect(TEXTS.cardGreeting('   ').value).toBe('🎉 <b>Привет!</b>');
      expect(TEXTS.cardGreeting(' Ada ').value).toBe('🎉 <b>Привет, Ada!</b>');
    });
  });
});
