import { USER_ACCOUNT_LIST_LIMIT } from './account';
import { BOT_COMMANDS } from './bot-commands';
import { REFERRAL_CODE_LENGTH, REFERRAL_PAYLOAD_PREFIX } from './referral';
import { MIN_CYCLE_PAYOUT_PCT, PAIR_LABEL_MAX_LENGTH } from './catalog';
import { BotTextKind, type BotTextSource } from './bot-text-template';
import {
  BOT_TEXT_CATALOG,
  createBotTexts,
  type BotHtmlKey,
  type BotPlainKey,
  type BotTextKey,
} from './bot-texts';
import type { BotTextVarName } from './bot-text-vars';
import { plainTextOf, TELEGRAM_CAPTION_LIMIT, TELEGRAM_MESSAGE_LIMIT } from './telegram-html';
import { STARS_PAYSUPPORT_LIST_LIMIT } from './stars';
import { INT4_MAX } from './trading';
import {
  DEFAULT_SESSION_CYCLES,
  MAX_SESSION_CYCLES,
  SESSION_NO_SIGNAL_TIMEOUT_MS,
} from './trading-session';

// The messages the client bot assembles from several catalog keys (docs/bot-texts.md → Assembled
// messages). A key's own limit is checked with its variables' samples; these descriptions bound
// what the key limit cannot: a caption or a message made of many keys, and a variable that can be
// far wider than its sample. The bot's test (apps/bot/src/bot-text-messages.test.ts) holds every
// description equal to the real assembly on the defaults.

type Catalog = typeof BOT_TEXT_CATALOG;
export type BotHtmlVarKey = {
  [K in BotHtmlKey]: [keyof Catalog[K]['variables']] extends [never] ? never : K;
}[BotHtmlKey];

// The widest value each variable can take. A bound named after a schema is enforced there; the
// rest are stated assumptions (docs/bot-texts.md → Assembled messages → Assumptions).
export const BOT_TEXT_WIDTHS = {
  // Telegram's first_name, 1-64 characters
  firstName: 64,
  // emailAddressSchema; a broker's address is assumed no longer (RFC 5321)
  email: 254,
  // formatUsd over numeric(20,8): -$999 999 999 999.99
  usd: 20,
  // formatSignedUsd over numeric(20,8), every fraction digit: -$999 999 999 999.99999999 (#450)
  signedUsd: 26,
  // formatUsd('0'), both amounts of a card with no balance
  zeroUsd: 5,
  // formatStake over an unsigned numeric(20,8): $999 999 999 999.99999999 — either saved stake, the
  // broker's minimum and either balance are all money() columns their writers keep unsigned (#297,
  // #326)
  stake: 25,
  // the broker's stake scale: at most numeric(20,8)'s 8 fraction digits
  stakeDigits: 1,
  // formatCount over a bigint: 9 223 372 036 854 775 807
  count: 25,
  // a bigint printed as it arrives: the link bonus
  rawCount: 19,
  // formatAge: up to 99999 мин
  age: 9,
  // MODE_LABELS: DEMO, REAL
  mode: 4,
  // the pair's label (pairLabel): the symbol cut to PAIR_SYMBOL_LIMIT, then " OTC"
  symbol: PAIR_LABEL_MAX_LENGTH,
  payout: 6,
  // formatBreakEven: 0.0-100.0, or a dash
  breakEven: 5,
  payoutFloor: String(MIN_CYCLE_PAYOUT_PCT).length,
  noSignalMinutes: String(SESSION_NO_SIGNAL_TIMEOUT_MS / 60_000).length,
  // «999 из 999»
  page: 10,
  // formatPaymentDate: 'dd.mm.yyyy hh:mm'
  paymentDate: 16,
  // a Stars amount: int4, formatCount over INT4_MAX (star_payments.total_amount)
  starAmount: String(INT4_MAX).length + Math.floor((String(INT4_MAX).length - 1) / 3),
  // /paysupport's list (#118)
  paysupportLines: STARS_PAYSUPPORT_LIST_LIMIT,
  retryAfterSec: 5,
  assetId: 10,
  // formatPrice: |x| < 1e9 with up to 10 digits after the point, and a sign
  price: 21,
  // String(double), a trade's price when the catalog could not give the pair's digits: 17
  // significant digits, a sign, a point and an exponent (-1.2345678901234567e-308)
  rawPrice: 24,
  // formatRsi on 0-100
  rsi: 5,
  // formatAtrPct
  atrPct: 9,
  // formatAtrTicks
  atrTicks: 11,
  // a signal parameter's period, and the count of closed candles
  period: 4,
  candles: 5,
  // durationLabelOf's fallback on an int4 duration: ⏱ 2147483647 с
  durationFallback: 14,
  // the /account lines: POST /users/account answers at most this many links
  accountLines: USER_ACCOUNT_LIST_LIMIT,
  // a session's counters: a session holds at most MAX_SESSION_SUMMARY_TRADES (720) trades
  sessionCount: 3,
  // a Telegram username, 5-32 characters (stated: Telegram's rule, not a schema of ours)
  botUsername: 32,
} as const;

