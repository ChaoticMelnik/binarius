import { describe, expect, it } from 'vitest';
import {
  BotLanguage,
  DEMO_TO_REAL_CHAIN,
  demoToRealText,
  FIRST_SESSION_CHAIN,
  helpLinksCaption,
  NotificationKind,
  TOKEN_NUDGES,
  TradeMode,
  decimalStringSchema,
} from '@binarius/shared';
import { botKeyboardProblems } from '@binarius/shared/testing';
import type { ClientPushMessage } from '../auth/client-push';
import { clientLabelsOf, clientTextsOf } from '../auth/texts';
import { inlineRows, inlineStyles } from '../admin/testing';
import type { HelpLinks } from './help-links';
import { mailingMessage as anyMessage, type MailingContext } from './messages';

// the Russian texts, the language of every user these tests make (#633)
const RU_TEXTS = clientTextsOf(BotLanguage.Ru);
const RU_LABELS = clientLabelsOf(BotLanguage.Ru);

const CASHIER_URL = 'https://web.example/cashier';
const HELP_LINKS: HelpLinks = {
  channelUrl: 'https://t.me/binarius_news',
  reviewsUrl: 'https://t.me/binarius_reviews',
  managerUrl: 'https://t.me/binarius_manager',
};
const DEMO: MailingContext = {
  cashierUrl: CASHIER_URL,
  helpLinks: HELP_LINKS,
  tradingMode: TradeMode.Demo,
  language: BotLanguage.Ru,
};

// a text kind's message: every kind but the help push, which sends a photo (#879)
const mailingMessage = (...args: Parameters<typeof anyMessage>): ClientPushMessage => {
  const message = anyMessage(...args);
  if ('photo' in message) throw new Error(`${args[0]} sends a photo`);
  return message;
};

type AnyMessage = ReturnType<typeof anyMessage>;
const buttonsOf = (message: AnyMessage) => inlineRows({ ...message }).flat();
const stylesOf = (message: AnyMessage) => inlineStyles({ ...message });
const textOf = (message: AnyMessage) => ('photo' in message ? message.caption : message.text);

// #484
describe('the analysis reminder message', () => {
  // a reminder queued before #685 with 15 s keeps its data: the bot's legacy handler reads it
  it.each([
    [5, 'demo:an:101:5'],
    [15, 'demo:an:101:15'],
  ])(
    'sends the catalog text with one button: a new analysis of the same pair (%i s)',
    (durationSec, data) => {
      const message = mailingMessage(
        NotificationKind.AnalysisUnused,
        { assetId: 101, durationSec },
        DEMO,
      );
      expect(message.text).toBe(RU_TEXTS.analysisUnusedReminder);
      expect(message.text.value).toContain(`«${RU_LABELS.newAnalysisButton}»`);
      expect(buttonsOf(message)).toStrictEqual([
        { text: RU_LABELS.newAnalysisButton, callback_data: data },
      ]);
      // #475: the reminder's step forward, green
      expect(stylesOf(message)).toEqual([['success']]);
    },
  );

  // the analysis screens' rule (#126): the signal is neither a probability nor an accuracy
  it('promises no result', () => {
    const text = RU_TEXTS.analysisUnusedReminder.value.toLowerCase();
    for (const word of ['вероятност', 'точност', 'гарант', 'прибыл']) {
      expect(text).not.toContain(word);
    }
  });

  it.each([
    {},
    { assetId: 0, durationSec: 15 },
    { assetId: 101 },
    { assetId: '101', durationSec: 15 },
  ])('throws on payload %j, which the sender settles as not built', (payload) => {
    expect(() => mailingMessage(NotificationKind.AnalysisUnused, payload, DEMO)).toThrow();
  });
});

