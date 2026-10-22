import { describe, expect, it } from 'vitest';
import {
  BotLanguage,
  FIRST_SESSION_CHAIN,
  NotificationKind,
  TOKEN_NUDGES,
  TradeMode,
  decimalStringSchema,
} from '@binarius/shared';
import { CLIENT_LABELS, CLIENT_TEXTS } from '../auth/texts';
import { inlineRows, inlineStyles } from '../admin/testing';
import { mailingMessage, type MailingContext } from './messages';

const CASHIER_URL = 'https://web.example/cashier';
const DEMO: MailingContext = {
  cashierUrl: CASHIER_URL,
  tradingMode: TradeMode.Demo,
  language: BotLanguage.Ru,
};

const buttonsOf = (message: ReturnType<typeof mailingMessage>) => inlineRows({ ...message }).flat();
const stylesOf = (message: ReturnType<typeof mailingMessage>) => inlineStyles({ ...message });

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
      expect(message.text).toBe(CLIENT_TEXTS.analysisUnusedReminder);
      expect(message.text.value).toContain(`«${CLIENT_LABELS.newAnalysisButton}»`);
      expect(buttonsOf(message)).toStrictEqual([
        { text: CLIENT_LABELS.newAnalysisButton, callback_data: data },
      ]);
      // #475: the reminder's step forward, green
      expect(stylesOf(message)).toEqual([['success']]);
    },
  );

  // the analysis screens' rule (#126): the signal is neither a probability nor an accuracy
  it('promises no result', () => {
    const text = CLIENT_TEXTS.analysisUnusedReminder.value.toLowerCase();
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
    expect(message.text).toStrictEqual(CLIENT_TEXTS.referralRewarded({ rewardTokens: '75' }));
    expect(message.text.value).toContain('+75');
    expect(message.text.value).toContain(`«${CLIENT_LABELS.inviteMoreButton}»`);
    expect(buttonsOf(message)).toStrictEqual([
      { text: CLIENT_LABELS.inviteMoreButton, callback_data: 'cmd:invite' },
    ]);
    expect(stylesOf(message)).toEqual([['primary']]);
  });

  it('promises no result', () => {
    const text = CLIENT_TEXTS.referralRewarded({ rewardTokens: '50' }).value.toLowerCase();
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
        { text: CLIENT_LABELS.demoButton, callback_data: 'demo' },
      ]);
    },
  );
});

// #123
describe('the low-token nudge messages', () => {
  const [HALF, LOW, OUT] = TOKEN_NUDGES;
  const demo = { text: CLIENT_LABELS.demoButton, callback_data: 'demo' };
  const trade = { text: CLIENT_LABELS.tradeButton, callback_data: 'demo' };
  const deposit = { text: CLIENT_LABELS.depositButton, web_app: { url: CASHIER_URL } };
  const buy = { text: CLIENT_LABELS.buyButton, callback_data: 'buy' };
  const rowsOf = (message: ReturnType<typeof mailingMessage>) => inlineRows({ ...message });
  const texts = {
    [NotificationKind.TokensHalf]: CLIENT_TEXTS.tokensHalfUsed,
    [NotificationKind.TokensLow]: CLIENT_TEXTS.tokensLow,
    [NotificationKind.TokensOut]: CLIENT_TEXTS.tokensOut,
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
      expect(text).not.toContain(CLIENT_LABELS.depositButton.toLowerCase());
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
      expect(text).toContain(`«${CLIENT_LABELS.buyButton}»`);
      for (const label of [CLIENT_LABELS.demoButton, CLIENT_LABELS.tradeButton]) {
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
    expect(text).toContain(`/settings → «${CLIENT_LABELS.settingsModeButton}»`);
    expect(buttonsOf(message)).toStrictEqual([
      { text: CLIENT_LABELS.settingsModeButton, callback_data: 'mode' },
      { text: CLIENT_LABELS.menuButton, callback_data: 'menu' },
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
