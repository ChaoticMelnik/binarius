import { formatAge, formatCount, formatSignedUsd, formatStake, formatUsd } from './bot-text-format';
import type { BotTextVariable } from './bot-text-template';
import { MIN_CYCLE_PAYOUT_PCT } from './catalog';
import type { DecimalString } from './money';
import { TradeMode } from './trading';
import { NotificationLevel } from './users';

// The registry of the values a bot text can print (#358, docs/bot-texts.md → Variables): a key of
// the catalog lists the ones its callers hold when they render it (bot-texts.ts), and a text may
// use any of them, none required. A variable is never fetched for a text: `format` gets only the
// caller's input and the catalog's stand-in texts. How wide each can get is in
// bot-text-messages.ts (BOT_TEXT_VAR_DEFAULT_WIDTHS).

// The texts a formatter may stand in with: static plain keys of the catalog (bot-texts.test.ts),
// read from the same source as the text that prints them, so an override applies here too.
export type BotTextVarFallbackKey =
  | 'accountUnknownAddress'
  | 'balanceUnavailable'
  | 'stakeMinimumLabel'
  | 'levelAll'
  | 'levelReduced'
  | 'levelOff';

export interface BotTextVar<I> extends BotTextVariable<I> {
  format(input: I, texts: (key: BotTextVarFallbackKey) => string): string;
}

const variable = <I>(definition: BotTextVar<I>): BotTextVar<I> => definition;
// a value the caller has already put into words from the catalog and its data, printed as is
const shown = (description: string, sample: string): BotTextVar<string> =>
  variable({ description, sample, format: (value: string) => value });

// The status card's header (#24): DEMO until a user can trade on real. Data, not a text: it
// stays out of the catalog.
export const MODE_LABELS = {
  [TradeMode.Demo]: 'DEMO',
  [TradeMode.Real]: 'REAL',
} as const satisfies Record<TradeMode, string>;

const LEVEL_KEYS = {
  [NotificationLevel.All]: 'levelAll',
  [NotificationLevel.Reduced]: 'levelReduced',
  [NotificationLevel.Off]: 'levelOff',
} as const satisfies Record<NotificationLevel, BotTextVarFallbackKey>;

// A broker balance as the access read gives it: null with no snapshot, `fresh` as the backend
// judged it (isBalanceFresh). Only a fresh one is printed as a number.
export type BotTextBalance = { readonly amount: DecimalString; readonly fresh: boolean } | null;

const balance = (description: string, sample: string): BotTextVar<BotTextBalance> =>
  variable({
    description,
    sample,
    format: (input, texts) =>
      input !== null && input.fresh ? formatUsd(input.amount) : texts('balanceUnavailable'),
  });

export const BOT_TEXT_VARS = {
  firstName: variable({
    description: 'Имя пользователя из Telegram',
    sample: 'Ада',
    // the Bot API guarantees first_name non-empty, not non-blank; a padded name would pad the line
    format: (name: string) => name.trim(),
  }),
  email: variable({
    description: 'Адрес аккаунта Binodex; неизвестен — «адрес неизвестен»',
    sample: 'ada@example.com',
    format: (email: string | null, texts) => email ?? texts('accountUnknownAddress'),
  }),
  tokens: variable({
    description: 'Доступные токены автоторговли',
    sample: '12',
    format: (count: string) => formatCount(count),
  }),
  reservedTokens: variable({
    description: 'Токены в резерве под идущие сделки',
    sample: '3',
    format: (count: string) => formatCount(count),
  }),
  bonusTokens: shown('Начисленные стартовые токены', '100'),
  demoBalance: balance(
    'Демобаланс Binodex; без свежего снимка — «нет свежих данных»',
    formatUsd('10000'),
  ),
  realBalance: balance(
    'Реальный баланс Binodex; без свежего снимка — «нет свежих данных»',
    formatUsd('1234.56'),
  ),
  mode: variable({
    description: 'Режим торговли: DEMO или REAL',
    sample: 'DEMO',
    format: (mode: TradeMode) => MODE_LABELS[mode],
  }),
  level: variable({
    description: 'Выбранный уровень уведомлений, как на кнопке',
    sample: '🔔 Все',
    format: (level: NotificationLevel, texts) => texts(LEVEL_KEYS[level]),
  }),
  stake: variable({
    description: 'Сумма демо-сделки; не выбрана — «минимальная ставка брокера»',
    sample: '$5.00',
    format: (stake: DecimalString | null, texts) =>
      stake === null ? texts('stakeMinimumLabel') : formatStake(stake),
  }),
  minStake: variable({
    description: 'Минимальная ставка брокера',
    sample: '$1.00',
    format: (amount: DecimalString) => formatStake(amount),
  }),
  demoAvailable: variable({
    description: 'Доступно на демо-счёте, как на экране суммы',
    sample: formatStake('9990'),
    format: (amount: DecimalString) => formatStake(amount),
  }),
  age: variable({
    description: 'Возраст снимка баланса',
    sample: '5 мин',
    format: (seconds: number) => formatAge(seconds),
  }),
  amount: shown('Сумма этой строки, как в исходном тексте', formatUsd('10000')),
  count: shown('Число этой строки (свечи, сделки)', '12'),
  symbol: shown('Актив, как его пишет брокер', 'EUR/USD OTC'),
  group: shown('Тип актива', '💱 Валюты'),
  page: shown('Страница списка', '2 из 4'),
  payout: shown('Выплата актива, %', '92'),
  breakEven: shown('Безубыточность при выплате актива: доля верных прогнозов, %', '55.6'),
  payoutFloor: shown('Порог выплаты для цикла сделок, %', String(MIN_CYCLE_PAYOUT_PCT)),
  label: shown('Длительность сделки, подпись', '⏱ 15 с'),
  subject: shown('Актив и длительность', 'EUR/USD OTC · ⏱ 15 с'),
  reason: shown('Причина «сигнала нет»', 'тренд не определён'),
  value: shown('Значение строки анализа', 'вверх — EMA9 1.08542 выше EMA21 1.08511'),
  price: shown('Последняя цена', '1.08560'),
  seconds: shown('Секунды до повтора', '7'),
  line: shown('Строка сделки или сессии', 'EUR/USD OTC · ⬆️ Вверх · ⏱ 15 с · ставка $1.00'),
  assetId: shown('Номер актива у брокера', '42'),
  digits: shown('Допустимое число знаков после запятой', '2'),
  step: shown('Номер сделки из всех', '3 из 5'),
  score: shown('Счёт сессии', '1 в плюс, 1 в минус, 1 в ноль'),
  profit: variable({
    description: 'Результат сессии в $, со знаком',
    sample: formatSignedUsd('2.5'),
    format: (amount: DecimalString) => formatSignedUsd(amount),
  }),
  result: shown('Итог сессии', '5 сделок — 3 в плюс, 2 в минус'),
  trades: shown('Число сделок со словом', '5 сделок'),
  action: shown('Направление сделки, с суммой, когда она известна', '⬆️ Вверх'),
} as const;

export type BotTextVars = typeof BOT_TEXT_VARS;
export type BotTextVarName = keyof BotTextVars;