export interface BotTextMeasure {
  // the length after entities parsing of `key`'s text, each variable in it as wide as `widths`
  // says, or as its width for this key (BOT_TEXT_VAR_WIDTHS, then the default)
  length(key: BotTextKey, widths?: Partial<Record<BotTextVarName, number>>): number;
  longest(...keys: BotTextKey[]): number;
}

export type BotTextWidth = (m: BotTextMeasure) => number;

const w = BOT_TEXT_WIDTHS;
const durations = ['demoDuration5', 'demoDuration15'] as const satisfies readonly BotPlainKey[];
const groups = [
  'demoGroupCurrency',
  'demoGroupCommodity',
  'demoGroupStock',
  'demoGroupCryptocurrency',
  'demoGroupIndex',
  'demoGroupOther',
] as const satisfies readonly BotPlainKey[];
// a refusal by a rule carries the features, one for want of data does not (analysis.ts)
const ruleReasons = [
  'noSignalVolatilityTooLow',
  'noSignalVolatilityTooHigh',
  'noSignalVolatilityBelowTickFloor',
  'noSignalTrendFlat',
  'noSignalRsiNeutral',
  'noSignalTrendMomentumDisagree',
  'noSignalRsiOverbought',
  'noSignalRsiOversold',
] as const satisfies readonly BotPlainKey[];
const dataReasons = [
  'noSignalInsufficientCandles',
  'noSignalCandleGap',
  'noSignalStale',
  'noSignalInvalidCandle',
] as const satisfies readonly BotPlainKey[];
const SEPARATOR = ' · '.length;
const DASH = ' — '.length;

const subject = (m: BotTextMeasure) => w.symbol + SEPARATOR + m.longest(...durations);
const address = (m: BotTextMeasure) => Math.max(w.email, m.length('accountUnknownAddress'));
// `${word} — EMA9 1.08542 above EMA21 1.08511` and the like (analysis.ts → featureLines)
const indicator = (value: number) => 'EMA'.length + w.period + 1 + value;
const tradeLine = (m: BotTextMeasure, action: number) =>
  Math.max(w.symbol, m.length('intentAssetFallback')) +
  SEPARATOR +
  action +
  Math.max(m.longest(...durations), w.durationFallback) +
  SEPARATOR +
  m.length('intentStake');
const stakeLabel = (m: BotTextMeasure) => Math.max(w.stake, m.length('stakeMinimumLabel'));
// «3 в плюс, 1 в минус, 1 в ноль»
const score = (m: BotTextMeasure) =>
  m.length('sessionWon') +
  ', '.length +
  m.length('sessionLost') +
  ', '.length +
  m.length('sessionTied');
// «5 сделок — 3 в плюс, 2 в минус»
const result = (m: BotTextMeasure) =>
  w.sessionCount +
  1 +
  m.longest('sessionTradeOne', 'sessionTradeFew', 'sessionTradeMany') +
  DASH +
  score(m);
// `${word} — ATR14 0.041% · 8.4 шага котировки` (analysis.ts → featureLines)
const volatility = (m: BotTextMeasure, word: number) =>
  word + DASH + indicator(w.atrPct + '%'.length) + SEPARATOR + m.length('analysisAtrTicks');

const trades = (m: BotTextMeasure) =>
  m.longest('sessionTradeOne', 'sessionTradeFew', 'sessionTradeMany');
const cycles = (m: BotTextMeasure) =>
  m.longest('sessionCycleOne', 'sessionCycleFew', 'sessionCycleMany');
// a balance prints a number only when fresh, its stand-in otherwise (bot-text-vars.ts)
const balance = (m: BotTextMeasure) => Math.max(w.usd, m.length('balanceUnavailable'));

