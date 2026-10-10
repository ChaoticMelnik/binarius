import { USER_ACCOUNT_LIST_LIMIT } from './account';
import { BOT_COMMANDS } from './bot-commands';
import { REFERRAL_CODE_LENGTH, REFERRAL_PAYLOAD_PREFIX } from './referral';
import { MIN_CYCLE_PAYOUT_PCT } from './catalog';
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
import { DEFAULT_SESSION_TRADES } from './trading-session';

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
  // formatUsd('0'), both amounts of a card with no balance
  zeroUsd: 5,
  // formatStake over an unsigned numeric(20,8): $999 999 999 999.99999999 — the demo stake, the
  // broker's minimum and the demo balance are all money() columns their writers keep unsigned (#297)
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
  // the broker's symbol, unbounded on the wire; assumed as INTENT_SYMBOL_LIMIT
  symbol: 64,
  payout: 6,
  // formatBreakEven: 0.0-100.0, or a dash
  breakEven: 5,
  payoutFloor: String(MIN_CYCLE_PAYOUT_PCT).length,
  // «999 из 999»
  page: 10,
  retryAfterSec: 5,
  assetId: 10,
  // formatPrice: |x| < 1e9 with up to 10 digits after the point, and a sign
  price: 21,
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
  // a session's counters: sessionFitsDeadline starts at most 60 trades
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
// a balance prints a number only when fresh, its stand-in otherwise (bot-text-vars.ts)
const balance = (m: BotTextMeasure) => Math.max(w.usd, m.length('balanceUnavailable'));

