import { describe, expect, it } from 'vitest';
import {
  BrokerAccountStatus,
  BrokerBalanceUnavailableReason,
  NotificationLevel,
  plainTextOf,
  TradeAction,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
  USER_ACCOUNT_LIST_LIMIT,
  TradeMode,
  type BrokerBalanceView,
  type LinkBonusGrantView,
  type LinkedAccountView,
} from '@binarius/shared';
import { telegramTextProblems } from '@binarius/shared/testing';
import {
  ACCESS_VIEW,
  LINK_ACTIVE,
  LINK_PENDING,
  LINK_REVOKED,
  PAIR_EURUSD,
  PENDING_ACCOUNT_ID,
  brokerBalance,
} from './testing';
import { LEVEL_CURRENT_CALLBACK_DATA, levelCallbackData } from './bot';
import {
  DEMO_CALLBACK_DATA,
  DEMO_GROUPS_CALLBACK_DATA,
  demoAnalysisCallbackData,
  demoAssetCallbackData,
  demoDurationCallbackData,
  demoPageCallbackData,
} from './demo';
import { DEMO_ASSET_GROUPS, DEMO_DURATIONS_SEC } from './demo-catalog';
import { BOT_COMMANDS } from './commands';
import {
  ACTION_LABELS,
  accountCard,
  accountStatus,
  currentLevelLabel,
  DEMO_DURATION_LABELS,
  DEMO_GROUP_LABELS,
  demoDurationsScreen,
  demoPairsScreen,
  demoSummary,
  groupButtonLabel,
  pairButtonLabel,
  helpText,
  LABELS,
  levelLabel,
  MODE_LABELS,
  modeHeader,
  PROFILE,
  settingsText,
  stakeButtonLabel,
  SUPPORT,
  supportUrl,
  statusCard,
  TEXTS,
  type AccountCardInput,
  type StatusCardInput,
} from './texts';

