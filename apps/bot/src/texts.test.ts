import { describe, expect, it } from 'vitest';
import {
  BrokerAccountStatus,
  NotificationLevel,
  plainTextOf,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
  USER_ACCOUNT_LIST_LIMIT,
  type LinkBonusGrantView,
  type LinkedAccountView,
} from '@binarius/shared';
import { telegramTextProblems } from '@binarius/shared/testing';
import { LINK_ACTIVE, LINK_PENDING, LINK_REVOKED, PENDING_ACCOUNT_ID } from './testing';
import { LEVEL_CURRENT_CALLBACK_DATA, levelCallbackData } from './bot';
import {
  accountCard,
  accountStatus,
  currentLevelLabel,
  LABELS,
  levelLabel,
  PROFILE,
  settingsText,
  SUPPORT,
  supportUrl,
  TEXTS,
  type AccountCardInput,
} from './texts';

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

  // a key ending in `Command` is a description in Telegram's command menu, every other one a button
  it.each(Object.entries(LABELS))(
    'gives %s an emoji at the start if it is a button, and none if it is a command description',
    (key, entry) => {
      const label = typeof entry === 'function' ? entry(null) : entry;
      if (key.endsWith('Command')) expect(label).not.toMatch(/\p{Extended_Pictographic}/u);
      else expect(label).toMatch(/^\p{Extended_Pictographic}/u);
    },
  );

  // #120
  describe('the notification levels and support', () => {
    it.each(Object.values(NotificationLevel))(
      'lists %s in the /settings legend by its label',
      (level) => {
        const text = plainTextOf(TEXTS.settings('ignored'));
        expect(text.split('\n').some((line) => line.startsWith(`${levelLabel(level)} — `))).toBe(
          true,
        );
      },
    );

    it('names the selected level in bold', () => {
      expect(settingsText(NotificationLevel.Reduced).value).toContain(
        `Сейчас выбрано: <b>${LABELS.levelReduced}</b>`,
      );
    });

    it('maps each level to its label, and marks the selected one', () => {
      expect(Object.values(NotificationLevel).map(levelLabel)).toEqual([
        LABELS.levelAll,
        LABELS.levelReduced,
        LABELS.levelOff,
      ]);
      expect(currentLevelLabel(NotificationLevel.Off)).toBe(`${LABELS.levelOff} ✅`);
    });

    // Bot API: callback data is 1-64 bytes
    it.each([
      ...Object.values(NotificationLevel).map(levelCallbackData),
      LEVEL_CURRENT_CALLBACK_DATA,
    ])('keeps the callback data %s inside 64 bytes', (data) => {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    });

    // Telegram usernames: 5-32 letters, digits and underscores
    it('leads /support to an https t.me link of a valid username', () => {
      expect(SUPPORT.telegramUsername).toMatch(/^[A-Za-z0-9_]{5,32}$/);
      const url = new URL(supportUrl());
      expect(url.protocol).toBe('https:');
      expect(url.host).toBe('t.me');
      expect(url.pathname).toBe(`/${SUPPORT.telegramUsername}`);
    });

    it('points every «напиши в поддержку» to /support', () => {
      for (const text of [TEXTS.cardBody, TEXTS.blocked, TEXTS.accountTaken]) {
        expect(plainTextOf(text)).toMatch(/напиши в поддержку: \/support$/);
      }
    });
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

  describe('the /account status', () => {
    const HOSTILE_ADDRESS = `<&>_*"`.repeat(43).slice(0, 254);
    const KINDS: readonly [string, LinkedAccountView][] = [
      ['active', { status: BrokerAccountStatus.Active, email: HOSTILE_ADDRESS }],
      [
        'pending',
        { status: BrokerAccountStatus.Pending, id: PENDING_ACCOUNT_ID, email: HOSTILE_ADDRESS },
      ],
      ['revoked', { status: BrokerAccountStatus.Revoked, email: HOSTILE_ADDRESS }],
    ];
    const lengthOf = (link: LinkedAccountView, count: number) =>
      plainTextOf(accountStatus(Array.from({ length: count }, () => link))).length;

    // the list bound is checked against the texts rather than assumed: at the bound the longest
    // message fits, and a list half as long again would not
    it.each(KINDS)(
      `keeps ${USER_ACCOUNT_LIST_LIMIT} %s links of 254-character addresses inside the limit`,
      (_kind, link) => {
        const links = Array.from({ length: USER_ACCOUNT_LIST_LIMIT }, () => link);
        expect(telegramTextProblems(accountStatus(links))).toEqual([]);
        expect(lengthOf(link, 16)).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT);
      },
    );

    it('puts the header, a blank line and one line per link, in the order given', () => {
      expect(accountStatus([LINK_ACTIVE]).value).toBe(
        `${TEXTS.accountConnected.value}\n\n${TEXTS.accountLineActive('ada@example.test').value}`,
      );
      expect(plainTextOf(accountStatus([LINK_PENDING, LINK_ACTIVE, LINK_REVOKED]))).toBe(
        [
          '✅ Аккаунт Binodex подключён',
          '',
          '⏳ Ждёт подтверждения: new@example.test',
          '✅ Подключён: ada@example.test',
          '⚠️ Подключение отозвано: old@example.test',
        ].join('\n'),
      );
    });

    it.each<[string, keyof typeof TEXTS, LinkedAccountView[]]>([
      ['active and pending', 'accountConnected', [LINK_PENDING, LINK_ACTIVE]],
      ['active and revoked', 'accountConnected', [LINK_REVOKED, LINK_ACTIVE]],
      ['pending and revoked', 'accountPending', [LINK_REVOKED, LINK_PENDING]],
      ['pending only', 'accountPending', [LINK_PENDING]],
      ['revoked only', 'accountRevoked', [LINK_REVOKED, LINK_REVOKED]],
    ])('heads %s with %s', (_label, header, links) => {
      const entry = TEXTS[header];
      if (typeof entry === 'function') throw new Error(`${header} is not a header`);
      expect(accountStatus(links).value.startsWith(`${entry.value}\n\n`)).toBe(true);
    });

    it('is the not-connected text for no link at all', () => {
      expect(accountStatus([])).toBe(TEXTS.accountNone);
    });

    it('says the address is unknown, escaped once, for a link without one', () => {
      const text = accountStatus([{ status: BrokerAccountStatus.Revoked, email: null }]);
      expect(plainTextOf(text)).toContain('⚠️ Подключение отозвано: адрес неизвестен');
      expect(text.value).toContain(TEXTS.accountUnknownAddress.value);
      expect(text.value).not.toContain('&amp;');
    });

    it('shows a hostile address as typed, escaped in the markup', () => {
      const text = accountStatus([{ status: BrokerAccountStatus.Active, email: HOSTILE_ADDRESS }]);
      expect(plainTextOf(text)).toContain(HOSTILE_ADDRESS);
      expect(telegramTextProblems(text)).toEqual([]);
    });
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

  describe('the bot profile', () => {
    // Bot API limits of setMyDescription and setMyShortDescription, counted in UTF-16 code units,
    // which is what String#length returns — the unit commands.test.ts counts in. A text over its
    // limit is refused at every start and the refusal is only a warn line, so it is caught here.
    const BOT_DESCRIPTION_LIMIT = 512;
    const BOT_SHORT_DESCRIPTION_LIMIT = 120;

    // an empty string is what removes the text on Telegram's side
    it.each([
      ['description', PROFILE.description, BOT_DESCRIPTION_LIMIT],
      ['shortDescription', PROFILE.shortDescription, BOT_SHORT_DESCRIPTION_LIMIT],
    ] as const)('keeps the %s non-empty, plain and inside its limit', (_key, text, limit) => {
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(limit);
      expect(text).not.toMatch(/[<>]|&(?:lt|gt|amp|quot|#\d+|#x[0-9a-f]+);/i);
    });

    it.each(Object.entries(PROFILE))(
      'starts every line of the %s with an emoji, and pads none',
      (_key, text) => {
        for (const line of text.split('\n').filter((entry) => entry !== '')) {
          expect(line).toMatch(/^\p{Extended_Pictographic}/u);
          expect(line).toBe(line.trim());
        }
      },
    );

    it('keeps the short description on one line', () => {
      expect(PROFILE.shortDescription).not.toContain('\n');
    });
  });
});
