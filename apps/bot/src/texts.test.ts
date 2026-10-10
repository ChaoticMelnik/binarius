import { afterEach, describe, expect, it } from 'vitest';
import {
  BOT_TEXT_CATALOG,
  BotTextGroup,
  BotTextKind,
  defaultBotTextSource,
  escapeTelegramHtml,
  type BotTextKey,
  type BotTextVarName,
  BrokerAccountStatus,
  decimalStringSchema,
  MODE_LABELS,
  parseBotTextTemplate,
  BrokerBalanceUnavailableReason,
  NotificationLevel,
  plainTextOf,
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
  USER_ACCOUNT_LIST_LIMIT,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
  type BrokerBalanceView,
  type DecimalString,
  type LinkBonusGrantView,
  type LinkedAccountView,
  type TelegramHtml,
  type TradingSessionView,
  DEMO_CALLBACK_DATA,
  SUPPORT_TELEGRAM_USERNAME,
  supportUrl,
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
  intentView,
  sessionView,
  SESSION_VIEW,
  stubText,
  stubTextSource,
} from './testing';
import { LEVEL_CURRENT_CALLBACK_DATA, levelCallbackData } from './bot';
import {
  DEMO_GROUPS_CALLBACK_DATA,
  demoAnalysisCallbackData,
  demoAssetCallbackData,
  demoDurationCallbackData,
  demoPageCallbackData,
} from './demo';
import { DEMO_ASSET_GROUPS, DEMO_DURATIONS_SEC } from './demo-catalog';
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
  INTENT_SYMBOL_LIMIT,
  intentStatusText,
  LABELS,
  levelLabel,
  PROFILE,
  pluralTrades,
  sessionStartButtonLabel,
  sessionStatusText,
  setBotTextSource,
  settingsText,
  stakeButtonLabel,
  statusCard,
  TEXTS,
  botCommands,
  type AccountCardInput,
  type StatusCardInput,
} from './texts';

const d = (value: string) => decimalStringSchema.parse(value);

// Every variable of `key` at a value: each one printed as given at `text`, the data ones at a
// valid value of their own.
const inputsOf = (text: string): Record<BotTextVarName, unknown> => ({
  firstName: text,
  email: text,
  tokens: '12',
  reservedTokens: '3',
  bonusTokens: text,
  demoBalance: { amount: d('10000'), fresh: true },
  realBalance: null,
  mode: TradeMode.Demo,
  level: NotificationLevel.All,
  stake: null,
  minStake: d('1'),
  demoAvailable: d('9990'),
  age: 75,
  amount: text,
  count: text,
  symbol: text,
  group: text,
  page: text,
  payout: text,
  breakEven: text,
  payoutFloor: text,
  label: text,
  subject: text,
  reason: text,
  value: text,
  price: text,
  seconds: text,
  line: text,
  assetId: text,
  digits: text,
  step: text,
  score: text,
  profit: d('-1.5'),
  result: text,
  trades: text,
  action: text,
  botUsername: text,
});
const contextOf = (key: string, text: string): Record<string, unknown> => {
  const inputs = inputsOf(text);
  const vars = BOT_TEXT_CATALOG[key as BotTextKey].vars as readonly BotTextVarName[];
  return Object.fromEntries(vars.map((name) => [name, inputs[name]]));
};
// a key's view, with its variables at `text` when it has any
const renderOf = (key: string, entry: unknown, text: string): TelegramHtml =>
  typeof entry === 'function'
    ? (entry as (context: unknown) => TelegramHtml)(contextOf(key, text))
    : (entry as TelegramHtml);

// Telegram parses none of these texts: markup or any entity — the four Telegram knows and any
// other named one alike — would be shown literally (#199)
const MARKUP_OR_ENTITY = /[<>]|&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;