// #576
describe('the referral reward message', () => {
  it('sends the catalog text with the ledger row’s amount and one button: the /invite screen', () => {
    const message = mailingMessage(NotificationKind.ReferralRewarded, { tokens: '75' }, DEMO);
    expect(message.text).toStrictEqual(RU_TEXTS.referralRewarded({ rewardTokens: '75' }));
    expect(message.text.value).toContain('+75');
    expect(message.text.value).toContain(`«${RU_LABELS.inviteMoreButton}»`);
    expect(buttonsOf(message)).toStrictEqual([
      { text: RU_LABELS.inviteMoreButton, callback_data: 'cmd:invite' },
    ]);
    expect(stylesOf(message)).toEqual([['primary']]);
  });

  it('promises no result', () => {
    const text = RU_TEXTS.referralRewarded({ rewardTokens: '50' }).value.toLowerCase();
    for (const word of ['вероятност', 'точност', 'гарант', 'прибыл']) {
      expect(text).not.toContain(word);
    }
  });

  it.each([
    {},
    { tokens: 50 },
    { tokens: '0' },
    { tokens: '-5' },
    { tokens: '1e3' },
    { tokens: '' },
    { tokens: '05' },
  ])('throws on payload %j, which the sender settles as not built', (payload) => {
    expect(() => mailingMessage(NotificationKind.ReferralRewarded, payload, DEMO)).toThrow();
  });
});

describe('the first-session chain messages', () => {
  it.each(FIRST_SESSION_CHAIN.map((step) => step.kind))(
    'sends %s with the demo button whatever the payload',
    (kind) => {
      expect(buttonsOf(mailingMessage(kind, {}, DEMO))).toStrictEqual([
        { text: RU_LABELS.demoButton, callback_data: 'demo' },
      ]);
    },
  );
});

// #123
describe('the low-token nudge messages', () => {
  const [HALF, LOW, OUT] = TOKEN_NUDGES;
  const demo = { text: RU_LABELS.demoButton, callback_data: 'demo' };
  const trade = { text: RU_LABELS.tradeButton, callback_data: 'demo' };
  const deposit = { text: RU_LABELS.depositButton, web_app: { url: CASHIER_URL } };
  const buy = { text: RU_LABELS.buyButton, callback_data: 'buy' };
  const rowsOf = (message: ReturnType<typeof mailingMessage>) => inlineRows({ ...message });
  const texts = {
    [NotificationKind.TokensHalf]: RU_TEXTS.tokensHalfUsed,
    [NotificationKind.TokensLow]: RU_TEXTS.tokensLow,
    [NotificationKind.TokensOut]: RU_TEXTS.tokensOut,
  };

  it.each([
    [HALF.kind, '50'],
    [LOW.kind, '20'],
    [OUT.kind, '0'],
  ])('sends %s with the catalog text at the payload’s threshold', (kind, tokens) => {
    const message = mailingMessage(kind, { tokens }, DEMO);
    expect(message.text).toStrictEqual(texts[kind]({ nudgeTokens: tokens }));
  });

  it('prints the threshold of the user’s own pack', () => {
    expect(mailingMessage(HALF.kind, { tokens: '37' }, DEMO).text.value).toContain('не больше 37');
    expect(mailingMessage(LOW.kind, { tokens: '15' }, DEMO).text.value).toContain('не больше 15');
  });

  // the acceptance of #123: the progress is the share of the package used, nothing else; and a
  // deposit credits no tokens (#386)
  it.each(TOKEN_NUDGES.map((nudge) => nudge.kind))(
    '%s promises no accuracy, learning or result',
    (kind) => {
      const text = texts[kind]({ nudgeTokens: '50' }).value.toLowerCase();
      for (const word of ['вероятност', 'точност', 'обуч', 'учится', 'модел', 'гарант', 'прибыл']) {
        expect(text).not.toContain(word);
      }
      expect(text).not.toContain(RU_LABELS.depositButton.toLowerCase());
    },
  );

  it('gives the 50 % nudge the entry button, labelled by the mode', () => {
    expect(rowsOf(mailingMessage(HALF.kind, { tokens: '50' }, DEMO))).toStrictEqual([[demo]]);
    expect(
      rowsOf(mailingMessage(HALF.kind, { tokens: '50' }, { ...DEMO, tradingMode: TradeMode.Real })),
    ).toStrictEqual([[trade]]);
  });

  it.each([LOW.kind, OUT.kind])('gives %s the cashier, then the purchase', (kind) => {
    expect(rowsOf(mailingMessage(kind, { tokens: '0' }, DEMO))).toStrictEqual([[deposit], [buy]]);
    // #475: the cashier green on its own row, the purchase blue, the one secondary button
    expect(stylesOf(mailingMessage(kind, { tokens: '0' }, DEMO))).toEqual([
      ['success'],
      ['primary'],
    ]);
    expect(
      rowsOf(mailingMessage(kind, { tokens: '0' }, { ...DEMO, tradingMode: TradeMode.Real })),
    ).toStrictEqual([[deposit], [buy]]);
  });

  it.each([LOW.kind, OUT.kind])(
    'gives %s the entry in the cashier’s place without https',
    (kind) => {
      const context = { ...DEMO, cashierUrl: undefined };
      expect(rowsOf(mailingMessage(kind, { tokens: '0' }, context))).toStrictEqual([[demo], [buy]]);
      expect(
        rowsOf(mailingMessage(kind, { tokens: '0' }, { ...context, tradingMode: TradeMode.Real })),
      ).toStrictEqual([[trade], [buy]]);
    },
  );

  it.each([LOW.kind, OUT.kind])(
    'names only the purchase, the row that is always there, in %s',
    (kind) => {
      const text = texts[kind]({ nudgeTokens: '20' }).value;
      expect(text).toContain(`«${RU_LABELS.buyButton}»`);
      for (const label of [RU_LABELS.demoButton, RU_LABELS.tradeButton]) {
        expect(text).not.toContain(label);
      }
    },
  );

  it.each(
    TOKEN_NUDGES.flatMap((nudge) =>
      [
        {},
        { tokens: 50 },
        { tokens: '-5' },
        { tokens: '1e3' },
        { tokens: '' },
        { tokens: '5.5' },
      ].map((payload) => [nudge.kind, payload] as const),
    ),
  )('%s throws on payload %j, which the sender settles as not built', (kind, payload) => {
    expect(() => mailingMessage(kind, payload, DEMO)).toThrow();
  });
});