// Each variable's widest value wherever it stands; a variable without one does not compile.
export const BOT_TEXT_VAR_DEFAULT_WIDTHS: Readonly<Record<BotTextVarName, BotTextWidth>> = {
  firstName: () => w.firstName,
  email: address,
  tokens: () => w.count,
  reservedTokens: () => w.count,
  bonusTokens: () => w.rawCount,
  purchasedTokens: () => w.count,
  tokenBalance: () => w.count,
  stars: () => w.count,
  paymentDate: () => w.paymentDate,
  demoBalance: balance,
  realBalance: balance,
  mode: () => w.mode,
  level: (m) => m.longest('levelAll', 'levelReduced', 'levelOff'),
  // the saved stake, or the minimum's label (texts.ts → stakeLabel)
  stake: stakeLabel,
  minStake: () => w.stake,
  demoAvailable: () => w.stake,
  realAvailable: () => w.stake,
  age: () => w.age,
  // stakePickerText: the saved stake, or «label (minimum)»
  amount: (m) =>
    Math.max(w.stake, m.length('stakeMinimumLabel') + ' ('.length + w.stake + ')'.length),
  count: () => w.count,
  // a display indicator's closed candles (signal.ts), as `closedCandles`
  required: () => w.candles,
  symbol: () => w.symbol,
  group: (m) => m.longest(...groups),
  page: () => w.page,
  payout: () => w.payout,
  breakEven: () => w.breakEven,
  payoutFloor: () => w.payoutFloor,
  noSignalMinutes: () => w.noSignalMinutes,
  // a session's duration in seconds, an int4 (texts.ts → sessionStatusText), and « с»
  duration: () => String(INT4_MAX).length + ' с'.length,
  label: (m) => m.longest(...durations),
  subject,
  reason: (m) => m.longest(...ruleReasons, ...dataReasons),
  value: (m) =>
    m.longest('trendUp', 'trendDown', 'trendFlat') +
    DASH +
    indicator(w.price) +
    1 +
    m.longest('emaAbove', 'emaBelow', 'emaEqual') +
    1 +
    indicator(w.price),
  price: () => w.price,
  seconds: () => w.retryAfterSec,
  // a cycle's number in its session: under fixed every trade is a cycle, so up to sessionCount
  cycle: () => w.sessionCount,
  // «5 циклов»: settings.cycles, at most MAX_SESSION_CYCLES
  cycles: (m) => String(MAX_SESSION_CYCLES).length + 1 + cycles(m),
  // a session trade's profit, a numeric(20,8) printed by formatSignedUsd (#539)
  outcome: () => w.signedUsd,
  // formatPrice with the pair's digits, or String() without them (session-texts.ts → priceOf)
  openPrice: () => Math.max(w.price, w.rawPrice),
  closePrice: () => Math.max(w.price, w.rawPrice),
  // asset · direction · duration · stake (texts.ts → intentStatusText)
  line: (m) => tradeLine(m, m.longest('actionUp', 'actionDown') + SEPARATOR),
  assetId: () => w.assetId,
  digits: () => w.stakeDigits,
  // a trade's step in its cycle (#551)
  step: () => w.sessionCount,
  score,
  // a session's result: '-$999 999 999 999.99999999' or '+$…' (formatSignedUsd)
  profit: () => w.signedUsd,
  result,
  // «5 сделок»
  trades: (m) => w.sessionCount + 1 + trades(m),
  // the direction, then the stake when known, then the mode in real (texts.ts → stakeButtonLabel)
  action: (m) => m.longest('actionUp', 'actionDown') + SEPARATOR + w.stake + SEPARATOR + w.mode,
  botUsername: () => w.botUsername,
  // referralLinkOf
  referralLink: () =>
    'https://t.me/'.length +
    w.botUsername +
    '?start='.length +
    REFERRAL_PAYLOAD_PREFIX.length +
    REFERRAL_CODE_LENGTH,
  // a count(*) of the user's referrals, like `count` on the same screen
  connected: () => w.count,
  // the sum of the user's rewards, a bigint (formatCount)
  earnedTokens: () => w.count,
};

const tradeNoticeWidths: Partial<Record<BotTextVarName, BotTextWidth>> = {
  stake: () => w.stake,
};

// Where a key's real assembly is narrower than a variable's default width.
export const BOT_TEXT_VAR_WIDTHS: Readonly<
  Partial<Record<BotTextKey, Partial<Record<BotTextVarName, BotTextWidth>>>>
