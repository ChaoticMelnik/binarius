import {
  formatAge,
  formatCount,
  formatPaymentDate,
  formatSignedUsd,
  formatStake,
  formatTokensRate,
  formatUsd,
} from './bot-text-format';
import type { BotTextVariable } from './bot-text-template';
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
  | 'levelOff'
  | 'ageSecondsUnit'
  | 'ageMinutesUnit';

export interface BotTextVar<I> extends BotTextVariable<I> {
  format(input: I, texts: (key: BotTextVarFallbackKey) => string): string;
}

const variable = <I>(definition: BotTextVar<I>): BotTextVar<I> => definition;
// a value the caller has already put into words from the catalog and its data, printed as is
const shown = (description: string, sample: string): BotTextVar<string> =>
  variable({ description, sample, format: (value: string) => value });

// The user's trading mode as the card's header, the mode screen and the stake button print it
// (#24, #121). Data, not a text: it stays out of the catalog.
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
  purchasedTokens: variable({
    description: 'Токены пакета покупки',
    sample: '150',
    format: (count: string) => formatCount(count),
  }),
  tokenBalance: variable({
    description: 'Баланс токенов после начисления',
    sample: '162',
    format: (count: string) => formatCount(count),
  }),
  stars: variable({
    description: 'Цена пакета в Telegram Stars',
    sample: '250',
    format: (count: string) => formatCount(count),
  }),
  paymentDate: variable({
    description: 'Дата и время оплаты Stars (МСК)',
    sample: '15.10.2026 10:57',
    format: (unixSeconds: number) => formatPaymentDate(unixSeconds),
  }),
  sessionEnd: variable({
    description: 'Дата и время окончания сессии (МСК)',
    sample: '12.10.2026 21:32',
    format: (unixSeconds: number) => formatPaymentDate(unixSeconds),
  }),
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
    description:
      'Сумма сделки: в карточке и на экране запуска — в режиме пользователя (реальный — своя или минимум брокера); на экране суммы, при сохранении и в /settings — своего режима; в сделке сессии — её ставка',
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
  realAvailable: variable({
    description: 'Доступно на реальном счёте, как на экране суммы',
    sample: formatStake('100'),
    format: (amount: DecimalString) => formatStake(amount),
  }),
  age: variable({
    description: 'Возраст снимка баланса',
    sample: '5 мин',
    format: (seconds: number, texts) =>
      formatAge(seconds, { seconds: texts('ageSecondsUnit'), minutes: texts('ageMinutesUnit') }),
  }),
  amount: shown('Сумма этой строки, как в исходном тексте', formatUsd('10000')),
  count: shown('Число этой строки (свечи, сделки, сессии)', '12'),
  required: shown('Сколько закрытых свечей нужно индикатору карточки анализа', '200'),
  symbol: shown('Пара: символ брокера без « OTC»', 'EUR/USD'),
  group: shown('Тип актива', '💱 Валюты'),
  page: shown('Номер страницы списка', '2'),
  pageCount: shown('Число страниц списка', '4'),
  payout: shown('Выплата актива, %', '92'),
  breakEven: shown('Безубыточность при выплате актива: доля верных прогнозов, %', '55.6'),
  noSignalCandles: shown('Лимит ожидания сигнала сессией: число свечей со словом', '20 свечей'),
  candleSec: shown('Длина свечи сигнала сессии, с', '5'),
  label: shown('Длительность сделки, подпись', '⏱ 5 с'),
  durationSec: shown('Длительность сделки в секундах — вне списка демо', '60'),
  duration: shown('Время экспирации сделки сессии', '5 с'),
  subject: shown('Актив и длительность', 'EUR/USD · ⏱ 5 с'),
  value: shown('Значение строки анализа', 'вверх — EMA9 1.08542 выше EMA21 1.08511'),
  price: shown('Последняя цена', '1.08560'),
  line: shown('Строка сделки или сессии', 'EUR/USD · ⬆️ Вверх · ⏱ 5 с · ставка $1.00'),
  assetId: shown('Номер актива у брокера', '42'),
  digits: shown('Допустимое число знаков после запятой', '2'),
  step: shown('Номер сделки в цикле, в сообщении сделки сессии', '2'),
  cycle: shown('Номер цикла сделок сессии: серия до выигрыша', '3'),
  cycles: shown('Число циклов со словом', '5 циклов'),
  outcome: variable({
    description:
      'Сделка сессии после «→»: выигрыш — ставка + прибыль со знаком плюс (сколько вернулось на счёт), проигрыш — потеря со знаком минус, ничья — $0.00; итог сессии «💰 Результат» остаётся чистым результатом',
    sample: formatSignedUsd('22.08'),
    format: (amount: DecimalString) => formatSignedUsd(amount),
  }),
  openPrice: shown('Цена открытия сделки, со знаками пары', '0.49803'),
  closePrice: shown('Цена закрытия сделки, со знаками пары', '0.49820'),
  score: shown('Счёт сессии', '1 в плюс, 1 в минус, 1 в ноль'),
  profit: variable({
    description: 'Результат сессии в $, со знаком',
    sample: formatSignedUsd('2.5'),
    format: (amount: DecimalString) => formatSignedUsd(amount),
  }),
  result: shown('Итог сессии', '8 сделок — 5 в плюс, 3 в минус'),
  trades: shown('Число сделок со словом', '5 сделок'),
  action: shown('Направление сделки, с суммой, когда она известна', '⬆️ Вверх'),
  botUsername: shown('Имя бота в Telegram, без @', 'binarius_bot'),
  referralLink: shown(
    'Ссылка-приглашение пользователя',
    'https://t.me/binarius_bot?start=ref_AbC123xY',
  ),
  connected: shown('Сколько приглашённых подключили партнёрский аккаунт Binodex', '2'),
  earnedTokens: variable({
    description: 'Токены, полученные за приглашения',
    sample: '100',
    format: (count: string) => formatCount(count),
  }),
  rewardTokens: variable({
    description: 'Токены награды за одного приглашённого',
    sample: '50',
    format: (count: string) => formatCount(count),
  }),
  pairs: shown('Пары с текущим решением сканера H1, число со словом', '115 пар'),
  checks: variable({
    description: 'Проверок сканера H1 в минуту: пары × 60',
    sample: '6900',
    format: (count: string) => formatCount(count),
  }),
  quotes: shown('Значок этапа «Котировки»: ✅ пока источник котировок стримит', '✅'),
  moves: shown('Значок этапа «Движение цены»: ✅ пока есть решения на текущей секунде', '✅'),
  closest: shown(
    'До трёх пар, ближайших к порогу сигнала, с процентом от порога',
    'GBP/USD 82 % · EUR/USD 71 % · USD/JPY 60 %',
  ),
  pct: shown('Движение пары на последней секунде, % от порога сигнала H1 (0–99)', '82'),
  nudgeTokens: variable({
    description: 'Порог баланса напоминания о токенах',
    sample: '50',
    format: (count: string) => formatCount(count),
  }),
  sessions: shown('Число демо-сессий пользователя со словом', '3 демо-сессии'),
  date: shown('Дата суток карточки итогов дня, дд.мм.гггг', '30.10.2026'),
  tokensPerUsd: variable({
    description: 'Токенов за каждый $1 пополнения, из действующего правила бонуса за пополнение',
    sample: '0.5',
    format: (amount: DecimalString) => formatTokensRate(amount),
  }),
  minAmountUsd: variable({
    description: 'Минимальная сумма пополнения для бонуса, из действующего правила',
    sample: formatStake('10'),
    // every fraction digit, as a stake: a cut minimum would name a sum that earns nothing
    format: (amount: DecimalString) => formatStake(amount),
  }),
  maxTokens: variable({
    description: 'Не больше стольких токенов за одно пополнение, из действующего правила',
    sample: '500',
    format: (amount: DecimalString) => formatTokensRate(amount),
  }),
} as const;

export type BotTextVars = typeof BOT_TEXT_VARS;
export type BotTextVarName = keyof BotTextVars;