// #686
describe('the real-mode message after a deposit', () => {
  const REAL: MailingContext = { ...DEMO, tradingMode: TradeMode.Real };
  const kind = NotificationKind.RealModeByDeposit;

  it('says the deposit came, the mode is REAL, the stake, and the way back to demo', () => {
    const message = mailingMessage(kind, { stake: '5.00000000' }, REAL);
    const text = message.text.value;
    expect(text).toContain('Пополнение получено');
    expect(text).toContain('REAL');
    expect(text).toContain('реальные деньги');
    expect(text).toContain('$5.00');
    expect(text).toContain(`/settings → «${RU_LABELS.settingsModeButton}»`);
    expect(buttonsOf(message)).toStrictEqual([
      { text: RU_LABELS.settingsModeButton, callback_data: 'mode' },
      { text: RU_LABELS.menuButton, callback_data: 'menu' },
    ]);
    // one row of two navigation buttons, no colour
    expect(stylesOf(message)).toEqual([[null, null]]);
  });

  it('names the broker minimum in words without a stake', () => {
    expect(mailingMessage(kind, { stake: null }, REAL).text.value).toContain(
      'минимальная ставка брокера',
    );
    expect(
      mailingMessage(kind, { stake: null }, { ...REAL, language: BotLanguage.En }).text.value,
    ).toContain("broker's minimum stake");
  });

  it('speaks the user’s language, the text and both labels', () => {
    const message = mailingMessage(
      kind,
      { stake: '5.00000000' },
      { ...REAL, language: BotLanguage.En },
    );
    expect(message.text.value).toContain('Deposit received');
    expect(message.text.value).toContain('$5.00');
    expect(buttonsOf(message)).toStrictEqual([
      { text: '⚙️ Trading mode', callback_data: 'mode' },
      { text: '🏠 Menu', callback_data: 'menu' },
    ]);
  });

  it('promises no result', () => {
    for (const language of Object.values(BotLanguage)) {
      const stake = decimalStringSchema.parse('5');
      const text = mailingMessage(kind, { stake }, { ...REAL, language }).text.value.toLowerCase();
      for (const word of ['вероятност', 'точност', 'гарант', 'прибыл', 'profit', 'guarantee']) {
        expect(text).not.toContain(word);
      }
    }
  });

  it.each([{}, { stake: 'x' }, { stake: 5 }, { stake: '' }])(
    'throws on payload %j, which the sender settles as not built',
    (payload) => {
      expect(() => mailingMessage(kind, payload, REAL)).toThrow();
    },
  );
});