> = {
  // the address the user typed, or the card's when the broker sent one: never the stand-in
  codeSent: { email: () => w.email },
  codeSentUnknown: { email: () => w.email },
  cardEmail: { email: () => w.email },
  statusReal: { amount: () => w.usd },
  statusDemo: { amount: () => w.usd },
  analysisMomentum: {
    value: (m) =>
      m.longest('momentumUp', 'momentumDown', 'momentumNeutral') + DASH + indicator(w.rsi),
  },
  analysisVolatility: {
    value: (m) =>
      volatility(
        m,
        m.longest('volatilityNormal', 'volatilityLow', 'volatilityHigh', 'volatilityTickFloor'),
      ),
  },
  analysisCandles: { count: () => w.candles },
  indicatorShortData: { count: () => w.candles },
  analysisAtrTicks: { count: () => w.atrTicks },
  intentStake: { amount: () => w.stake },
  // the pair, or the asset's id when the catalog could not say (sessionAssetLabel); the session's
  // base stake, never the minimum's label
  sessionPair: { symbol: (m) => Math.max(w.symbol, m.length('intentAssetFallback')) },
  sessionStake: { stake: () => w.stake },
  sessionWon: { count: () => w.sessionCount },
  sessionLost: { count: () => w.sessionCount },
  sessionTied: { count: () => w.sessionCount },
  sessionBalanceDemo: { amount: () => w.usd },
  sessionBalanceReal: { amount: () => w.usd },
  // /paysupport's lines print a payment's total_amount, an int4 (#118)
  paysupportLinePaid: { stars: () => w.starAmount },
  paysupportLineHeld: { stars: () => w.starAmount },
  paysupportLineRequested: { stars: () => w.starAmount },
  paysupportLineRefunded: { stars: () => w.starAmount },
  // the card's column: a trade's number in its session, at most MAX_SESSION_SUMMARY_TRADES
  sessionCardTrade: { count: () => w.sessionCount },
  // a session trade's stake is its intent's amount, never the minimum's label; its step is a
  // number in the session's series
  sessionTradeWon: tradeNoticeWidths,
  sessionTradeLost: tradeNoticeWidths,
  sessionTradeTied: tradeNoticeWidths,
  // shown only with an amount; launchStakeMinimum stands in without one
  launchStake: { stake: () => w.stake },
  // the mode screen names the real stake, the saved one or the broker's minimum: never the label
  // (#474)
  modeRealStake: { stake: () => w.stake },
  modeConfirm: { stake: () => w.stake },
  modeStakeOutOfBounds: { stake: () => w.stake },
  // the offer under a finished trade names the session its row starts, always
  // DEFAULT_SESSION_CYCLES — 5, «циклов» (texts.ts → intentStatusText, #360)
  intentSessionOffer: {
    cycles: (m) => String(DEFAULT_SESSION_CYCLES).length + 1 + m.length('sessionCycleMany'),
  },
};

type Widths = Partial<Record<BotTextVarName, BotTextWidth>>;

// A literal string, a key's text, the longest of several sequences, or one repeated.
export type BotTextSegment =
  | string
  // `width` in place of the key's own widths, where the message narrows a variable
  | { readonly key: BotTextKey; readonly width?: Widths }
  | { readonly oneOf: readonly (readonly BotTextSegment[])[] }
  | {
      readonly repeat: number;
      readonly of: readonly BotTextSegment[];
      readonly separator: string;
    };

export interface BotTextMessage {
  readonly id: string;
  // in Russian, for the writer's refusal
  readonly title: string;
  readonly limit: number;
  readonly body: readonly BotTextSegment[];
}

const k = (key: BotTextKey, width?: Widths): BotTextSegment =>
  width === undefined ? { key } : { key, width };
const oneOf = (...options: (readonly BotTextSegment[])[]): BotTextSegment => ({ oneOf: options });
const anyOf = (...keys: BotTextKey[]): BotTextSegment => oneOf(...keys.map((key) => [k(key)]));

const balances = (amount: number): BotTextSegment[] => [
  k('statusReal', { amount: () => amount }),
  '\n',
  k('statusDemo', { amount: () => amount }),
  '\n',
  k('statusTokens'),
  ' ',
  k('statusReserved'),
];

// a rule refusal's features (the signal's card has a block of its own)
const features: BotTextSegment[] = [
  k('analysisTrend'),
  '\n',
  k('analysisMomentum'),
  '\n',
  k('analysisVolatility'),
  '\n',
  k('analysisCandles'),
  '\n',
  k('analysisLastPrice'),
];