// Each variable's widest value wherever it stands; a variable without one does not compile.
export const BOT_TEXT_VAR_DEFAULT_WIDTHS: Readonly<Record<BotTextVarName, BotTextWidth>> = {
  firstName: () => w.firstName,
  email: address,
  tokens: () => w.count,
  reservedTokens: () => w.count,
  bonusTokens: () => w.rawCount,
  demoBalance: balance,
  realBalance: balance,
  mode: () => w.mode,
  level: (m) => m.longest('levelAll', 'levelReduced', 'levelOff'),
  // the saved stake, or the minimum's label (texts.ts → stakeLabel)
  stake: stakeLabel,
  minStake: () => w.stake,
  demoAvailable: () => w.stake,
  age: () => w.age,
  // stakePickerText: the saved stake, or «label (minimum)»
  amount: (m) =>
    Math.max(w.stake, m.length('stakeMinimumLabel') + ' ('.length + w.stake + ')'.length),
  count: () => w.count,
  symbol: () => w.symbol,
  group: (m) => m.longest(...groups),
  page: () => w.page,
  payout: () => w.payout,
  breakEven: () => w.breakEven,
  payoutFloor: () => w.payoutFloor,
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
  // asset · direction · duration · stake (texts.ts → intentStatusText)
  line: (m) => tradeLine(m, m.longest('actionUp', 'actionDown') + SEPARATOR),
  assetId: () => w.assetId,
  digits: () => w.stakeDigits,
  // «3 из 5»
  step: () => w.sessionCount + ' из '.length + w.sessionCount,
  score,
  // a session's result: '-$999 999 999 999.99' or '+$…', both w.usd (formatSignedUsd)
  profit: () => w.usd,
  result,
  // «5 сделок»
  trades: (m) => w.sessionCount + 1 + trades(m),
  // the direction, then the stake when known (texts.ts → stakeButtonLabel)
  action: (m) => m.longest('actionUp', 'actionDown') + SEPARATOR + w.stake,
  botUsername: () => w.botUsername,
  // referralLinkOf
  referralLink: () =>
    'https://t.me/'.length +
    w.botUsername +
    '?start='.length +
    REFERRAL_PAYLOAD_PREFIX.length +
    REFERRAL_CODE_LENGTH,
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
  analysisAtrTicks: { count: () => w.atrTicks },
  intentStake: { amount: () => w.stake },
  // asset · duration · stake (texts.ts → sessionStatusText)
  sessionSettings: { line: (m) => tradeLine(m, 0) },
  sessionWon: { count: () => w.sessionCount },
  sessionLost: { count: () => w.sessionCount },
  sessionTied: { count: () => w.sessionCount },
  sessionBalanceDemo: { amount: () => w.usd },
  sessionBalanceReal: { amount: () => w.usd },
  // the card's column: a trade's number in its session, at most MAX_SESSION_TRADES
  sessionCardTrade: { count: () => w.sessionCount },
  // shown only with an amount; launchStakeMinimum stands in without one
  launchStake: { stake: () => w.stake },
  // the offer under a finished trade names the session its row starts, always
  // DEFAULT_SESSION_TRADES — 5, «сделок» (texts.ts → intentStatusText, #360)
  intentSessionOffer: {
    trades: (m) => String(DEFAULT_SESSION_TRADES).length + 1 + m.length('sessionTradeMany'),
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

// a signal is decided with the volatility in bounds
const features = (signal: boolean): BotTextSegment[] => [
  k('analysisTrend'),
  '\n',
  k('analysisMomentum'),
  '\n',
  signal
    ? k('analysisVolatility', { value: (m) => volatility(m, m.length('volatilityNormal')) })
    : k('analysisVolatility'),
  '\n',
  k('analysisCandles'),
  '\n',
  k('analysisLastPrice'),
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

// a trade the session can still move: one with an edge out of its status
const liveIntentLines = [
  'intentQueued',
  'intentSubmitting',
  'intentAccepted',
  'intentUnknown',
  'intentManualReview',
] as const satisfies readonly BotHtmlKey[];
const sessionStopLines = [
  'sessionStopManualReview',
  'sessionStopRejectedTwice',
  'sessionStopTimeout',
  'sessionStopStakeStop',
  'sessionStopAccountUnavailable',
  'sessionStopPairUnavailable',
  'sessionStopBalanceUnavailable',
  'sessionStopInvalidSettings',
  'sessionStopUserStopped',
  'tradingPaused',
] as const satisfies readonly BotHtmlKey[];
const sessionHead = [k('sessionHeader'), '\n', k('sessionSettings')];
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
      k('statusHint'),
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
    id: 'analysisFailed',
    title: 'Анализ: свечи не получены',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [k('analysisHeader'), '\n', anyOf('analysisRateLimited', 'analysisUnavailable')],
  },
  {
    id: 'analysisSignal',
    title: 'Анализ: сигнал',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      k('analysisHeader'),
      '\n',
      anyOf('analysisSignalUp', 'analysisSignalDown'),
      '\n\n',
      ...features(true),
      '\n',
      k('demoPayout'),
      // a pair paying below the cycle floor: no session row, the note says why (on every
      // decided answer, #379)
      oneOf([], ['\n', k('analysisCycleUnavailable')]),
      '\n\n',
      k('analysisDisclaimer'),
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
      ...features(false),
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
      k('intentHeader'),
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
    body: [k('settings'), '\n\n', k('settingsStake')],
  },
  {
    id: 'stakePicker',
    title: 'Экран суммы',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      k('stakePickerHeader'),
      '\n',
      k('stakePickerCurrent'),
      '\n',
      k('stakePickerMinimum'),
      '\n',
      k('stakePickerAvailable'),
      // only when no preset fits the bounds
      '\n',
      k('stakePickerNoPresets'),
    ],
  },
  {
    id: 'sessionNoSettings',
    title: 'Сессия: настройки не прочитаны',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [k('sessionHeader'), '\n\n', k('sessionSettingsUnavailable')],
  },
  {
    id: 'sessionRunning',
    title: 'Сессия идёт',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      ...sessionHead,
      '\n',
      k('sessionStep'),
      '\n',
      k('sessionScore'),
      '\n\n',
      anyOf(...liveIntentLines, 'sessionWaitingSignal'),
      '\n',
      k('sessionDeadline'),
    ],
  },
  {
    id: 'sessionCompleted',
    title: 'Сессия завершена',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [...sessionHead, '\n\n', k('sessionCompleted'), ...sessionOutcome],
  },
  {
    id: 'sessionStopped',
    title: 'Сессия остановлена',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      ...sessionHead,
      '\n\n',
      anyOf(...sessionStopLines, 'sessionStatusUnavailable'),
      '\n',
      k('sessionTotal'),
      ...sessionOutcome,
      '\n',
      anyOf(...liveIntentLines),
      '\n',
      k('sessionOpenTradePlaysOut'),
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
      // only after a saved stake
      k('stakeSavedLine'),
      '\n\n',
      k('launchHeader'),
      '\n',
      anyOf('launchStake', 'launchStakeMinimum'),
      '\n',
      k('launchCycle'),
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