// #880: the chain's payload as the planner writes it, and a deposit_bonus version's params
const DEMO_TO_REAL_PAYLOAD = {
  sessions: 3,
  settled: 12,
  won: 6,
  lost: 6,
  tied: 0,
  profit: '-1.50000000',
  bonus: null,
};
const DEMO_TO_REAL_BONUS = {
  tokensPerUsd: '0.50000000',
  minAmountUsd: '10.00000000',
  maxTokens: '500.00000000',
};
const CHAIN_KINDS: NotificationKind[] = DEMO_TO_REAL_CHAIN.map((step) => step.kind);

// an age in digits or in words, which a late push must not name (docs/mailing.md → Late planning)
const AGES = [
  /\d\s*(мин|час|дн|сут|недел|мес)/u,
  /(?<![а-яё])(сут[ко]|вчера|позавчера|назад)/u,
  /(?<![а-яё])(одн|один|два|две|двое|двух|три|трое|трёх|трех|четыр|пят|шест|сем|несколь)[а-яё]*\s+(минут|час|дн|дня|дней|сут|недел|месяц)/u,
];
const namesAnAge = (text: string) => AGES.some((age) => age.test(text.toLowerCase()));

// #124 (docs/mailing.md → Retention)
describe('the retention messages', () => {
  const demo = { text: RU_LABELS.demoButton, callback_data: 'demo' };
  const deposit = { text: RU_LABELS.depositButton, web_app: { url: CASHIER_URL } };
  const buy = { text: RU_LABELS.buyButton, callback_data: 'buy' };
  const rowsOf = (message: ReturnType<typeof mailingMessage>) => inlineRows({ ...message });
  const score = { settled: 4, won: 2, lost: 1, tied: 1 };
  const idle = { assetId: 101, durationSec: 5, ...score };

  it('RM1 sends the last session’s result and «🔁 Запустить снова», the cycle door of its pair', () => {
    const message = mailingMessage(NotificationKind.SessionIdle24h, idle, DEMO);
    expect(message.text).toStrictEqual(
      RU_TEXTS.sessionIdleReminder({ result: '4 сделки — 2 в плюс, 1 в минус, 1 в ноль' }),
    );
    expect(rowsOf(message)).toStrictEqual([
      [{ text: '🔁 Запустить снова', callback_data: 'demo:l:101:5:n' }],
    ]);
    expect(stylesOf(message)).toEqual([['success']]);
  });

  it('RM2 gives the entry in its place when the session’s settings named no pair', () => {
    expect(
      rowsOf(mailingMessage(NotificationKind.SessionIdle24h, { ...idle, assetId: null }, DEMO)),
    ).toStrictEqual([[demo]]);
  });

  it.each([
    [NotificationKind.Inactive3d, {}, RU_TEXTS.inactiveReminder],
    [
      NotificationKind.WeeklySummary,
      score,
      RU_TEXTS.weeklySummary({ result: '4 сделки — 2 в плюс, 1 в минус, 1 в ноль' }),
    ],
  ] as const)('RM3 sends %s with the catalog text and the entry', (kind, payload, text) => {
    const message = mailingMessage(kind, payload, DEMO);
    expect(message.text).toStrictEqual(text);
    expect(message.text.value).toContain(`«${RU_LABELS.demoButton}»`);
    expect(rowsOf(message)).toStrictEqual([[demo]]);
    expect(stylesOf(message)).toEqual([['success']]);
  });

  it('RM4 gives tokens_out_2d the cashier, then the purchase; the entry in the cashier’s place without https', () => {
    const kind = NotificationKind.TokensOut2d;
    const message = mailingMessage(kind, {}, DEMO);
    expect(message.text).toStrictEqual(RU_TEXTS.tokensOutStill);
    expect(message.text.value).toContain(`«${RU_LABELS.buyButton}»`);
    expect(rowsOf(message)).toStrictEqual([[deposit], [buy]]);
    expect(stylesOf(message)).toEqual([['success'], ['primary']]);
    expect(rowsOf(mailingMessage(kind, {}, { ...DEMO, cashierUrl: undefined }))).toStrictEqual([
      [demo],
      [buy],
    ]);
  });

  // a push may be planned late (docs/mailing.md → Retention → Late planning), so no text names an
  // age; counts only, so no money; and no promise of a result (#123's words)
  it.each([
    [NotificationKind.Inactive3d, {}],
    [NotificationKind.SessionIdle24h, idle],
    [NotificationKind.WeeklySummary, score],
    [NotificationKind.TokensOut2d, {}],
  ] as const)('RM5 %s names no age, no money and promises no result', (kind, payload) => {
    const text = mailingMessage(kind, payload, DEMO).text.value.toLowerCase();
    for (const word of ['вероятност', 'точност', 'обуч', 'учится', 'модел', 'гарант', 'прибыл']) {
      expect(text).not.toContain(word);
    }
    expect(text).not.toContain('$');
    expect(namesAnAge(text)).toBe(false);
  });

  it('RM5a the age guard catches ages in digits and in words, and not the summarised week', () => {
    const ages = ['3 дня', '72 часа', 'сутки', 'двое суток', 'три дня', 'несколько дней'];
    for (const age of [...ages, 'неделю назад', 'вчера']) {
      expect([age, namesAnAge(age)]).toEqual([age, true]);
    }
    for (const fine of ['демо-итоги прошлой недели', 'рынок не спит', 'пятница']) {
      expect([fine, namesAnAge(fine)]).toEqual([fine, false]);
    }
  });

  it('RM7 heads the weekly result with «Итог», not a second «Сделки»', () => {
    const text = mailingMessage(NotificationKind.WeeklySummary, score, DEMO).text.value;
    expect(text).toContain('📊 Итог: 4 сделки — 2 в плюс, 1 в минус, 1 в ноль.');
  });

  it.each([
    [NotificationKind.SessionIdle24h, {}],
    [NotificationKind.SessionIdle24h, { ...idle, settled: -1 }],
    [NotificationKind.SessionIdle24h, { ...idle, won: 1.5 }],
    [NotificationKind.SessionIdle24h, { ...idle, assetId: 0 }],
    [NotificationKind.SessionIdle24h, { ...idle, durationSec: '5' }],
    [NotificationKind.WeeklySummary, {}],
    [NotificationKind.WeeklySummary, { ...score, tied: '1' }],
  ] as const)(
    'RM6 %s throws on payload %j, which the sender settles as not built',
    (kind, payload) => {
      expect(() => mailingMessage(kind, payload, DEMO)).toThrow();
    },
  );
});