// The card's block (analysis.ts → cardBlock): every label padded to the longest of the eight, one
// space, the value; inside <pre>, whose tags parsing drops
const cardLabels = oneOf(
  ...(
    [
      'cardRowPair',
      'cardRowRsi',
      'cardRowMacd',
      'cardRowMa50',
      'cardRowMa200',
      'cardRowTrend',
      'cardRowVolatility',
      'cardRowDirection',
    ] as const
  ).map((key) => [k(key)]),
);
const x = (width: number) => 'x'.repeat(width);
// an indicator with its word and number, or «данных мало» in place of both
const indicatorRow = (...words: BotPlainKey[]): BotTextSegment[] => [
  cardLabels,
  ' ',
  oneOf([anyOf(...words), ' ', x(w.price)], [k('indicatorShortData')]),
];
const card = (title: BotHtmlKey, direction: BotPlainKey): BotTextSegment[] => [
  k('analysisHeader'),
  '\n',
  k(title),
  '\n\n',
  cardLabels,
  ' ',
  x(w.symbol),
  '\n',
  cardLabels,
  ' ',
  anyOf('rsiOverbought', 'rsiOversold', 'rsiNeutral'),
  ' ',
  x(w.rsi),
  '\n',
  ...indicatorRow('macdCrossUp', 'macdCrossDown', 'macdAbove', 'macdBelow', 'macdEqual'),
  '\n',
  ...indicatorRow('maPriceAbove', 'maPriceBelow', 'maPriceEqual'),
  '\n',
  ...indicatorRow('maPriceAbove', 'maPriceBelow', 'maPriceEqual'),
  '\n',
  cardLabels,
  ' ',
  anyOf('trendUp', 'trendDown', 'trendFlat'),
  '\n',
  cardLabels,
  ' ',
  k('volatilityNormal'),
  ' ',
  x(w.atrPct + '%'.length),
  '\n',
  cardLabels,
  ' ',
  k(direction),
  '\n',
  k('demoPayout'),
  // a pair paying below the cycle floor gets no session row, the note says why (on every
  // decided answer, #379; in both modes, #327)
  oneOf([], ['\n', k('analysisCycleUnavailable')]),
  '\n\n',
  // real mode (#121): its own disclaimer
  anyOf('analysisDisclaimer', 'analysisDisclaimerReal'),
  // in demo, over the amounts only (demo.ts)
  oneOf([], ['\n\n', k('analysisChooseAmount')]),
];

// helpText: a line per command of the menu, in its order
const commandLines = BOT_COMMANDS.flatMap(({ command, key }) => [`\n/${command} — `, k(key)]);

const intentStatusLines = [
  'intentQueued',
  'intentSubmitting',
  'intentAccepted',
  'intentSettled',
  'intentUnknown',
  'intentManualReview',
  'intentRejectedNotConfigured',
  'intentRejectedExpired',
  'intentRejectedByBroker',
  'intentRejectedPublishFailed',
  'intentRejectedNotFound',
  'intentRejectedManual',
  'intentRejectedPaused',
  'intentRejectedDemoOnly',
  'intentRejected',
] as const satisfies readonly BotHtmlKey[];

const sessionStopLines = [
  'sessionStopManualReview',
  'sessionStopRejectedTwice',
  'sessionStopTimeout',
  'sessionStopStakeStop',
  'sessionStopMaxSteps',
  'sessionStopMaxStake',
  'sessionStopMaxSessionLoss',
  'sessionStopSessionDuration',
  'sessionStopAccountUnavailable',
  'sessionStopPairUnavailable',
  'sessionStopBalanceUnavailable',
  'sessionStopInvalidSettings',
  'sessionStopUserStopped',
  'sessionStopNoSignalTimeout',
  'tradingPaused',
] as const satisfies readonly BotHtmlKey[];
// the session picture's direction line (#568), absent while the session has none
const sessionSignal = oneOf([], ['\n', anyOf('sessionSignalUp', 'sessionSignalDown')]);
// the session message's head (#536, texts.ts → sessionStatusText): the mode's header, the pair,
// the stake, the expiry, the signal's direction
const sessionHead = [
  anyOf('sessionHeader', 'sessionHeaderReal'),
  '\n',
  k('sessionPair'),
  '\n',
  k('sessionStake'),
  '\n',
  k('sessionExpiry'),
  sessionSignal,
];
// a finished session's result and the balance after it, by mode, with the age when it predates
// the last trade (#337, texts.ts → outcomeLines)
const sessionOutcome = [
  '\n',
  k('sessionResult'),
  '\n',
  anyOf('sessionBalanceDemo', 'sessionBalanceReal'),
  '\n',
  k('statusStale'),
];