// Telegram parses none of these texts: markup or any entity — the four Telegram knows and any
// other named one alike — would be shown literally (#199)
const MARKUP_OR_ENTITY = /[<>]|&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;

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
    expect(label).not.toMatch(MARKUP_OR_ENTITY);
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
        'Сейчас выбрано: <b>🔕 Реже</b>',
      );
    });

    it('maps each level to its label, and marks the selected one', () => {
      // the labels the owner approved verbatim (2026-10-03)
      expect(Object.values(NotificationLevel).map(levelLabel)).toEqual([
        '🔔 Все',
        '🔕 Реже',
        '❌ Выключить',
      ]);
      expect(currentLevelLabel(NotificationLevel.Off)).toBe('❌ Выключить ✅');
    });

    // the level buttons are not in LABELS, so the LABELS-wide checks above do not see them
    it.each(
      Object.values(NotificationLevel).flatMap((level) => [
        levelLabel(level),
        currentLevelLabel(level),
      ]),
    )('keeps the level button %s plain, non-empty and starting with an emoji', (label) => {
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).not.toMatch(MARKUP_OR_ENTITY);
      expect(label).toMatch(/^\p{Extended_Pictographic}/u);
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
      for (const text of [
        TEXTS.cardBody,
        TEXTS.blocked,
        TEXTS.accountTaken,
        TEXTS.statusAmbiguous,
      ]) {
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

  describe('/help', () => {
    const lineOf = ({ command, description }: { command: string; description: string }) =>
      `/${command} — ${description}`;

    it('keeps the message valid Telegram HTML, inside the message limit', () => {
      expect(telegramTextProblems(helpText(BOT_COMMANDS), TELEGRAM_MESSAGE_LIMIT)).toEqual([]);
    });

    it('is the three blocks one blank line apart, the command lines after the last', () => {
      const lines = BOT_COMMANDS.map((entry) => `\n${lineOf(entry)}`).join('');
      expect(helpText(BOT_COMMANDS).value).toBe(
        [TEXTS.helpAbout.value, TEXTS.helpConnect.value, TEXTS.helpCommands.value + lines].join(
          '\n\n',
        ),
      );
    });

    // every command once, in the menu's order: a presence check would pass a duplicate
    it('lists exactly the commands of the menu, in its order', () => {
      const lines = plainTextOf(helpText(BOT_COMMANDS)).split('\n');
      const after = lines.slice(lines.indexOf(plainTextOf(TEXTS.helpCommands)) + 1);
      expect(after).toEqual(BOT_COMMANDS.map(lineOf));
    });

    it('shows a command and its description as they are, escaped in the markup', () => {
      const text = helpText([{ command: HOSTILE_ARGUMENT, description: HOSTILE_ARGUMENT }]);
      const escaped = HOSTILE_ARGUMENT.replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
      expect(telegramTextProblems(text, TELEGRAM_MESSAGE_LIMIT)).toEqual([]);
      expect(plainTextOf(text)).toContain(`/${HOSTILE_ARGUMENT} — ${HOSTILE_ARGUMENT}`);
      expect(text.value).toContain(`/${escaped} — ${escaped}`);
    });

    it("describes the bot with the account card's feature lines", () => {
      const [, ...features] = plainTextOf(TEXTS.helpAbout).split('\n');
      expect(features).toHaveLength(3);
      for (const line of features) {
        expect(plainTextOf(TEXTS.cardBody).split('\n')).toContain(line);
      }
    });

    it('names both ways to connect by their button labels', () => {
      expect(plainTextOf(TEXTS.helpConnect)).toContain(`«${LABELS.connectButton}»`);
      expect(plainTextOf(TEXTS.helpConnect)).toContain(`«${LABELS.oauthButton}»`);
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
      expect(text).not.toMatch(MARKUP_OR_ENTITY);
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

describe('the status card', () => {
  const card = (patch: Partial<StatusCardInput> = {}) =>
    statusCard({
      mode: TradeMode.Demo,
      tokens: ACCESS_VIEW.tokens,
      broker: ACCESS_VIEW.broker,
      brokerUnavailable: ACCESS_VIEW.brokerUnavailable,
      ...patch,
    });
  const noSnapshot = (reason: BrokerBalanceUnavailableReason) =>
    card({ broker: null, brokerUnavailable: reason });
  const BIG = '123456789012.12345678';
  const widest = (patch: Partial<BrokerBalanceView>): BrokerBalanceView =>
    brokerBalance({
      real: { available: BIG, held: BIG, total: BIG },
      demo: { available: BIG, held: BIG, total: BIG },
      ...patch,
    } as Partial<BrokerBalanceView>);
  const COUNT = '9'.repeat(19);
  const reasons = Object.values(BrokerBalanceUnavailableReason).filter(
    (reason) => reason !== BrokerBalanceUnavailableReason.NoAccount,
  );
  const variants = [
    ['a fresh snapshot', widest({})],
    ['a stale snapshot', widest({ restSnapshotAgeSec: 2_147_483_647, fresh: false })],
    ...reasons.map((reason) => [reason, null] as const),
  ] as const;
  const tokenCases = [
    ['nothing reserved', { balance: COUNT, reserved: '0', available: COUNT }],
    ['some reserved', { balance: COUNT, reserved: COUNT, available: COUNT }],
  ] as const;

  describe.each(variants)('with %s', (label, broker) => {
    it.each(tokenCases)(
      'is valid Telegram HTML inside the caption limit with %s and every hole at its widest',
      (_tokensLabel, tokens) => {
        const text = card({
          tokens,
          broker,
          brokerUnavailable: broker === null ? (label as BrokerBalanceUnavailableReason) : null,
        });
        expect(telegramTextProblems(text, TELEGRAM_CAPTION_LIMIT)).toEqual([]);
        // nothing empty after a colon
        for (const line of plainTextOf(text).split('\n')) expect(line).not.toMatch(/:$/);
      },
    );
  });

  it('lays out the header, the three lines, the hint', () => {
    expect(plainTextOf(card())).toBe(
      [
        '🎮 Режим: DEMO',
        '',
        '💵 Реальный баланс: $0.00',
        '🧪 Демобаланс: $10\u00a0000.00',
        '🪙 Токены: 5',
        '',
        '💡 Демо без риска — деньги не нужны.',
      ].join('\n'),
    );
  });

  // the acceptance criterion: no real balance is 0, never an empty value or an error
  it.each([
    ['no snapshot', noSnapshot(BrokerBalanceUnavailableReason.BrokerUnavailable)],
    ['a zero real balance', card()],
  ])('prints $0.00 as the real balance with %s', (_label, text) => {
    expect(plainTextOf(text)).toMatch(/^💵 Реальный баланс: \$0\.00$/m);
  });

  it('prints both amounts as $0.00 when there is no snapshot', () => {
    const plain = plainTextOf(noSnapshot(BrokerBalanceUnavailableReason.Refreshing));
    expect(plain).toMatch(/^🧪 Демобаланс: \$0\.00$/m);
  });

  it('shows the available amounts, not the totals', () => {
    const plain = plainTextOf(
      card({
        broker: brokerBalance({
          real: { available: '12.5', held: '3', total: '15.5' },
          demo: { available: '9998.5', held: '1.5', total: '10000' },
        } as Partial<BrokerBalanceView>),
      }),
    );
    expect(plain).toMatch(/^💵 Реальный баланс: \$12\.50$/m);
    expect(plain).toMatch(/^🧪 Демобаланс: \$9\u00a0998\.50$/m);
  });

  it('adds the age line exactly when the snapshot is not fresh, with the newer age', () => {
    expect(plainTextOf(card())).not.toContain('🕒');
    const stale = card({
      broker: brokerBalance({ restSnapshotAgeSec: 400, balanceEventAgeSec: 75, fresh: false }),
    });
    expect(plainTextOf(stale)).toContain(plainTextOf(TEXTS.statusStale('1 мин')));
    const restOnly = card({
      broker: brokerBalance({ restSnapshotAgeSec: 180, balanceEventAgeSec: null, fresh: false }),
    });
    expect(plainTextOf(restOnly)).toContain(plainTextOf(TEXTS.statusStale('3 мин')));
  });

  it.each(reasons)('says why there is no balance for %s', (reason) => {
    const plain = plainTextOf(noSnapshot(reason));
    const ambiguous = reason === BrokerBalanceUnavailableReason.AmbiguousAccount;
    expect(plain.includes(plainTextOf(TEXTS.statusAmbiguous))).toBe(ambiguous);
    expect(plain.includes(plainTextOf(TEXTS.statusNoSnapshot))).toBe(!ambiguous);
    expect(plain).not.toContain('🕒');
  });

  it('shows the reserve only when some tokens are reserved', () => {
    expect(plainTextOf(card())).toMatch(/^🪙 Токены: 5$/m);
    const reserved = card({ tokens: { balance: '1005', reserved: '1000', available: '5' } });
    expect(plainTextOf(reserved)).toMatch(/^🪙 Токены: 5 \(в резерве: 1\u00a0000\)$/m);
    const zeros = card({ tokens: { balance: '5', reserved: '000', available: '5' } });
    expect(plainTextOf(zeros)).not.toContain('резерв');
  });

  it('labels both trade modes', () => {
    expect(MODE_LABELS).toEqual({ demo: 'DEMO', real: 'REAL' });
    expect(plainTextOf(modeHeader(TradeMode.Real))).toBe('🎮 Режим: REAL');
    expect(plainTextOf(card({ mode: TradeMode.Real }))).toMatch(/^🎮 Режим: REAL$/m);
  });

  it('keeps the demo button data inside the Bot API 64 bytes', () => {
    expect(Buffer.byteLength(DEMO_CALLBACK_DATA, 'utf8')).toBeLessThanOrEqual(64);
  });
});

// #125
describe('the demo screens', () => {
  // the longest a hole gets: a 64-character symbol of every character that means something in
  // HTML or Markdown, a three-digit payout, a four-digit page count, the longest type label
  const SYMBOL = `<&>_*"`.repeat(11).slice(0, 64);
  const HOSTILE_PAIR = { ...PAIR_EURUSD, symbol: SYMBOL, payout: 100 };
  const PAYOUT_SENTENCE = 'при верном прогнозе, не вероятность';
  const screens = {
    pairs: demoPairsScreen('cryptocurrency', 9998, 9999),
    durations: demoDurationsScreen(HOSTILE_PAIR),
    summary: demoSummary(HOSTILE_PAIR, 3600),
  };

  it.each(Object.entries(screens))(
    'keeps the %s screen valid Telegram HTML, inside the message limit',
    (_name, text) => {
      expect(telegramTextProblems(text, TELEGRAM_MESSAGE_LIMIT)).toEqual([]);
    },
  );

  it.each(Object.entries(screens))(
    'says once what the payout is on the %s screen',
    (_name, text) => {
      expect(plainTextOf(text).split(PAYOUT_SENTENCE)).toHaveLength(2);
    },
  );

  it('shows the symbol as the broker spells it, escaped once in the markup', () => {
    for (const text of [screens.durations, screens.summary]) {
      expect(plainTextOf(text)).toContain(SYMBOL);
      expect(text.value).not.toContain('&amp;amp;');
    }
  });

  it('lays out the pairs screen: the header with the type, then the page', () => {
    expect(plainTextOf(demoPairsScreen('currency', 1, 4))).toBe(
      `🎮 Демо-сделка · 💱 Валюты
Выбери актив. Число на кнопке — выплата при верном прогнозе, не вероятность.
Страница 2 из 4`,
    );
  });

  it('lays out the summary: the asset, the duration, the payout, then what comes next', () => {
    expect(plainTextOf(demoSummary(PAIR_EURUSD, 300))).toBe(
      `🎯 Актив: EUR/USD OTC
⏱ Длительность: ⏱ 5 мин
💰 Выплата: 85% — размер выигрыша при верном прогнозе, не вероятность.

Дальше — анализ: бот посмотрит на свечи и скажет, есть ли сигнал.`,
    );
  });

  it('names the groups and the durations by the approved labels', () => {
    expect(DEMO_ASSET_GROUPS.map((group) => DEMO_GROUP_LABELS[group])).toEqual([
      '💱 Валюты',
      '🛢 Сырьё',
      '📈 Акции',
      '💠 Криптовалюты',
      '📊 Индексы',
      '📁 Другие',
    ]);
    expect(DEMO_DURATIONS_SEC.map((sec) => DEMO_DURATION_LABELS[sec])).toEqual([
      '⏱ 1 мин',
      '⏱ 5 мин',
      '⏱ 15 мин',
      '⏱ 30 мин',
      '⏱ 1 ч',
    ]);
    expect(groupButtonLabel('currency', 46)).toBe('💱 Валюты · 46');
    expect(pairButtonLabel('EUR/USD OTC', 85)).toBe('EUR/USD OTC · 85%');
  });

  // these buttons are not in LABELS, so the LABELS-wide checks above do not see them
  it.each([
    ...DEMO_ASSET_GROUPS.map((group) => groupButtonLabel(group, 0)),
    ...DEMO_DURATIONS_SEC.map((sec) => DEMO_DURATION_LABELS[sec]),
  ])('keeps the demo button %s plain, non-empty and starting with an emoji', (label) => {
    expect(label.trim().length).toBeGreaterThan(0);
    expect(label).not.toMatch(MARKUP_OR_ENTITY);
    expect(label).toMatch(/^\p{Extended_Pictographic}/u);
  });

  it('keeps a pair button plain: a data label with no emoji', () => {
    const label = pairButtonLabel(PAIR_EURUSD.symbol, PAIR_EURUSD.payout);
    expect(label).not.toMatch(MARKUP_OR_ENTITY);
    expect(label).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('keeps the longest data of every demo button inside the Bot API 64 bytes', () => {
    const MAX_ID = 2_147_483_647;
    for (const data of [
      DEMO_CALLBACK_DATA,
      DEMO_GROUPS_CALLBACK_DATA,
      demoPageCallbackData('cryptocurrency', 9999),
      demoAssetCallbackData(MAX_ID),
      demoDurationCallbackData(MAX_ID, 3600),
      demoAnalysisCallbackData(MAX_ID, 3600),
    ]) {
      expect(Buffer.byteLength(data, 'utf8'), data).toBeLessThanOrEqual(64);
    }
  });
});

// #126
describe('the analysis screen texts', () => {
  const HOSTILE = `<&>_*"`.repeat(11).slice(0, 64);
  const analysisEntries = Object.entries(TEXTS).filter(
    ([key]) => key.startsWith('analysis') || key === 'analyzing' || key === 'stakeSoon',
  );

  // the payout sentence is demoPayout's, outside these entries
  it.each(analysisEntries)(
    'calls the signal neither a probability nor an accuracy in %s',
    (_key, entry) => {
      const text = plainTextOf(typeof entry === 'function' ? entry(HOSTILE) : entry).toLowerCase();
      expect(text).not.toContain('вероятност');
      expect(text).not.toContain('точност');
    },
  );

  it('names every trade direction', () => {
    expect(Object.keys(ACTION_LABELS).sort()).toEqual(Object.values(TradeAction).sort());
  });

  // not in LABELS, so the LABELS-wide checks above do not see it
  it.each(Object.values(TradeAction))(
    'keeps the stake button for %s plain and emoji-led',
    (action) => {
      const label = stakeButtonLabel(action);
      expect(label).toBe(`🚀 Открыть сделку: ${ACTION_LABELS[action]}`);
      expect(label).not.toMatch(MARKUP_OR_ENTITY);
      expect(label).toMatch(/^\p{Extended_Pictographic}/u);
    },
  );
});