// #633: every kind in the user's language, its text and every label of its keyboard
describe('the mailings in English (#633)', () => {
  const CYRILLIC = /[А-Яа-яЁё]/u;
  const score = { settled: 4, won: 2, lost: 1, tied: 1 };
  // one valid payload per kind: a kind added without one does not compile
  const PAYLOADS: Record<NotificationKind, Record<string, unknown>> = {
    [NotificationKind.FirstSession1h]: {},
    [NotificationKind.FirstSession24h]: {},
    [NotificationKind.FirstSession72h]: {},
    [NotificationKind.AnalysisUnused]: { assetId: 101, durationSec: 5 },
    [NotificationKind.ReferralRewarded]: { tokens: '75' },
    [NotificationKind.TokensHalf]: { tokens: '50' },
    [NotificationKind.TokensLow]: { tokens: '20' },
    [NotificationKind.TokensOut]: { tokens: '0' },
    [NotificationKind.RealModeByDeposit]: { stake: '5.00000000' },
    [NotificationKind.Inactive3d]: {},
    [NotificationKind.SessionIdle24h]: { assetId: 101, durationSec: 5, ...score },
    [NotificationKind.WeeklySummary]: score,
    [NotificationKind.TokensOut2d]: {},
    [NotificationKind.HelpLinks]: {},
    [NotificationKind.DemoToReal1h]: DEMO_TO_REAL_PAYLOAD,
    [NotificationKind.DemoToReal24h]: DEMO_TO_REAL_PAYLOAD,
    [NotificationKind.DemoToReal72h]: { ...DEMO_TO_REAL_PAYLOAD, bonus: DEMO_TO_REAL_BONUS },
  };
  const contexts = Object.values(TradeMode).flatMap((tradingMode) =>
    [CASHIER_URL, undefined].map((cashierUrl): MailingContext => ({
      cashierUrl,
      helpLinks: HELP_LINKS,
      tradingMode,
      language: BotLanguage.En,
    })),
  );

  it.each(Object.values(NotificationKind))('M-lang %s has no Russian word', (kind) => {
    for (const context of contexts) {
      // the chain has no message without the cashier (DM5)
      if (context.cashierUrl === undefined && CHAIN_KINDS.includes(kind)) continue;
      const message = anyMessage(kind, PAYLOADS[kind], context);
      const labels = buttonsOf(message).map((button) => button.text);
      expect(labels.length).toBeGreaterThan(0);
      for (const text of [textOf(message).value, ...labels]) expect(text).not.toMatch(CYRILLIC);
    }
  });

  it('M-lang the result of a session is counted in English', () => {
    const message = mailingMessage(NotificationKind.WeeklySummary, score, {
      ...DEMO,
      language: BotLanguage.En,
    });
    expect(message.text.value).toContain('4 trades — 2 won, 1 lost, 1 tied');
  });
});

