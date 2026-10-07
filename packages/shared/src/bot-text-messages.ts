import { BotTextKind, type BotTextSource } from './bot-text-template';
import {
  BOT_TEXT_CATALOG,
  BotTextGroup,
  botTextKeysOf,
  createBotTexts,
  type BotHtmlKey,
  type BotPlainKey,
  type BotTextKey,
} from './bot-texts';
import { plainTextOf, TELEGRAM_CAPTION_LIMIT, TELEGRAM_MESSAGE_LIMIT } from './telegram-html';

// The messages the client bot assembles from several catalog keys (docs/bot-texts.md → Assembled
// messages). A key's own limit is checked with its sample; these descriptions bound what the key
// limit cannot: a caption or a message made of many keys, and a key whose argument can be far
// wider than its sample. The bot's test (apps/bot/src/bot-text-messages.test.ts) holds every
// description equal to the real assembly on the defaults.

type Catalog = typeof BOT_TEXT_CATALOG;
export type BotHtmlArgKey = {
  [K in BotHtmlKey]: Catalog[K]['arg'] extends string ? K : never;
}[BotHtmlKey];

// The widest value each argument can take. A bound named after a schema is enforced there; the
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
  // a signal parameter's period, and the count of closed candles
  period: 4,
  candles: 5,
  // durationLabelOf's fallback on an int4 duration: ⏱ 2147483647 с
  durationFallback: 14,
  // the /account lines: at most this many links per user
  accountLines: 10,
  // a session's counters: sessionFitsDeadline starts at most 60 trades
  sessionCount: 3,
} as const;

export interface BotTextMeasure {
  // the length after entities parsing of `key`'s text, its argument `argWidth` characters wide
  length(key: BotTextKey, argWidth?: number): number;
  longest(...keys: BotTextKey[]): number;
}

const w = BOT_TEXT_WIDTHS;
const durations = [
  'demoDuration60',
  'demoDuration300',
  'demoDuration900',
  'demoDuration1800',
  'demoDuration3600',
] as const satisfies readonly BotPlainKey[];
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
  'noSignalTrendFlat',
  'noSignalRsiNeutral',
  'noSignalTrendMomentumDisagree',
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
  Math.max(w.symbol, m.length('intentAssetFallback', w.assetId)) +
  SEPARATOR +
  action +
  Math.max(m.longest(...durations), w.durationFallback) +
  SEPARATOR +
  m.length('intentStake', w.usd);
// «3 в плюс, 1 в минус, 1 в ноль»
const score = (m: BotTextMeasure) =>
  m.length('sessionWon', w.sessionCount) +
  ', '.length +
  m.length('sessionLost', w.sessionCount) +
  ', '.length +
  m.length('sessionTied', w.sessionCount);
// «5 сделок — 3 в плюс, 2 в минус»
const result = (m: BotTextMeasure) =>
  w.sessionCount +
  1 +
  m.longest('sessionTradeOne', 'sessionTradeFew', 'sessionTradeMany') +
  DASH +
  score(m);
const volatility = (word: number) => word + DASH + indicator(w.atrPct + '%'.length);

export const BOT_TEXT_ARG_WIDTHS: Readonly<Record<BotHtmlArgKey, (m: BotTextMeasure) => number>> = {
  codeSent: () => w.email,
  codeSentUnknown: () => w.email,
  cardGreeting: () => w.firstName,
  cardEmail: () => w.email,
  cardBonusGranted: () => w.rawCount,
  accountLineActive: address,
  accountLinePending: address,
  accountLineRevoked: address,
  statusHeader: () => w.mode,
  statusReal: () => w.usd,
  statusDemo: () => w.usd,
  statusTokens: () => w.count,
  statusReserved: () => w.count,
  statusStale: () => w.age,
  settings: (m) => m.longest('levelAll', 'levelReduced', 'levelOff'),
  demoPairsHeader: (m) => m.longest(...groups),
  demoPage: () => w.page,
  demoGroupClosed: (m) => m.longest(...groups),
  demoAsset: () => w.symbol,
  demoPayout: () => w.payout,
  demoDurationLine: (m) => m.longest(...durations),
  demoPairClosed: () => w.symbol,
  demoDurationUnsupported: () => w.symbol,
  demoNoDuration: () => w.symbol,
  analyzing: subject,
  analysisHeader: subject,
  analysisNoSignal: (m) => m.longest(...ruleReasons, ...dataReasons),
  analysisTrend: (m) =>
    m.longest('trendUp', 'trendDown', 'trendFlat') +
    DASH +
    indicator(w.price) +
    1 +
    m.longest('emaAbove', 'emaBelow', 'emaEqual') +
    1 +
    indicator(w.price),
  analysisMomentum: (m) =>
    m.longest('momentumUp', 'momentumDown', 'momentumNeutral') + DASH + indicator(w.rsi),
  analysisVolatility: (m) =>
    volatility(m.longest('volatilityNormal', 'volatilityLow', 'volatilityHigh')),
  analysisCandles: () => w.candles,
  analysisLastPrice: () => w.price,
  analysisRateLimited: () => w.retryAfterSec,
  // asset · direction · duration · stake (texts.ts → intentStatusText)
  intentTrade: (m) => tradeLine(m, m.longest('actionUp', 'actionDown') + SEPARATOR),
  // asset · duration · stake (texts.ts → sessionStatusText)
  sessionSettings: (m) => tradeLine(m, 0),
  // «3 из 5»
  sessionStep: () => w.sessionCount + ' из '.length + w.sessionCount,
  sessionScore: score,
  sessionCompleted: result,
  sessionTotal: result,
};