const ASSEMBLED: readonly BotTextMessage[] = [
  {
    id: 'accountCard',
    title: 'Карточка аккаунта',
    limit: TELEGRAM_CAPTION_LIMIT,
    body: [
      anyOf('cardGreeting', 'cardGreetingNoName'),
      '\n',
      k('cardEmail'),
      '\n\n',
      k('cardBody'),
      '\n\n',
      anyOf('cardBonusGranted', 'cardBonusNotPartner', 'cardBonusAlready'),
    ],
  },
  {
    id: 'statusCard',
    title: 'Карточка статуса',
    limit: TELEGRAM_CAPTION_LIMIT,
    body: [
      k('statusHeader'),
      '\n\n',
      // a stale balance prints both amounts and its age; with no balance both amounts read $0.00
      // and the line says why
      oneOf(
        [...balances(w.usd), '\n', k('statusStale')],
        [...balances(w.zeroUsd), '\n', anyOf('statusAmbiguous', 'statusNoSnapshot')],
      ),
      '\n\n',
      anyOf('statusHint', 'statusHintReal'),
    ],
  },
  {
    id: 'help',
    title: '/help',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [k('helpAbout'), '\n\n', k('helpConnect'), '\n\n', k('helpCommands'), ...commandLines],
  },
  {
    id: 'account',
    title: '/account',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      anyOf('accountConnected', 'accountPending', 'accountRevoked'),
      '\n\n',
      {
        repeat: w.accountLines,
        of: [anyOf('accountLineActive', 'accountLinePending', 'accountLineRevoked')],
        separator: '\n',
      },
    ],
  },
  {
    id: 'paysupport',
    title: '/paysupport',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      k('paysupportScreen'),
      '\n\n',
      {
        repeat: w.paysupportLines,
        of: [
          anyOf(
            'paysupportLinePaid',
            'paysupportLineHeld',
            'paysupportLineRequested',
            'paysupportLineRefunded',
          ),
        ],
        separator: '\n',
      },
    ],
  },
  {
    id: 'analysisFailed',
    title: 'Анализ: свечи не получены',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [k('analysisHeader'), '\n', anyOf('analysisRateLimited', 'analysisUnavailable')],
  },
  {
    id: 'analysisCard',
    title: 'Анализ: карточка сигнала',
    limit: TELEGRAM_CAPTION_LIMIT,
    // the title and the direction row follow the same signal, so each direction is measured whole
    body: [
      oneOf(
        card('analysisCardUp', 'cardDirectionUp'),
        card('analysisCardDown', 'cardDirectionDown'),
      ),
    ],
  },
  {
    id: 'analysisNoData',
    title: 'Анализ: мало данных',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      k('analysisHeader'),
      '\n',
      k('analysisNoSignal', { reason: (m) => m.longest(...dataReasons) }),
      '\n\n',
      k('analysisDataHint'),
      oneOf([], ['\n', k('analysisCycleUnavailable')]),
    ],
  },
  {
    id: 'analysisNoSignal',
    title: 'Анализ: сигнала нет',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      k('analysisHeader'),
      '\n',
      k('analysisNoSignal', { reason: (m) => m.longest(...ruleReasons) }),
      '\n\n',
      ...features,
      '\n\n',
      k('analysisNoSignalHint'),
      oneOf([], ['\n', k('analysisCycleUnavailable')]),
    ],
  },
  {
    id: 'intentStatus',
    title: 'Статус сделки',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      anyOf('intentHeader', 'intentHeaderReal'),
      '\n',
      k('intentTrade'),
      '\n\n',
      anyOf(...intentStatusLines),
      '\n\n',
      anyOf('intentDeadline', 'intentSessionOffer'),
    ],
  },
  {
    id: 'settings',
    title: '/settings',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [k('settings'), '\n\n', k('settingsStake'), '\n', k('settingsStakeReal')],
  },
  // the mode screen (#474): the balance and the real stake only with a snapshot, the paused line
  // only while the switch is closed
  {
    id: 'tradingMode',
    title: 'Экран режима',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      k('modeHeader'),
      '\n',
      k('modeCurrent'),
      oneOf([], ['\n', k('modeRealBalance'), '\n', k('modeRealStake')]),
      '\n\n',
      k('modeWarning'),
      '\n',
      k('modeStopsSession'),
      oneOf([], ['\n', k('modePaused')]),
    ],
  },
  {
    id: 'tradingModeConfirm',
    title: 'Экран режима: подтверждение',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      k('modeConfirm'),
      // only when the real stake fails checkStake against the snapshot
      oneOf([], ['\n', k('modeStakeOutOfBounds')]),
      '\n',
      k('modeStopsSession'),
    ],
  },
  {
    id: 'tradingModeResult',
    title: 'Экран режима: итог переключения',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      anyOf('modeEnabled', 'modeDisabled'),
      // only when the switch stopped an active session (#327)
      oneOf([], ['\n', k('modeSessionStopped')]),
    ],
  },
  {
    id: 'stakePicker',
    title: 'Экран суммы',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      // by the picker's mode (#326)
      anyOf('stakePickerHeader', 'stakePickerHeaderReal'),
      '\n',
      k('stakePickerCurrent'),
      '\n',
      k('stakePickerMinimum'),
      '\n',
      anyOf('stakePickerAvailable', 'stakePickerAvailableReal'),
      // only when no preset fits the bounds
      '\n',
      anyOf('stakePickerNoPresets', 'stakePickerNoPresetsReal'),
    ],
  },
  {
    id: 'sessionNoSettings',
    title: 'Сессия: настройки не прочитаны',
    // the session message is the caption of its picture (#568)
    limit: TELEGRAM_CAPTION_LIMIT,
    body: [
      anyOf('sessionHeader', 'sessionHeaderReal'),
      sessionSignal,
      '\n\n',
      k('sessionSettingsUnavailable'),
    ],
  },
  {
    id: 'sessionRunning',
    title: 'Сессия идёт',
    limit: TELEGRAM_CAPTION_LIMIT,
    body: [...sessionHead, '\n\n', k('sessionRunning')],
  },
  {
    id: 'sessionCompleted',
    title: 'Сессия завершена',
    limit: TELEGRAM_CAPTION_LIMIT,
    body: [...sessionHead, '\n\n', k('sessionCompleted')],
  },
  {
    id: 'sessionStopped',
    title: 'Сессия остановлена',
    limit: TELEGRAM_CAPTION_LIMIT,
    body: [...sessionHead, '\n\n', anyOf(...sessionStopLines, 'sessionStatusUnavailable')],
  },
  {
    // the reply to «⏹» and to /stop of one session (#536, texts.ts → sessionStopReplyText): the
    // session's end line, and the open trade's line when it plays out
    id: 'sessionStopReply',
    title: 'Ответ на остановку сессии',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      anyOf('sessionCompleted', ...sessionStopLines, 'sessionStatusUnavailable'),
      '\n',
      k('sessionOpenTradePlaysOut'),
    ],
  },
  {
    // a block of a session's cycle message, sent and edited by the backend (#551, session-texts.ts
    // → sessionCycleText): the adaptive line above step 2's block, then the block. A cycle's
    // message is such units a blank line apart; the sender splits it by its real length before
    // the limit, never inside a unit, so this unit is what must fit
    id: 'sessionTrade',
    title: 'Сообщение сделки сессии',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      oneOf(
        [anyOf('sessionTradeWon', 'sessionTradeLost', 'sessionTradeTied')],
        // the line stands only above step 2: one digit
        [
          k('sessionAdaptiveStake'),
          '\n\n',
          oneOf(
            ...(['sessionTradeWon', 'sessionTradeLost', 'sessionTradeTied'] as const).map((key) => [
              k(key, { step: () => 1 }),
            ]),
          ),
        ],
      ),
    ],
  },
  {
    // the finished session's summary, sent by the backend (#464, session-texts.ts →
    // sessionSummaryText): the pair, then the status message's closing lines; the backend sends it
    // only with a settled trade, so the total always stands under a stop reason
    id: 'sessionSummary',
    title: 'Итог сессии',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      // the pair, or the asset's id when the catalog could not say (sessionAssetLabel)
      k('sessionSummarySymbol', {
        symbol: (m) => Math.max(w.symbol, m.length('intentAssetFallback')),
      }),
      '\n',
      oneOf([k('sessionCompleted')], [anyOf(...sessionStopLines), '\n', k('sessionTotal')]),
      ...sessionOutcome,
    ],
  },
  {
    // the summary card's footer (#318, texts.ts → sessionCardFooter): plain text drawn on the
    // image, bounded by the key's own limit, the width its line has on the card
    id: 'sessionCardFooter',
    title: 'Картинка-итог: нижняя строка',
    limit: BOT_TEXT_CATALOG.sessionCardFooter.limit,
    body: [k('sessionCardFooter')],
  },
  {
    id: 'demoLaunch',
    title: 'Демо: запуск цикла',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      // only after a saved stake, in the saved stake's mode (#326)
      anyOf('stakeSavedLine', 'stakeSavedLineReal'),
      '\n\n',
      k('launchHeader'),
      '\n',
      anyOf('launchStake', 'launchStakeMinimum'),
      '\n',
      // real mode (#327): the cycle trades real money
      anyOf('launchCycle', 'launchCycleReal'),
    ],
  },
  {
    // the amount screen of a demo cycle (#476, texts.ts → cycleStakeText)
    id: 'demoCycleStake',
    title: 'Демо: выбор суммы цикла',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      // only after a save in the stake picker opened from an old launch screen, in its mode
      anyOf('stakeSavedLine', 'stakeSavedLineReal'),
      '\n\n',
      k('launchHeader'),
      '\n',
      k('launchCycle'),
      '\n\n',
      // no amount to offer: the demo balance is below the broker's minimum
      anyOf('cycleStakeChoose', 'stakePickerNoPresets'),
    ],
  },
  {
    id: 'demoPairs',
    title: 'Демо: список активов',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [k('demoPairsHeader'), '\n', k('demoPage')],
  },
  {
    id: 'demoDurations',
    title: 'Демо: выбор длительности',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [k('demoAsset'), '\n', k('demoPayout'), '\n\n', k('demoChooseDuration')],
  },
  {
    id: 'demoSummary',
    title: 'Демо: итог выбора',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      k('demoAsset'),
      '\n',
      k('demoDurationLine'),
      '\n',
      k('demoPayout'),
      '\n\n',
      k('demoNext'),
    ],
  },
];