// #879 (docs/mailing.md → The help push)
describe('the help push message', () => {
  const kind = NotificationKind.HelpLinks;
  const channel = { text: RU_LABELS.helpChannelButton, url: HELP_LINKS.channelUrl };
  const reviews = { text: RU_LABELS.helpReviewsButton, url: HELP_LINKS.reviewsUrl };
  const manager = { text: RU_LABELS.managerButton, url: HELP_LINKS.managerUrl };
  const withLinks = (patch: Partial<HelpLinks>): MailingContext => ({
    ...DEMO,
    helpLinks: { ...HELP_LINKS, ...patch },
  });
  const photoOf = (context: MailingContext) => {
    const message = anyMessage(kind, {}, context);
    if (!('photo' in message)) throw new Error('the help push sends a photo');
    return message;
  };
  const rowsOf = (context: MailingContext) => inlineRows({ ...photoOf(context) });
  const linesOf = (context: MailingContext) => photoOf(context).caption.value.split('\n');

  it('HM1 sends the banner, the caption of every link, the channel and the reviews in a row and the manager under them', () => {
    const message = photoOf(DEMO);
    expect(message.photo).toBe('help_banner');
    expect(message.caption).toStrictEqual(
      helpLinksCaption(RU_TEXTS, { channel: true, reviews: true, manager: true }),
    );
    expect(rowsOf(DEMO)).toStrictEqual([[channel, reviews], [manager]]);
    // #475: the two navigation buttons without colour, the manager green on its own row
    expect(stylesOf(message)).toEqual([[null, null], ['success']]);
  });

  it('HM2 a channel that is not set has neither its line nor its button', () => {
    const context = withLinks({ channelUrl: undefined });
    expect(rowsOf(context)).toStrictEqual([[reviews], [manager]]);
    expect(photoOf(context).caption.value).not.toContain(RU_LABELS.helpChannelButton);
    expect(photoOf(context).caption).toStrictEqual(
      helpLinksCaption(RU_TEXTS, { channel: false, reviews: true, manager: true }),
    );
  });

  it('HM3 a manager that is not set has neither its line nor its button', () => {
    const context = withLinks({ managerUrl: undefined });
    expect(rowsOf(context)).toStrictEqual([[channel, reviews]]);
    expect(photoOf(context).caption.value).not.toContain(RU_LABELS.managerButton);
  });

  it('HM4 the manager alone: one line and one button', () => {
    const context = withLinks({ channelUrl: undefined, reviewsUrl: undefined });
    expect(rowsOf(context)).toStrictEqual([[manager]]);
    expect(linesOf(context).at(-1)).toBe(
      '💬 «💬 Написать менеджеру» — вопрос про счёт, пополнение или вывод.',
    );
  });

  it('HM5 names no age, no money and promises no result, in either language', () => {
    for (const language of Object.values(BotLanguage)) {
      const text = photoOf({ ...DEMO, language }).caption.value.toLowerCase();
      for (const word of ['вероятност', 'точност', 'гарант', 'прибыл', 'profit', 'guarantee']) {
        expect(text).not.toContain(word);
      }
      expect(text).not.toContain('$');
      expect(text).not.toMatch(/\d/u);
      expect(namesAnAge(text)).toBe(false);
    }
  });

  it('HM6 every combination of the links lays out a keyboard the role rules accept', () => {
    const urls = [HELP_LINKS.channelUrl, undefined];
    for (const channelUrl of urls) {
      for (const reviewsUrl of [HELP_LINKS.reviewsUrl, undefined]) {
        for (const managerUrl of [HELP_LINKS.managerUrl, undefined]) {
          if (channelUrl === undefined && reviewsUrl === undefined && managerUrl === undefined) {
            continue;
          }
          for (const language of Object.values(BotLanguage)) {
            const context = { ...withLinks({ channelUrl, reviewsUrl, managerUrl }), language };
            expect(botKeyboardProblems(photoOf(context).reply_markup)).toEqual([]);
          }
        }
      }
    }
  });

  it('HM7 throws without a single link, which the sender settles as not built', () => {
    expect(() =>
      anyMessage(
        kind,
        {},
        withLinks({ channelUrl: undefined, reviewsUrl: undefined, managerUrl: undefined }),
      ),
    ).toThrow('the help push has no link');
  });
});