// A literal string, a key's text, the longest of several sequences, or one repeated.
export type BotTextSegment =
  | string
  // `width` in place of the key's own argument width, where the message narrows the argument
  | { readonly key: BotTextKey; readonly width?: (m: BotTextMeasure) => number }
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

const k = (key: BotTextKey, width?: (m: BotTextMeasure) => number): BotTextSegment =>
  width === undefined ? { key } : { key, width };
const oneOf = (...options: (readonly BotTextSegment[])[]): BotTextSegment => ({ oneOf: options });
const anyOf = (...keys: BotTextKey[]): BotTextSegment => oneOf(...keys.map((key) => [k(key)]));

const balances = (amount: number): BotTextSegment[] => [
  k('statusReal', () => amount),
  '\n',
  k('statusDemo', () => amount),
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
    ? k('analysisVolatility', (m) => volatility(m.length('volatilityNormal')))
    : k('analysisVolatility'),
  '\n',
  k('analysisCandles'),
  '\n',
  k('analysisLastPrice'),
];

// helpText: a line per command, the command's name read off its key (startCommand → start)
const commandLines = botTextKeysOf(BotTextGroup.Commands).flatMap((key) => [
  `\n/${key.replace(/Command$/, '')} — `,
  k(key),
]);

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
      k('analysisNoSignal', (m) => m.longest(...dataReasons)),
      '\n\n',
      k('analysisDataHint'),
    ],
  },
  {
    id: 'analysisNoSignal',
    title: 'Анализ: сигнала нет',
    limit: TELEGRAM_MESSAGE_LIMIT,
    body: [
      k('analysisHeader'),
      '\n',
      k('analysisNoSignal', (m) => m.longest(...ruleReasons)),
      '\n\n',
      ...features(false),
      '\n\n',
      k('analysisNoSignalHint'),
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
      k('intentDeadline'),
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
    body: [...sessionHead, '\n\n', k('sessionCompleted')],
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
      '\n',
      anyOf(...liveIntentLines),
      '\n',
      k('sessionOpenTradePlaysOut'),
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

// A key whose argument is in no assembled message is a message of its own: its widest argument
// is checked against its own limit.
export const BOT_TEXT_MESSAGES: readonly BotTextMessage[] = [
  ...ASSEMBLED,
  ...(Object.keys(BOT_TEXT_ARG_WIDTHS) as BotHtmlArgKey[])
    .filter((key) => !assembledKeys.has(key))
    .map((key) => ({
      id: key,
      title: `текст ${key}`,
      limit: BOT_TEXT_CATALOG[key].limit,
      body: [k(key)],
    })),
];

function measureOf(lookup: BotTextSource<BotTextKey>): BotTextMeasure {
  const { html, plain } = createBotTexts(lookup);
  const length = (key: BotTextKey, argWidth = 0): number => {
    const view: unknown =
      BOT_TEXT_CATALOG[key].kind === BotTextKind.Html
        ? html[key as BotHtmlKey]
        : plain[key as BotPlainKey];
    const value =
      typeof view === 'function' ? (view as (arg: string) => unknown)('x'.repeat(argWidth)) : view;
    return plainTextOf(String(value)).length;
  };
  return { length, longest: (...keys) => Math.max(...keys.map((key) => length(key))) };
}

const ARG_WIDTHS: Partial<Record<BotTextKey, (m: BotTextMeasure) => number>> = BOT_TEXT_ARG_WIDTHS;

function lengthOf(body: readonly BotTextSegment[], m: BotTextMeasure): number {
  let total = 0;
  for (const segment of body) {
    if (typeof segment === 'string') total += segment.length;
    else if ('key' in segment) {
      total += m.length(segment.key, (segment.width ?? ARG_WIDTHS[segment.key])?.(m));
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