function keysIn(body: readonly BotTextSegment[]): BotTextKey[] {
  return body.flatMap((segment) => {
    if (typeof segment === 'string') return [];
    if ('key' in segment) return [segment.key];
    if ('oneOf' in segment) return segment.oneOf.flatMap(keysIn);
    return keysIn(segment.of);
  });
}

const assembledKeys = new Set(ASSEMBLED.flatMap((message) => keysIn(message.body)));

// An html key with variables in no assembled message is a message of its own: its widest
// variables are checked against its own limit.
export const BOT_TEXT_MESSAGES: readonly BotTextMessage[] = [
  ...ASSEMBLED,
  ...(Object.keys(BOT_TEXT_CATALOG) as BotTextKey[])
    .filter(
      (key): key is BotHtmlVarKey =>
        BOT_TEXT_CATALOG[key].kind === BotTextKind.Html &&
        BOT_TEXT_CATALOG[key].vars.length > 0 &&
        !assembledKeys.has(key),
    )
    .map((key) => ({
      id: key,
      title: `текст ${key}`,
      limit: BOT_TEXT_CATALOG[key].limit,
      body: [k(key)],
    })),
];

const KEY_WIDTHS: Partial<Record<BotTextKey, Widths>> = BOT_TEXT_VAR_WIDTHS;