// #880 (docs/mailing.md → The demo-to-real chain)
describe('the demo-to-real chain messages', () => {
  const [STEP_1H, STEP_24H, STEP_72H] = DEMO_TO_REAL_CHAIN;
  const deposit = { text: RU_LABELS.depositButton, web_app: { url: CASHIER_URL } };
  const manager = { text: RU_LABELS.managerButton, url: HELP_LINKS.managerUrl };
  const photoOf = (payload: Record<string, unknown> = DEMO_TO_REAL_PAYLOAD, context = DEMO) => {
    const message = anyMessage(STEP_1H!.kind, payload, context);
    if (!('photo' in message)) throw new Error('the 1 h step sends a photo');
    return message;
  };
  const linesOf = (kind: NotificationKind, payload: Record<string, unknown>, context = DEMO) =>
    textOf(anyMessage(kind, payload, context)).value.split('\n');

  it('DM1 the 1 h step is the banner with the text as its caption, the cashier and the manager on green rows', () => {
    const message = photoOf();
    expect(message.photo).toBe('demo_to_real_banner');
    expect(message.caption).toStrictEqual(
      demoToRealText(
        { html: RU_TEXTS, plain: RU_LABELS, language: BotLanguage.Ru },
        {
          intro: 'demoToRealIntro1h',
          facts: {
            sessions: 3,
            settled: 12,
            won: 6,
            lost: 6,
            tied: 0,
            profit: decimalStringSchema.parse('-1.50000000'),
          },
          bonus: null,
        },
      ),
    );
    expect(inlineRows({ ...message })).toStrictEqual([[deposit], [manager]]);
    expect(stylesOf(message)).toEqual([['success'], ['success']]);
  });

  it('DM2 the demo result is printed with its sign, a loss as a minus', () => {
    expect(linesOf(STEP_1H!.kind, DEMO_TO_REAL_PAYLOAD)[4]).toBe(
      '📊 Твоё демо: 3 демо-сессии, 12 сделок — 6 в плюс, 6 в минус, результат -$1.50.',
    );
    expect(linesOf(STEP_24H!.kind, { ...DEMO_TO_REAL_PAYLOAD, profit: '2.00000000' })[4]).toContain(
      'результат +$2.00.',
    );
  });

  it('DM3 the bonus line is the payload’s rule params, and a minimum of zero has no «from»', () => {
    expect(linesOf(STEP_72H!.kind, { ...DEMO_TO_REAL_PAYLOAD, bonus: DEMO_TO_REAL_BONUS })[5]).toBe(
      '🎁 Токены за пополнение: 0.5 за каждый $1 при сумме от $10.00, не больше 500 за одно пополнение.',
    );
    expect(
      linesOf(STEP_72H!.kind, {
        ...DEMO_TO_REAL_PAYLOAD,
        bonus: { ...DEMO_TO_REAL_BONUS, minAmountUsd: '0.00000000' },
      })[5],
    ).toBe('🎁 Токены за пополнение: 0.5 за каждый $1, не больше 500 за одно пополнение.');
    expect(linesOf(STEP_72H!.kind, DEMO_TO_REAL_PAYLOAD).join('\n')).not.toContain('🎁');
  });

  it('DM4 without the manager’s contact the cashier is the one button', () => {
    const context = { ...DEMO, helpLinks: { ...HELP_LINKS, managerUrl: undefined } };
    for (const step of DEMO_TO_REAL_CHAIN) {
      expect(inlineRows({ ...anyMessage(step.kind, DEMO_TO_REAL_PAYLOAD, context) })).toStrictEqual(
        [[deposit]],
      );
    }
  });

  it('DM5 throws without the cashier, which the sender settles as not built', () => {
    for (const step of DEMO_TO_REAL_CHAIN) {
      expect(() =>
        anyMessage(step.kind, DEMO_TO_REAL_PAYLOAD, { ...DEMO, cashierUrl: undefined }),
      ).toThrow('the demo-to-real chain has no cashier');
    }
  });

  it('DM6 the 24 h and 72 h steps are text with their own intro and a keyboard the role rules accept', () => {
    for (const [step, title] of [
      [STEP_24H!, '💳 <b>Реальный счёт: напоминание</b>'],
      [STEP_72H!, '📌 <b>Ещё раз о реальном счёте</b>'],
    ] as const) {
      const message = mailingMessage(step.kind, DEMO_TO_REAL_PAYLOAD, DEMO);
      expect(message.text.value.split('\n')[0]).toBe(title);
      expect(inlineRows({ ...message })).toStrictEqual([[deposit], [manager]]);
    }
    for (const step of DEMO_TO_REAL_CHAIN) {
      for (const language of Object.values(BotLanguage)) {
        const message = anyMessage(step.kind, DEMO_TO_REAL_PAYLOAD, { ...DEMO, language });
        expect(botKeyboardProblems(message.reply_markup)).toEqual([]);
      }
    }
  });

  // the owner's limits on the texts (#880): no age, no deadline, no claim about the user, a risk
  // line
  it('DM7 names no age or deadline, claims nothing about the user, and has the risk line, in either language', () => {
    const URGENCY = [
      'успе',
      'осталось',
      'не будет ждать',
      'сегодня',
      'последн',
      'hurry',
      'last chance',
      'expires',
    ];
    const CLAIMS = [
      'калибровк',
      'топ',
      'прогресс',
      'готов',
      'освоил',
      'научил',
      'навык',
      'гарант',
      'прибыл',
      'точност',
      'вероятност',
      'profit',
      'guarantee',
      'calibrat',
      'hang of',
      'master',
      'skill',
      'learned',
      'ready',
    ];
    for (const step of DEMO_TO_REAL_CHAIN) {
      for (const language of Object.values(BotLanguage)) {
        for (const bonus of [null, DEMO_TO_REAL_BONUS]) {
          const lines = linesOf(
            step.kind,
            { ...DEMO_TO_REAL_PAYLOAD, bonus },
            { ...DEMO, language },
          );
          const text = lines.join('\n').toLowerCase();
          for (const word of [...URGENCY, ...CLAIMS])
            expect([word, text.includes(word)]).toEqual([word, false]);
          // «top 5 %», not «top up»
          expect(text).not.toMatch(/\btop \d/u);
          expect(namesAnAge(text)).toBe(false);
          expect(lines.at(-2)).toBe(clientTextsOf(language).demoToRealRisk.value);
          expect(text).toContain('-$1.50');
        }
      }
    }
  });

  it.each([
    {},
    { ...DEMO_TO_REAL_PAYLOAD, profit: -1.5 },
    { ...DEMO_TO_REAL_PAYLOAD, sessions: '3' },
    { ...DEMO_TO_REAL_PAYLOAD, bonus: { ...DEMO_TO_REAL_BONUS, extra: '1' } },
    { ...DEMO_TO_REAL_PAYLOAD, bonus: { ...DEMO_TO_REAL_BONUS, maxTokens: 500 } },
  ])('DM8 throws on payload %j, which the sender settles as not built', (payload) => {
    expect(() => anyMessage(STEP_1H!.kind, payload, DEMO)).toThrow();
  });
});