describe('texts', () => {
  // the welcome travels as a caption whenever WELCOME_VIDEO_FILE_ID is set, and a caption over
  // the limit is refused by the Bot API — which would only show up once a video is configured
  it('keeps the welcome inside the caption limit', () => {
    expect(telegramTextProblems(TEXTS.welcome, TELEGRAM_CAPTION_LIMIT)).toEqual([]);
  });

  // A function is called with its text variables at 254 characters, RFC 5321's limit for an
  // address, made of every character that means something in HTML or Markdown. The wire schema
  // does not bound the email, so the length is a margin check, not a guarantee.
  const HOSTILE_ARGUMENT = `<&>_*"`.repeat(43).slice(0, 254);
  const HOSTILE_INPUTS = inputsOf(HOSTILE_ARGUMENT);

  it.each(Object.entries(TEXTS))(
    'keeps %s valid Telegram HTML, inside the limit, non-empty, with no padded line',
    (key, entry) => {
      expect(telegramTextProblems(renderOf(key, entry, HOSTILE_ARGUMENT))).toEqual([]);
    },
  );

  // the keys whose default prints a variable as it is given
  it.each(
    Object.entries(TEXTS).filter(
      ([key, entry]) =>
        typeof entry === 'function' &&
        parseBotTextTemplate(BOT_TEXT_CATALOG[key as BotTextKey].source).names.some(
          (name) => HOSTILE_INPUTS[name as BotTextVarName] === HOSTILE_ARGUMENT,
        ),
    ),
  )('shows what went into %s as it is, escaped in the markup', (key, entry) => {
    const text = renderOf(key, entry, HOSTILE_ARGUMENT);
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
        const text = plainTextOf(
          TEXTS.settings({ level: NotificationLevel.All, stake: null, firstName: 'Ada' }),
        );
        expect(text.split('\n').some((line) => line.startsWith(`${levelLabel(level)} — `))).toBe(
          true,
        );
      },
    );

    it('names the selected level in bold', () => {
      expect(settingsText(NotificationLevel.Reduced, null, 'Ada').value).toContain(
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
      expect(SUPPORT_TELEGRAM_USERNAME).toMatch(/^[A-Za-z0-9_]{5,32}$/);
      const url = new URL(supportUrl());
      expect(url.protocol).toBe('https:');
      expect(url.host).toBe('t.me');
      expect(url.pathname).toBe(`/${SUPPORT_TELEGRAM_USERNAME}`);
    });

    it('points every «напиши в поддержку» to /support', () => {
      for (const text of [
        TEXTS.cardBody({ firstName: 'Ada', email: null }),
        TEXTS.blocked,
        TEXTS.accountTaken,
        TEXTS.statusAmbiguous,
        TEXTS.intentManualReview,
        TEXTS.stakeAccountHalted,
      ]) {
        expect(plainTextOf(text)).toMatch(/напиши в поддержку: \/support$/);
      }
    });
  });

  it('names the connect button of the welcome and not the site sign-in', () => {
    expect(plainTextOf(TEXTS.welcome)).toContain(`«${LABELS.connectButton}»`);
    expect(plainTextOf(TEXTS.welcome)).not.toContain(LABELS.oauthButton);
  });

  it('names the resend button by its label where it tells the user to press it', () => {
    expect(
      plainTextOf(TEXTS.codeSentUnknown({ email: 'ada@example.test', firstName: 'Ada' })),
    ).toContain(`«${LABELS.resendButton}»`);
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
        `${TEXTS.accountConnected.value}\n\n${TEXTS.accountLineActive({ email: 'ada@example.test' }).value}`,
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
      expect(text.value).toContain(
        escapeTelegramHtml(BOT_TEXT_CATALOG.accountUnknownAddress.source),
      );
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
      const context = { firstName: 'Ada', email: 'ada@example.test' };
      expect(card.value).toBe(
        [
          `${TEXTS.cardGreeting(context).value}\n${TEXTS.cardEmail(context).value}`,
          TEXTS.cardBody(context).value,
          TEXTS.cardBonusGranted({ ...context, bonusTokens: '7' }).value,
        ].join('\n\n'),
      );
    });

    it('says why no pack was paid, and nothing about a pack when that is unknown', () => {
      const context = { firstName: 'Ada', email: null };
      const card = (grant: LinkBonusGrantView | null) =>
        plainTextOf(accountCard({ ...context, grant }));
      expect(card({ granted: false, reason: 'not_partner_client' })).toContain(
        plainTextOf(TEXTS.cardBonusNotPartner(context)),
      );
      expect(card({ granted: false, reason: 'already_granted' })).toContain(
        plainTextOf(TEXTS.cardBonusAlready(context)),
      );
      const unknown = card(null);
      expect(unknown).not.toMatch(/🎁|ℹ️/u);
      expect(unknown.endsWith(plainTextOf(TEXTS.cardBody(context)))).toBe(true);
    });

    // the Bot API guarantees a first name non-empty, not non-blank
    it('greets a blank name without it, and trims a padded one', () => {
      expect(TEXTS.cardGreeting({ firstName: '   ', email: null }).value).toBe('🎉 <b>Привет!</b>');
      expect(TEXTS.cardGreeting({ firstName: ' Ada ', email: null }).value).toBe(
        '🎉 <b>Привет, Ada!</b>',
      );
    });
  });

  describe('/help', () => {
    const lineOf = ({ command, description }: { command: string; description: string }) =>
      `/${command} — ${description}`;

    it('keeps the message valid Telegram HTML, inside the message limit', () => {
      expect(telegramTextProblems(helpText(botCommands()), TELEGRAM_MESSAGE_LIMIT)).toEqual([]);
    });

    it('is the three blocks one blank line apart, the command lines after the last', () => {
      const lines = botCommands()
        .map((entry) => `\n${lineOf(entry)}`)
        .join('');
      expect(helpText(botCommands()).value).toBe(
        [TEXTS.helpAbout.value, TEXTS.helpConnect.value, TEXTS.helpCommands.value + lines].join(
          '\n\n',
        ),
      );
    });

    // every command once, in the menu's order: a presence check would pass a duplicate
    it('lists exactly the commands of the menu, in its order', () => {
      const lines = plainTextOf(helpText(botCommands())).split('\n');
      const after = lines.slice(lines.indexOf(plainTextOf(TEXTS.helpCommands)) + 1);
      expect(after).toEqual(botCommands().map(lineOf));
    });

    it('reads the command descriptions from the source in place (#301)', () => {
      setBotTextSource(stubTextSource('supportCommand'));
      try {
        expect(botCommands().at(-1)).toEqual({
          command: 'support',
          description: stubText('supportCommand'),
        });
      } finally {
        setBotTextSource(defaultBotTextSource);
      }
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
        expect(
          plainTextOf(TEXTS.cardBody({ firstName: 'Ada', email: null })).split('\n'),
        ).toContain(line);
      }
    });

    it('names the connect button and not the site sign-in', () => {
      expect(plainTextOf(TEXTS.helpConnect)).toContain(`«${LABELS.connectButton}»`);
      expect(plainTextOf(TEXTS.helpConnect)).not.toContain(LABELS.oauthButton);
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

// #358: the registry's variables, filled from what the handler holds
describe('the variables of the texts', () => {
  afterEach(() => setBotTextSource(defaultBotTextSource));
  const withTexts = (texts: Partial<Record<BotTextKey, string>>) => {
    setBotTextSource({ sourceOf: (key) => texts[key] ?? defaultBotTextSource.sourceOf(key) });
  };
  const card = (broker: StatusCardInput['broker']) =>
    plainTextOf(
      statusCard({
        firstName: 'Ада',
        mode: TradeMode.Demo,
        tokens: { balance: '15', reserved: '3', available: '12' },
        broker,
        brokerUnavailable:
          broker === null ? BrokerBalanceUnavailableReason.BrokerUnavailable : null,
        demoStake: null,
      }),
    );
  const LINE = '{firstName}, у тебя {tokens} токенов и {demoBalance} на демо';

  it('B1 prints several variables of the status card at the user’s values', () => {
    withTexts({ statusTokens: LINE });
    expect(card(brokerBalance({ fresh: true }))).toContain(
      'Ада, у тебя 12 токенов и $10 000.00 на демо',
    );
  });

  it('B2 prints no number for a stale or a missing balance', () => {
    withTexts({ statusTokens: LINE });
    const stale = card(brokerBalance({ fresh: false, restSnapshotAgeSec: 400 }));
    expect(stale).toContain('Ада, у тебя 12 токенов и нет свежих данных на демо');
    expect(card(null)).toContain('Ада, у тебя 12 токенов и нет свежих данных на демо');
    withTexts({ statusTokens: LINE, balanceUnavailable: 'баланс обновляется' });
    expect(card(null)).toContain('и баланс обновляется на демо');
  });

  it('B4 stands in for an unknown address with the overridden text, escaped', () => {
    withTexts({ accountUnknownAddress: '<адрес?>' });
    expect(TEXTS.accountLineActive({ email: null }).value).toBe('✅ Подключён: &lt;адрес?&gt;');
  });

  it('B5 prints the name, the level and the stake, or the minimum, in /settings', () => {
    withTexts({ settings: '{firstName}: {level}, ставка {stake}' });
    const text = (stake: DecimalString | null) =>
      plainTextOf(settingsText(NotificationLevel.Off, stake, 'Ада')).split('\n')[0];
    expect(text(decimalStringSchema.parse('5'))).toBe('Ада: ❌ Выключить, ставка $5.00');
    expect(text(null)).toBe('Ада: ❌ Выключить, ставка минимальная ставка брокера');
  });

  it('B3 keeps the default card free of the new variables', () => {
    expect(card(brokerBalance({ fresh: true }))).toBe(
      [
        '🎮 Режим: DEMO',
        '',
        '💵 Реальный баланс: $0.00',
        '🧪 Демобаланс: $10 000.00',
        '🪙 Токены: 12 (в резерве: 3)',
        '',
        '💡 Автосессия: бот сам проводит серию демо-сделок — деньги не нужны.',
      ].join('\n'),
    );
  });
});

describe('the status card', () => {
  const card = (patch: Partial<StatusCardInput> = {}) =>
    statusCard({
      firstName: 'Ada',
      mode: TradeMode.Demo,
      tokens: ACCESS_VIEW.tokens,
      broker: ACCESS_VIEW.broker,
      brokerUnavailable: ACCESS_VIEW.brokerUnavailable,
      demoStake: null,
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
        '💡 Автосессия: бот сам проводит серию демо-сделок — деньги не нужны.',
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
    expect(plainTextOf(stale)).toContain(plainTextOf(TEXTS.statusStale({ age: 75 })));
    const restOnly = card({
      broker: brokerBalance({ restSnapshotAgeSec: 180, balanceEventAgeSec: null, fresh: false }),
    });
    expect(plainTextOf(restOnly)).toContain(plainTextOf(TEXTS.statusStale({ age: 180 })));
  });

  it.each(reasons)('says why there is no balance for %s', (reason) => {
    const plain = plainTextOf(noSnapshot(reason));
    const ambiguous = reason === BrokerBalanceUnavailableReason.AmbiguousAccount;
    expect(plain.includes(plainTextOf(TEXTS.statusAmbiguous))).toBe(ambiguous);
    const noSnapshotLine = plainTextOf(renderOf('statusNoSnapshot', TEXTS.statusNoSnapshot, ''));
    expect(plain.includes(noSnapshotLine)).toBe(!ambiguous);
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
    summary: demoSummary(HOSTILE_PAIR, 15),
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

  // #379: a pair screen that names the payout names the break-even share at it
  it.each([
    ['durations', screens.durations],
    ['summary', screens.summary],
  ])('names the break-even share once on the %s screen', (_name, text) => {
    expect(plainTextOf(text).split('Безубыточность: 50.0% верных прогнозов.')).toHaveLength(2);
  });

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
    expect(plainTextOf(demoSummary(PAIR_EURUSD, 15))).toBe(
      `🎯 Актив: EUR/USD OTC
⏱ Длительность: ⏱ 15 с
💰 Выплата: 85% — размер выигрыша при верном прогнозе, не вероятность. Безубыточность: 54.1% верных прогнозов.

Дальше — анализ свечей, а за ним кнопка автосессии: бот сам проведёт серию сделок по сигналу.`,
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
    expect(DEMO_DURATIONS_SEC.map((sec) => DEMO_DURATION_LABELS[sec])).toEqual(['⏱ 5 с', '⏱ 15 с']);
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
      demoDurationCallbackData(MAX_ID, 15),
      demoAnalysisCallbackData(MAX_ID, 15),
    ]) {
      expect(Buffer.byteLength(data, 'utf8'), data).toBeLessThanOrEqual(64);
    }
  });
});

// #126
describe('the analysis screen texts', () => {
  const HOSTILE = `<&>_*"`.repeat(11).slice(0, 64);
  const analysisEntries = Object.entries(TEXTS).filter(
    ([key]) => key.startsWith('analysis') || key === 'analyzing',
  );

  // the payout sentence is demoPayout's, outside these entries
  it.each(analysisEntries)(
    'calls the signal neither a probability nor an accuracy in %s',
    (_key, entry) => {
      const text = plainTextOf(renderOf(_key, entry, HOSTILE)).toLowerCase();
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

// #127
describe('the demo trade status', () => {
  const HOSTILE_SYMBOL = `<&>"`.repeat(20);
  const LIVE: TradeIntentStatus[] = [
    TradeIntentStatus.Planned,
    TradeIntentStatus.Reserved,
    TradeIntentStatus.Queued,
    TradeIntentStatus.Submitting,
    TradeIntentStatus.Unknown,
    TradeIntentStatus.Reconciling,
    TradeIntentStatus.ManualReview,
  ];
  const views = [
    ...Object.values(TradeIntentStatus)
      .filter((status) => status !== TradeIntentStatus.Rejected)
      .map((status) => intentView({ status })),
    ...[...Object.values(TradeIntentFailureReason), null].map((lastError) =>
      intentView({ status: TradeIntentStatus.Rejected, lastError }),
    ),
  ];

  it.each(views.map((view) => [view.status, view.lastError, view] as const))(
    'renders %s (%s) as valid Telegram HTML inside the limit with the widest holes',
    (_status, _reason, view) => {
      const widest = {
        ...view,
        durationSec: 2_147_483_647,
        amount: '999999999999.99999999' as DecimalString,
      };
      for (const tail of [{}, { deadline: true }, { sessionOffer: true }]) {
        const text = intentStatusText(HOSTILE_SYMBOL, widest, tail);
        expect(telegramTextProblems(text, TELEGRAM_MESSAGE_LIMIT)).toEqual([]);
      }
    },
  );

  // the acceptance criterion: the message never says the trade is open before the broker did
  it.each(Object.values(TradeIntentStatus))(
    'says «открыта» for %s only when it is accepted',
    (status) => {
      for (const lastError of [null, ...Object.values(TradeIntentFailureReason)]) {
        const plain = plainTextOf(intentStatusText('EUR/USD', intentView({ status, lastError })));
        // «не открыта» is a refusal, not a claim
        expect(/(?<!не )открыта/.test(plain)).toBe(status === TradeIntentStatus.Accepted);
      }
    },
  );

  it('prints the trade line from the view and the symbol escaped once', () => {
    const text = intentStatusText('EUR/<USD>', intentView());
    expect(plainTextOf(text)).toBe(
      [
        '🎮 Демо-сделка',
        '📈 EUR/<USD> · ⬆️ Вверх · ⏱ 15 с · ставка $1.00',
        '',
        '⏳ Заявка создана и ждёт отправки брокеру…',
      ].join('\n'),
    );
    expect(text.value).toContain('EUR/&lt;USD&gt;');
  });

  // #313: an intent created before the deploy keeps its duration, labelled by the fallback
  it('labels a duration outside the demo set by the fallback', () => {
    expect(plainTextOf(intentStatusText('EUR/USD', intentView({ durationSec: 60 })))).toContain(
      ' · ⏱ 60 с · ',
    );
  });

  it('caps the symbol and stands the asset id in for a missing one', () => {
    const long = 'S'.repeat(INTENT_SYMBOL_LIMIT + 10);
    expect(plainTextOf(intentStatusText(long, intentView()))).toContain(
      `📈 ${'S'.repeat(INTENT_SYMBOL_LIMIT)} · `,
    );
    expect(plainTextOf(intentStatusText(null, intentView({ assetId: 91 })))).toContain(
      '📈 актив #91 · ',
    );
  });

  it('prints a duration outside the demo table in seconds', () => {
    expect(plainTextOf(intentStatusText('X', intentView({ durationSec: 45 })))).toContain(
      ' · ⏱ 45 с · ',
    );
  });

  it('appends the deadline hint only when asked', () => {
    const hint = plainTextOf(TEXTS.intentDeadline);
    expect(plainTextOf(intentStatusText('X', intentView()))).not.toContain(hint);
    expect(
      plainTextOf(intentStatusText('X', intentView(), { deadline: true })).endsWith(`\n\n${hint}`),
    ).toBe(true);
    expect(hint).toContain(`«${LABELS.refreshIntentButton}»`);
  });

  // #360: the offer names the session its row starts, DEFAULT_SESSION_TRADES (5) trades
  it('appends the session offer only when asked, after a blank line', () => {
    const offer =
      '🤖 Дальше бот может торговать сам: сессия из 5 сделок на этой паре, сигнал он проверяет перед каждой сделкой.';
    const view = intentView({ status: TradeIntentStatus.Accepted });
    expect(plainTextOf(intentStatusText('X', view, { sessionOffer: true }))).toBe(
      [
        '🎮 Демо-сделка',
        '📈 X · ⬆️ Вверх · ⏱ 15 с · ставка $1.00',
        '',
        plainTextOf(TEXTS.intentAccepted),
        '',
        offer,
      ].join('\n'),
    );
    expect(plainTextOf(intentStatusText('X', view))).not.toContain('🤖');
    const withDeadline = plainTextOf(intentStatusText('X', view, { deadline: true }));
    expect(withDeadline).not.toContain('🤖');
    expect(withDeadline.endsWith(plainTextOf(TEXTS.intentDeadline))).toBe(true);
  });

  it('tells a trade the executor never took apart from a broker refusal', () => {
    const notConfigured = plainTextOf(
      intentStatusText(
        'X',
        intentView({
          status: TradeIntentStatus.Rejected,
          lastError: TradeIntentFailureReason.ExecutorNotConfigured,
        }),
      ),
    );
    expect(notConfigured).toContain('исполнение сделок ещё не подключено');
    const byBroker = plainTextOf(
      intentStatusText(
        'X',
        intentView({
          status: TradeIntentStatus.Rejected,
          lastError: TradeIntentFailureReason.BrokerRejected,
        }),
      ),
    );
    expect(byBroker).toContain('Брокер отклонил сделку');
    const paused = plainTextOf(
      intentStatusText(
        'X',
        intentView({
          status: TradeIntentStatus.Rejected,
          lastError: TradeIntentFailureReason.TradingPaused,
        }),
      ),
    );
    expect(paused).toContain(
      '⏸ Торговля временно приостановлена, попробуйте позже. Токен возвращён.',
    );
    const demoOnly = plainTextOf(
      intentStatusText(
        'X',
        intentView({
          status: TradeIntentStatus.Rejected,
          lastError: TradeIntentFailureReason.DemoOnly,
        }),
      ),
    );
    expect(demoOnly).toContain(
      '⚠️ Сделка отклонена: реальные сделки на этом сервере отключены. Токен возвращён.',
    );
  });

  it.each(LIVE)('keeps %s a live status, with no claim that the token came back', (status) => {
    expect(plainTextOf(intentStatusText('X', intentView({ status })))).not.toContain(
      'Токен возвращён',
    );
  });
});

// #284
describe('the demo session status', () => {
  const settled = (patch: Partial<typeof SESSION_VIEW.trades>) => ({
    ...SESSION_VIEW.trades,
    ...patch,
  });
  const stopped = (stopReason: TradingSessionStopReason, patch = {}) =>
    sessionView({
      status: TradingSessionStatus.Stopped,
      stopReason,
      endedAt: '2026-10-07T10:30:00.000Z',
      ...patch,
    });
  const plainOf = (...args: Parameters<typeof sessionStatusText>) =>
    plainTextOf(sessionStatusText(...args));

  it('T1 lays out a live session with its trade number, score with the result and the last trade', () => {
    const view = sessionView({
      trades: settled({ settled: 2, won: 1, lost: 1, profit: d('-0.5') }),
      lastIntent: intentView({ status: TradeIntentStatus.Accepted }),
    });
    expect(plainOf('EUR/USD OTC', view)).toBe(
      [
        '🎮 Демо-сессия',
        '📈 EUR/USD OTC · ⏱ 15 с · ставка $1.00',
        '🔢 Сделка 3 из 5',
        '📊 Счёт: 1 в плюс, 1 в минус · -$0.50',
        '',
        '✅ Сделка открыта у брокера.',
      ].join('\n'),
    );
  });

  it('waits for a signal while no trade is open, with no score before the first settle', () => {
    expect(plainOf('X', SESSION_VIEW)).toBe(
      [
        '🎮 Демо-сессия',
        '📈 X · ⏱ 15 с · ставка $1.00',
        '🔢 Сделка 1 из 5',
        '',
        '🔎 Ждём сигнал для следующей сделки…',
      ].join('\n'),
    );
    const afterSettle = sessionView({
      trades: settled({ settled: 1, won: 1 }),
      lastIntent: intentView({ status: TradeIntentStatus.Settled }),
    });
    expect(plainOf('X', afterSettle)).toContain('🔎 Ждём сигнал для следующей сделки…');
  });

  it('names a tie only when a trade tied', () => {
    const completed = (tied: number) =>
      stopped(TradingSessionStopReason.Completed, {
        trades: settled({ settled: 5, won: 3, lost: 2 - tied, tied }),
      });
    expect(plainOf('X', completed(0))).toContain(
      '🏁 Сессия завершена: 5 сделок — 3 в плюс, 2 в минус',
    );
    expect(plainOf('X', completed(0))).not.toContain('в ноль');
    expect(plainOf('X', completed(1))).toContain(
      '🏁 Сессия завершена: 5 сделок — 3 в плюс, 1 в минус, 1 в ноль',
    );
  });

  it("shows a stopped session's reason, its result, and an open trade that plays out", () => {
    const view = stopped(TradingSessionStopReason.UserStopped, {
      trades: settled({ settled: 2, won: 2, profit: d('1.7') }),
      lastIntent: intentView({ status: TradeIntentStatus.Accepted }),
    });
    expect(plainOf('X', view).split('\n').slice(3)).toEqual([
      '⏹ Сессия остановлена по твоей команде.',
      '📊 Итог: 2 сделки — 2 в плюс, 0 в минус',
      '💰 Результат: +$1.70',
      '✅ Сделка открыта у брокера.',
      '⏳ Открытая сделка доиграет до конца.',
    ]);
    const closed = stopped(TradingSessionStopReason.UserStopped, {
      lastIntent: intentView({ status: TradeIntentStatus.Settled }),
    });
    expect(plainOf('X', closed).split('\n').slice(3)).toEqual([
      '⏹ Сессия остановлена по твоей команде.',
    ]);
  });

  // #337: the result and the balance after the session, in the /menu card's words by mode
  // formatUsd groups the digits with a no-break space
  const nbsp = (text: string) => text.replace(/(\d) (\d)/g, '$1\u00a0$2');
  const finished = (patch: Partial<TradingSessionView> = {}) =>
    stopped(TradingSessionStopReason.Completed, {
      trades: settled({ settled: 5, won: 3, lost: 2, profit: d('2.5') }),
      lastIntent: intentView({ status: TradeIntentStatus.Settled }),
      balance: { available: d('10002.5'), ageSec: 0, current: true },
      ...patch,
    });

  it('T2 a completed demo session shows its result and the demo balance, with no age', () => {
    expect(plainOf('X', finished()).split('\n').slice(3)).toEqual([
      '🏁 Сессия завершена: 5 сделок — 3 в плюс, 2 в минус',
      '💰 Результат: +$2.50',
      nbsp('🧪 Демобаланс: $10 002.50'),
    ]);
  });

  it('T3 a balance read before the last trade carries its age', () => {
    const view = finished({ balance: { available: d('10002.5'), ageSec: 75, current: false } });
    expect(plainOf('X', view).split('\n').slice(-2)).toEqual([
      nbsp('🧪 Демобаланс: $10 002.50'),
      '🕒 Баланс Binodex обновлён 1 мин назад.',
    ]);
  });

  it('T4 an account without a snapshot shows the result only', () => {
    expect(
      plainOf('X', finished({ balance: null }))
        .split('\n')
        .slice(3),
    ).toEqual(['🏁 Сессия завершена: 5 сделок — 3 в плюс, 2 в минус', '💰 Результат: +$2.50']);
  });

  it('T5 a real session shows the real balance', () => {
    const text = plainOf('X', finished({ mode: TradeMode.Real }));
    expect(text).toContain(nbsp('💵 Реальный баланс: $10 002.50'));
    expect(text).not.toContain('Демобаланс');
  });

  it('T6 a session stopped before its first closed trade shows neither line', () => {
    const view = stopped(TradingSessionStopReason.RejectedTwice, {
      trades: settled({ settled: 0, rejected: 2 }),
      lastIntent: intentView({ status: TradeIntentStatus.Rejected }),
      balance: { available: d('10000'), ageSec: 75, current: false },
    });
    const text = plainOf('X', view);
    expect(text).not.toContain('Результат');
    expect(text).not.toContain('Демобаланс');
    expect(text).not.toContain('🕒');
  });

  it('T7 manual review shows the result and the stored balance with its age, no trade line', () => {
    const view = stopped(TradingSessionStopReason.ManualReview, {
      trades: settled({ settled: 2, won: 1, lost: 1, profit: d('-0.15') }),
      lastIntent: intentView({ status: TradeIntentStatus.ManualReview }),
      balance: { available: d('9999.85'), ageSec: 30, current: false },
    });
    expect(plainOf('X', view).split('\n').slice(3)).toEqual([
      '🛠 Сессия остановлена: нужна ручная проверка — напиши в поддержку: /support',
      '📊 Итог: 2 сделки — 1 в плюс, 1 в минус',
      '💰 Результат: -$0.15',
      nbsp('🧪 Демобаланс: $9 999.85'),
      '🕒 Баланс Binodex обновлён 30 с назад.',
    ]);
  });

  // the owner's wording for both sources of manual_review: a trade or the account (#284 clarify)
  it('asks for support on manual review', () => {
    expect(plainOf('X', stopped(TradingSessionStopReason.ManualReview))).toContain(
      '🛠 Сессия остановлена: нужна ручная проверка — напиши в поддержку: /support',
    );
  });

  // Review Major 1: stopped on manual review with the trade itself on review — the owner's one
  // text, no second /support line, no «доиграет», and no «ещё идёт» at the deadline.
  it.each([false, true])(
    'shows a session stopped with its trade on manual review as the one stop line (deadline %s)',
    (deadline) => {
      const view = stopped(TradingSessionStopReason.ManualReview, {
        lastIntent: intentView({ status: TradeIntentStatus.ManualReview }),
      });
      expect(plainOf('X', view, { deadline }).split('\n').slice(3)).toEqual([
        '🛠 Сессия остановлена: нужна ручная проверка — напиши в поддержку: /support',
      ]);
    },
  );

  it('names a trade on review under another stop reason, without saying it plays out', () => {
    const view = stopped(TradingSessionStopReason.UserStopped, {
      lastIntent: intentView({ status: TradeIntentStatus.ManualReview }),
    });
    expect(plainOf('X', view).split('\n').slice(3)).toEqual([
      '⏹ Сессия остановлена по твоей команде.',
      '🛠 Сделка на ручной проверке — напиши в поддержку: /support',
    ]);
  });

  it.each([TradeIntentStatus.Queued, TradeIntentStatus.Accepted, TradeIntentStatus.Unknown])(
    'says a %s trade of a stopped session plays out',
    (status) => {
      const view = stopped(TradingSessionStopReason.Timeout, {
        lastIntent: intentView({ status }),
      });
      expect(plainOf('X', view)).toContain('⏳ Открытая сделка доиграет до конца.');
    },
  );

  // every stopped path, completed included: the deadline hint says the session still runs
  it.each(Object.values(TradingSessionStopReason))(
    'adds no deadline hint to a session stopped by %s',
    (stopReason) => {
      for (const status of [TradeIntentStatus.Accepted, TradeIntentStatus.ManualReview]) {
        const view = stopped(stopReason, { lastIntent: intentView({ status }) });
        expect(plainOf('X', view, { deadline: true })).toBe(plainOf('X', view));
      }
    },
  );

  it('reads the switch refusal of the single trade for a session the kill switch stopped', () => {
    expect(plainOf('X', stopped(TradingSessionStopReason.KillSwitch))).toContain(
      plainTextOf(TEXTS.tradingPaused),
    );
  });

  it('says the settings are unreadable instead of throwing on a hand-written row', () => {
    expect(plainOf('X', sessionView({ settings: null }))).toBe(
      [
        '🎮 Демо-сессия',
        '',
        '⚠️ Настройки сессии не прочитаны — напиши в поддержку: /support',
      ].join('\n'),
    );
  });

  it('names the asset by its id without a symbol, and adds the deadline hint only when asked', () => {
    expect(plainOf(null, SESSION_VIEW)).toContain(
      `📈 актив #${String(SESSION_VIEW.settings?.assetId)} · `,
    );
    const hint = plainTextOf(TEXTS.sessionDeadline);
    expect(hint).toContain(`«${LABELS.sessionRefreshButton}»`);
    expect(plainOf('X', SESSION_VIEW)).not.toContain(hint);
    expect(plainOf('X', SESSION_VIEW, { deadline: true }).endsWith(`\n${hint}`)).toBe(true);
  });

  it.each(Object.values(TradingSessionStopReason))(
    'renders a session stopped by %s as valid Telegram HTML with the widest holes',
    (stopReason) => {
      const widest = stopped(stopReason, {
        settings: {
          ...SESSION_VIEW.settings,
          durationSec: 2_147_483_647,
          trades: 20,
          stake: { baseStake: '999999999999.99999999', stakeScale: 8 },
        },
        trades: {
          planned: 20,
          settled: 20,
          rejected: 20,
          won: 20,
          lost: 20,
          tied: 20,
          profit: d('-999999999999.99999999'),
        },
        balance: { available: d('999999999999.99999999'), ageSec: 2_147_483_647, current: false },
        lastIntent: intentView({ status: TradeIntentStatus.ManualReview }),
      });
      for (const deadline of [false, true]) {
        const text = sessionStatusText(`<&>"`.repeat(20), widest, { deadline });
        expect(telegramTextProblems(text, TELEGRAM_MESSAGE_LIMIT)).toEqual([]);
      }
    },
  );

  it('renders a live session with the longest rejected line as valid Telegram HTML', () => {
    const view = sessionView({
      trades: {
        planned: 20,
        settled: 19,
        rejected: 20,
        won: 19,
        lost: 0,
        tied: 0,
        profit: d('-999999999999.99999999'),
      },
      lastIntent: intentView({
        status: TradeIntentStatus.Rejected,
        lastError: TradeIntentFailureReason.ExecutorNotConfigured,
      }),
    });
    expect(
      telegramTextProblems(sessionStatusText('S'.repeat(100), view, { deadline: true })),
    ).toEqual([]);
  });

  it.each([
    [1, 'сделка'],
    [2, 'сделки'],
    [4, 'сделки'],
    [5, 'сделок'],
    [11, 'сделок'],
    [12, 'сделок'],
    [14, 'сделок'],
    [20, 'сделок'],
    [21, 'сделка'],
    [22, 'сделки'],
    [111, 'сделок'],
  ])('says %i %s', (count, word) => {
    expect(pluralTrades(count)).toBe(word);
  });

  // not in LABELS, so the LABELS-wide checks above do not see it
  it('labels the session button plain and emoji-led, with the number of trades', () => {
    const label = sessionStartButtonLabel(5);
    expect(label).toBe('🚀 Сессия из 5 сделок');
    expect(label).not.toMatch(MARKUP_OR_ENTITY);
    expect(label).toMatch(/^\p{Extended_Pictographic}/u);
  });
});

// TEXTS and LABELS are views of the catalog that keep the names they had before it (#240): a
// key added to them is a text or a label the bot never had under that name.
describe('the facades over the catalog', () => {
  it('gives TEXTS every html key of the catalog but the three it reaches through other entries and the reminders', () => {
    const htmlKeys = (Object.keys(BOT_TEXT_CATALOG) as BotTextKey[]).filter(
      (key) => BOT_TEXT_CATALOG[key].kind === BotTextKind.Html,
    );
    expect(Object.keys(TEXTS).sort()).toEqual(
      htmlKeys
        .filter((key) => !['cardGreetingNoName', 'featureLines', 'oauthLoginFailed'].includes(key))
        .filter((key) => BOT_TEXT_CATALOG[key].group !== BotTextGroup.Mailing)
        .sort(),
    );
  });

  it('gives LABELS the labels it had', () => {
    expect(Object.keys(LABELS).sort()).toEqual(
      [
        'analysisMoreButton',
        'backToListButton',
        'demoManualButton',
        'demoSignalsRefreshButton',
        'launchCycleButton',
        'sessionAgainButton',
        'stakeBackLaunchButton',
        'stakeChangeButton',
        'accountCommand',
        'changeEmailButton',
        'confirmButton',
        'connectButton',
        'demoAnalysisButton',
        'demoBackDurationsButton',
        'demoBackGroupsButton',
        'demoBackPairsButton',
        'demoButton',
        'demoNextButton',
        'demoPrevButton',
        'demoRetryButton',
        'helpCommand',
        'loginButton',
        'menuButton',
        'newAnalysisButton',
        'menuCommand',
        'oauthButton',
        'refreshIntentButton',
        'repeatAnalysisButton',
        'resendButton',
        'sessionRefreshButton',
        'sessionStopButton',
        'settingsCommand',
        'settingsStakeButton',
        'stakeBackAnalysisButton',
        'stakeBackButton',
        'stakeBackSettingsButton',
        'stakeCustomButton',
        'stakeMenuButton',
        'stakeResetButton',
        'startCommand',
        'stopCommand',
        'supportButton',
        'toSignalsButton',
        'supportCommand',
      ].sort(),
    );
  });
});

// Every map from a value to its text is read when a text is built, so a source swapped after the
// module loaded reaches it: one test per map that used to hold the texts themselves (#240).
describe('the text source', () => {
  afterEach(() => setBotTextSource(defaultBotTextSource));

  it('shows a live status line from the source in place', () => {
    setBotTextSource(stubTextSource('intentAccepted'));
    const text = intentStatusText('X', intentView({ status: TradeIntentStatus.Accepted }));
    expect(text.value).toContain(stubText('intentAccepted'));
  });

  it('shows a rejection line from the source in place', () => {
    setBotTextSource(stubTextSource('intentRejectedByBroker'));
    const text = intentStatusText(
      'X',
      intentView({
        status: TradeIntentStatus.Rejected,
        lastError: TradeIntentFailureReason.BrokerRejected,
      }),
    );
    expect(text.value).toContain(stubText('intentRejectedByBroker'));
  });

  it('shows a session stop line from the source in place', () => {
    setBotTextSource(stubTextSource('sessionStopTimeout'));
    const text = sessionStatusText(
      'X',
      sessionView({
        status: TradingSessionStatus.Stopped,
        stopReason: TradingSessionStopReason.Timeout,
        endedAt: '2026-10-07T11:00:00.000Z',
      }),
    );
    expect(text.value).toContain(stubText('sessionStopTimeout'));
  });

  it('labels a level from the source in place', () => {
    setBotTextSource(stubTextSource('levelAll'));
    expect(levelLabel(NotificationLevel.All)).toBe(stubText('levelAll'));
  });

  it('labels a direction from the source in place', () => {
    setBotTextSource(stubTextSource('actionUp'));
    expect(ACTION_LABELS[TradeAction.Up]).toBe(stubText('actionUp'));
  });

  it('labels an asset type from the source in place', () => {
    setBotTextSource(stubTextSource('demoGroupCurrency'));
    expect(DEMO_GROUP_LABELS.currency).toBe(stubText('demoGroupCurrency'));
  });

  it('labels a duration from the source in place', () => {
    setBotTextSource(stubTextSource('demoDuration15'));
    expect(DEMO_DURATION_LABELS[15]).toBe(stubText('demoDuration15'));
  });

  it('reads the profile from the source in place', () => {
    setBotTextSource(stubTextSource('profileDescription', 'profileShortDescription'));
    expect(PROFILE).toEqual({
      description: stubText('profileDescription'),
      shortDescription: stubText('profileShortDescription'),
    });
  });
});