function measureOf(lookup: BotTextSource<BotTextKey>): BotTextMeasure {
  const { renderWith } = createBotTexts(lookup);
  // an html text is measured after entities parsing; a plain one is escaped and shown as written;
  // a width is worked out only for a variable the text holds
  const length: BotTextMeasure['length'] = (key, widths = {}) => {
    const value = renderWith(key, (name) => {
      const variable = name as BotTextVarName;
      const width =
        widths[variable] ??
        (KEY_WIDTHS[key]?.[variable] ?? BOT_TEXT_VAR_DEFAULT_WIDTHS[variable])(m);
      return 'x'.repeat(width);
    });
    return BOT_TEXT_CATALOG[key].kind === BotTextKind.Html
      ? plainTextOf(String(value)).length
      : String(value).length;
  };
  const m: BotTextMeasure = {
    length,
    longest: (...keys) => Math.max(...keys.map((key) => length(key))),
  };
  return m;
}

function lengthOf(body: readonly BotTextSegment[], m: BotTextMeasure): number {
  let total = 0;
  for (const segment of body) {
    if (typeof segment === 'string') total += segment.length;
    else if ('key' in segment) {
      const narrowed = Object.entries(segment.width ?? {}).map(
        ([name, width]) => [name, width(m)] as const,
      );
      total += m.length(segment.key, Object.fromEntries(narrowed));
    } else if ('oneOf' in segment) {
      total += Math.max(...segment.oneOf.map((option) => lengthOf(option, m)));
    } else {
      total +=
        segment.repeat * lengthOf(segment.of, m) + (segment.repeat - 1) * segment.separator.length;
    }
  }
  return total;
}

/** The upper bound of `message`'s length after entities parsing, with `lookup`'s texts. */
export const estimateBotTextMessage = (
  message: BotTextMessage,
  lookup: BotTextSource<BotTextKey>,
): number => lengthOf(message.body, measureOf(lookup));

export interface BotTextMessageOverflow {
  message: BotTextMessage;
  length: number;
}

export function botTextMessageOverflows(
  lookup: BotTextSource<BotTextKey>,
): BotTextMessageOverflow[] {
  const m = measureOf(lookup);
  return BOT_TEXT_MESSAGES.map((message) => ({
    message,
    length: lengthOf(message.body, m),
  })).filter(({ message, length }) => length > message.limit);
}

/**
 * Every key the estimate of `message` reads: its parts, their fragments and the labels its
 * widths are made of. Reverting all of them to the defaults brings the message back within its
 * limit, since the defaults fit.
 */
export function botTextMessageKeys(message: BotTextMessage): Set<BotTextKey> {
  const read = new Set<BotTextKey>();
  estimateBotTextMessage(message, {
    sourceOf: (key) => {
      read.add(key);
      return BOT_TEXT_CATALOG[key].source;
    },
  });
  return read;
}
