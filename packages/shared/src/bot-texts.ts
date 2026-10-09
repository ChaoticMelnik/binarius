import {
  botHtmlText,
  botPlainText,
  botTextEntryProblems,
  createBotTextViews,
  type BotHtmlKeyOf,
  type BotHtmlTextsOf,
  type BotPlainKeyOf,
  type BotPlainTextsOf,
  type BotTextOptions,
  type BotTextProblem,
  type BotTextSamplesOf,
  type BotTextSource,
  type BotTextVariables,
  type BotTextViews,
} from './bot-text-template';
import { BOT_TEXT_VARS, type BotTextVarName, type BotTextVars } from './bot-text-vars';
import { TELEGRAM_CAPTION_LIMIT } from './telegram-html';

// Every text the client bot shows, in one place for every process: the bot, the backend's push
// after the OAuth callback, and the admin section that edits them (#300; docs/bot-texts.md). A
// key is a permanent id — overrides are stored under it — and the source here is the default.
// The staff bot and the Mini App pages are not here.

export const BotTextGroup = {
  Start: 'start',
  Card: 'card',
  Account: 'account',
  Menu: 'menu',
  Settings: 'settings',
  Support: 'support',
  Help: 'help',
  Demo: 'demo',
  Analysis: 'analysis',
  Trade: 'trade',
  Session: 'session',
  Buttons: 'buttons',
  Commands: 'commands',
  Profile: 'profile',
} as const;
export type BotTextGroup = (typeof BotTextGroup)[keyof typeof BotTextGroup];

export const BOT_TEXT_GROUP_TITLES = {
  [BotTextGroup.Start]: 'Вход и подключение',
  [BotTextGroup.Card]: 'Карточка аккаунта',
  [BotTextGroup.Account]: '/account',
  [BotTextGroup.Menu]: 'Главное меню и статус',
  [BotTextGroup.Settings]: '/settings',
  [BotTextGroup.Support]: '/support',
  [BotTextGroup.Help]: '/help',
  [BotTextGroup.Demo]: 'Демо: выбор актива',
  [BotTextGroup.Analysis]: 'Анализ',
  [BotTextGroup.Trade]: 'Демо-сделка',
  [BotTextGroup.Session]: 'Демо-сессия',
  [BotTextGroup.Buttons]: 'Кнопки',
  [BotTextGroup.Commands]: 'Команды: описания',
  [BotTextGroup.Profile]: 'Профиль бота',
} as const satisfies Record<BotTextGroup, string>;

// Bot API: a command description 1-256 characters, setMyDescription 0-512, setMyShortDescription
// 0-120.
const COMMAND_LIMIT = 256;
const DESCRIPTION_LIMIT = 512;
const SHORT_DESCRIPTION_LIMIT = 120;

type CatalogOptions<V extends readonly BotTextVarName[]> = Omit<
  BotTextOptions<BotTextVariables>,
  'variables'
> & {
  // the registry's variables every caller of the key holds when it renders (bot-text-vars.ts)
  vars?: V;
};

const variablesOf = <V extends readonly BotTextVarName[]>(
  names: V | undefined,
): Pick<BotTextVars, V[number]> =>
  Object.fromEntries((names ?? []).map((name) => [name, BOT_TEXT_VARS[name]])) as Pick<
    BotTextVars,
    V[number]
  >;

const html = <const G extends string, const V extends readonly BotTextVarName[] = readonly []>(
  group: G,
  description: string,
  source: string,
  { vars, ...options }: CatalogOptions<V> = {},
) => botHtmlText(group, description, source, { ...options, variables: variablesOf(vars) });

const plain = <const G extends string, const V extends readonly BotTextVarName[] = readonly []>(
  group: G,
  description: string,
  source: string,
  { vars, ...options }: CatalogOptions<V> = {},
) => botPlainText(group, description, source, { ...options, variables: variablesOf(vars) });

const g = BotTextGroup;
const caption = { limit: TELEGRAM_CAPTION_LIMIT };
// What a status card's handler holds: the access read and the user's first_name (docs/bot-texts.md
// → Variables); the stake picker's adds the two bounds it shows.
const user = [
  'firstName',
  'tokens',
  'reservedTokens',
  'demoBalance',
  'realBalance',
  'mode',
  'stake',
] as const;
const picker = [...user, 'minStake', 'demoAvailable'] as const;

export const BOT_TEXT_CATALOG = {
  // ---- Вход и подключение -------------------------------------------------------------------
  welcome: html(
    g.Start,
    'Ответ на /start, пока аккаунт не подключён; подпись видео, если оно задано.',
    `🚀 <b>Binarius — торговля на Binodex прямо в Telegram</b>

Подключи аккаунт Binodex по почте, и бот откроет меню.

<b>Главное — автосессия</b>
🤖 Бот сам проводит серию демо-сделок по сигналу, ты смотришь на результат. Это демо: деньги не нужны.

<b>Как подключить</b>
1️⃣ Нажми «{connectButton}» и пришли адрес электронной почты.
2️⃣ Пришли код из письма. Если аккаунта ещё нет, Binodex создаст его.
3️⃣ Готово — аккаунт подключён, бот открывает меню.`,
    { ...caption, fragments: { connectButton: 'connectButton' } },
  ),
  loginLink: html(
    g.Start,
    'Не показывается с #314 (вход через сайт скрыт). После кнопки входа через сайт: сообщение с кнопкой, открывающей вход.',
    `🌐 <b>Вход через сайт Binodex</b>
Открой вход по кнопке ниже, а затем вернись в этот чат.`,
  ),
  unavailable: html(
    g.Start,
    'Любой экран, когда backend не ответил: общий текст сбоя.',
    `⚠️ Сервис временно недоступен. Попробуй позже.`,
  ),
  blocked: html(
    g.Start,
    'Любой экран заблокированного пользователя; также push после входа через сайт.',
    `🔒 Доступ ограничен. Если это ошибка, напиши в поддержку: /support`,
  ),
  confirmPrompt: html(
    g.Start,
    'Новая привязка ждёт подтверждения: на /start и в push после входа через сайт, с кнопкой подтверждения.',
    `🔐 <b>Найдена новая привязка аккаунта Binodex</b>
Если вход выполнял ты — подтверди.`,
  ),
  linkedActive: html(
    g.Start,
    'Push после повторного входа через сайт в уже подтверждённый аккаунт.',
    `✅ <b>Аккаунт Binodex подключён!</b>`,
    { vars: ['email'] },
  ),
  accountTaken: html(
    g.Start,
    'Вход в аккаунт Binodex, уже подключённый к другому пользователю Telegram (по почте и через сайт).',
    `❌ Этот аккаунт Binodex уже подключён к другому пользователю Telegram. Если это ошибка, напиши в поддержку: /support`,
  ),
  oauthLoginFailed: html(
    g.Start,
    'Push, когда вход через сайт не удалось завершить.',
    `❌ Не удалось завершить вход в Binodex. Подключи аккаунт по почте: /start`,
  ),
  confirmNotFound: html(
    g.Start,
    'Нажатие кнопки подтверждения, когда привязки уже нет.',
    `❌ Привязка не найдена. Начни подключение заново через /start.`,
  ),
  confirmAlreadyDone: html(
    g.Start,
    'Нажатие кнопки подтверждения, когда привязка уже подтверждена или больше не ждёт.',
    `❌ Эта привязка уже подтверждена или больше не ждёт подтверждения.`,
  ),
  emailPrompt: html(
    g.Start,
    'Вход по почте: просьба прислать адрес.',
    `📧 <b>Пришли адрес электронной почты</b>
Тот, на который зарегистрирован аккаунт Binodex. Если аккаунта ещё нет, Binodex создаст его на этот адрес.`,
    { vars: ['firstName'] },
  ),
  emailInvalid: html(
    g.Start,
    'Вход по почте: присланное не похоже на адрес.',
    `❌ Это не похоже на адрес электронной почты. Пришли адрес вида name@example.com.`,
  ),
  emailRefused: html(
    g.Start,
    'Вход по почте: Binodex отклонил адрес.',
    `❌ Binodex не принял этот адрес. Проверь его и пришли ещё раз.`,
  ),
  codeSent: html(
    g.Start,
    'Вход по почте: код отправлен, с адресом, который ввёл пользователь.',
    `📩 <b>Код отправлен на {email}</b>
Пришли его сюда одним сообщением.`,
    { vars: ['email', 'firstName'] },
  ),
  codeInvalid: html(
    g.Start,
    'Вход по почте: код неверный или устарел.',
    `❌ Код не подошёл: он неверный или устарел. Пришли код ещё раз или запроси новый.`,
  ),
  tooManyCodeRequests: html(
    g.Start,
    'Вход по почте: исчерпан лимит запросов кода этого пользователя или адреса.',
    `⚠️ Слишком много запросов кода. Подожди несколько минут и начни заново через /start.`,
  ),
  sendCodeBusy: html(
    g.Start,
    'Вход по почте: общий лимит запросов, адрес нужно прислать ещё раз.',
    `⚠️ Сейчас слишком много запросов. Подожди немного и пришли адрес ещё раз.`,
  ),
  loginBusy: html(
    g.Start,
    'Вход по почте: общий лимит запросов, код нужно прислать ещё раз.',
    `⚠️ Сейчас слишком много запросов. Подожди немного и пришли код ещё раз.`,
  ),
  resendRefused: html(
    g.Start,
    'Вход по почте: новый код запросить нельзя, прежний ещё действует.',
    `⚠️ Новый код сейчас запросить нельзя: слишком много запросов. Если письмо с кодом уже пришло — пришли код из него.`,
  ),
  codeSentUnknown: html(
    g.Start,
    'Вход по почте: неизвестно, ушло ли письмо с кодом; с адресом и кнопкой повторного запроса.',
    `⚠️ Не удалось подтвердить отправку кода на {email}.
Если письмо пришло — пришли код из него. Если нет — нажми «{resendButton}».`,
    { vars: ['email', 'firstName'], fragments: { resendButton: 'resendButton' } },
  ),
  tooManyCodeAttempts: html(
    g.Start,
    'Вход по почте: слишком много попыток ввести код.',
    `⚠️ Слишком много попыток ввести код. Подожди несколько минут и начни заново через /start.`,
  ),
  codeRequestStale: html(
    g.Start,
    'Кнопка повторного запроса кода, когда диалог входа уже закончился.',
    `⚠️ Этот запрос кода уже не действует. Если аккаунт ещё не подключён, начни заново через /start.`,
  ),

  // ---- Карточка аккаунта --------------------------------------------------------------------
  cardGreeting: html(
    g.Card,
    'Карточка после подключения: приветствие с именем из Telegram.',
    `🎉 <b>Привет, {firstName}!</b>`,
    { ...caption, vars: ['firstName', 'email'] },
  ),
  cardGreetingNoName: html(
    g.Card,
    'Карточка после подключения: приветствие, когда имя в Telegram пустое.',
    `🎉 <b>Привет!</b>`,
    { ...caption, vars: ['email'] },
  ),
  cardEmail: html(
    g.Card,
    'Карточка после подключения: адрес подключённого аккаунта, если он известен.',
    `📧 Аккаунт Binodex: {email}`,
    { ...caption, vars: ['firstName', 'email'] },
  ),
  cardBody: html(
    g.Card,
    'Карточка после подключения: основной текст с тем, что доступно.',
    `✅ <b>Аккаунт Binodex подключён</b>

<b>Что теперь доступно</b>
{features}
🆘 Если что-то пошло не так — напиши в поддержку: /support`,
    { ...caption, fragments: { features: 'featureLines' }, vars: ['firstName', 'email'] },
  ),
  featureLines: html(
    g.Card,
    'Что умеет бот: вставляется в карточку после подключения и в /help.',
    `🤖 Автосессия за токены: бот сам проводит серию демо-сделок по сигналу, ты смотришь на результат.
🎮 Демо без риска: деньги не нужны, разовая сделка — по желанию.
📊 Баланс, токены и история сделок прямо в этом чате.`,
    caption,
  ),
  cardBonusGranted: html(
    g.Card,
    'Карточка после подключения: начислены стартовые токены.',
    `<blockquote>🎁 Начислено токенов автоторговли: {bonusTokens}</blockquote>`,
    { ...caption, vars: ['bonusTokens', 'firstName', 'email'] },
  ),
  cardBonusNotPartner: html(
    g.Card,
    'Карточка после подключения: аккаунт зарегистрирован не через Binarius, токенов нет.',
    `ℹ️ Стартовые токены начисляются только аккаунтам, зарегистрированным через Binarius.`,
    { ...caption, vars: ['firstName', 'email'] },
  ),
  cardBonusAlready: html(
    g.Card,
    'Карточка после подключения: стартовые токены уже начислялись.',
    `ℹ️ Стартовые токены уже были начислены раньше.`,
    { ...caption, vars: ['firstName', 'email'] },
  ),

  // ---- /account -----------------------------------------------------------------------------
  accountNone: html(
    g.Account,
    '/account без подключённого аккаунта; также /menu и сделка без аккаунта.',
    `❌ <b>Аккаунт Binodex не подключён</b>
Подключи его по почте — кнопка ниже.`,
  ),
  accountConnected: html(
    g.Account,
    '/account: заголовок, когда хотя бы одна привязка активна.',
    `✅ <b>Аккаунт Binodex подключён</b>`,
  ),
  accountPending: html(
    g.Account,
    '/account: заголовок, когда активных нет, а одна ждёт подтверждения.',
    `⏳ <b>Привязка ждёт подтверждения</b>
Если вход выполнял ты — подтверди её по кнопке ниже.`,
  ),
  // Must stay the longest /account header: the M1 test of /account (bot-text-messages.test.ts)
  // pairs it with accountLineRevoked, the longest line, and expects the estimate exactly.
  accountRevoked: html(
    g.Account,
    '/account: заголовок, когда все привязки отозваны; также отказ сделки.',
    `⚠️ <b>Подключение Binodex отозвано</b>
Войди заново по почте: нажми кнопку ниже и пришли адрес.`,
  ),
  accountLineActive: html(
    g.Account,
    '/account: строка активной привязки с адресом.',
    `✅ Подключён: {email}`,
    { vars: ['email'] },
  ),
  accountLinePending: html(
    g.Account,
    '/account: строка привязки, ждущей подтверждения, с адресом.',
    `⏳ Ждёт подтверждения: {email}`,
    { vars: ['email'] },
  ),
  accountLineRevoked: html(
    g.Account,
    '/account: строка отозванной привязки с адресом.',
    `⚠️ Подключение отозвано: {email}`,
    { vars: ['email'] },
  ),
  accountUnknownAddress: plain(
    g.Account,
    '/account: вместо адреса, который брокер не прислал.',
    'адрес неизвестен',
  ),

  // ---- Главное меню и статус ----------------------------------------------------------------
  statusHeader: html(g.Menu, '/menu: заголовок карточки с режимом.', `🎮 <b>Режим: {mode}</b>`, {
    ...caption,
    vars: user,
  }),
  statusReal: html(g.Menu, '/menu: реальный баланс.', `💵 Реальный баланс: {amount}`, {
    ...caption,
    vars: ['amount', ...user],
  }),
  statusDemo: html(g.Menu, '/menu: демобаланс.', `🧪 Демобаланс: {amount}`, {
    ...caption,
    vars: ['amount', ...user],
  }),
  statusTokens: html(g.Menu, '/menu: токены.', `🪙 Токены: {tokens}`, {
    ...caption,
    vars: user,
  }),
  statusReserved: html(
    g.Menu,
    '/menu: на той же строке после токенов, когда часть в резерве.',
    `(в резерве: {reservedTokens})`,
    { ...caption, vars: user },
  ),
  statusStale: html(
    g.Menu,
    '/menu: баланс устарел, с возрастом снимка.',
    `🕒 Баланс Binodex обновлён {age} назад.`,
    { ...caption, vars: ['age'] },
  ),
  statusNoSnapshot: html(
    g.Menu,
    '/menu: баланса ещё нет.',
    `⏳ Баланс Binodex ещё не получен — попробуй /menu через минуту.`,
    { ...caption, vars: user },
  ),
  statusAmbiguous: html(
    g.Menu,
    '/menu: подключено несколько аккаунтов, баланс не выбран; также отказ сделки.',
    `⚠️ Подключено несколько аккаунтов Binodex, баланс не выбран — напиши в поддержку: /support`,
    caption,
  ),
  statusHint: html(
    g.Menu,
    '/menu: подсказка внизу карточки.',
    `💡 Автосессия: бот сам проводит серию демо-сделок — деньги не нужны.`,
    { ...caption, vars: user },
  ),
  balanceUnavailable: plain(
    g.Menu,
    'Вместо {demoBalance} и {realBalance}, когда свежего снимка баланса нет.',
    'нет свежих данных',
  ),

  // ---- /settings ----------------------------------------------------------------------------
  settings: html(
    g.Settings,
    '/settings: текст над кнопками уровня уведомлений, с выбранным уровнем и легендой.',
    `🔔 <b>Уведомления</b>
Так бот присылает напоминания и подсказки — например, когда ты ещё не начал демо.
Ответы на твои команды и итоги твоих сделок приходят всегда.

Сейчас выбрано: <b>{level}</b>

{levelAll} — каждое напоминание.
{levelReduced} — не чаще одного в день.
{levelOff} — никаких напоминаний.`,
    {
      vars: ['level', 'stake', 'firstName'],
      fragments: { levelAll: 'levelAll', levelReduced: 'levelReduced', levelOff: 'levelOff' },
    },
  ),
  levelAll: plain(g.Settings, '/settings: кнопка и строка легенды «все напоминания».', '🔔 Все'),
  levelReduced: plain(
    g.Settings,
    '/settings: кнопка и строка легенды «не чаще раза в день».',
    '🔕 Реже',
  ),
  levelOff: plain(
    g.Settings,
    '/settings: кнопка и строка легенды «без напоминаний».',
    '❌ Выключить',
  ),
  settingsStake: html(
    g.Settings,
    '/settings: строка с суммой демо-сделки под уровнями уведомлений.',
    `💵 Сумма демо-сделки: <b>{stake}</b>`,
    { vars: ['level', 'stake', 'firstName'] },
  ),
  stakeMinimumLabel: plain(
    g.Settings,
    'Сумма демо-сделки не выбрана: так она называется в /settings, на экране суммы и после сброса.',
    'минимальная ставка брокера',
  ),

  // ---- /support -----------------------------------------------------------------------------
  support: html(
    g.Support,
    '/support: текст над кнопкой чата с поддержкой.',
    `🆘 <b>Поддержка</b>
Если что-то пошло не так или есть вопрос — напиши нам.
👇 Нажми кнопку ниже, откроется чат с поддержкой.`,
  ),

  // ---- /help --------------------------------------------------------------------------------
  helpAbout: html(
    g.Help,
    '/help: первый блок, что умеет бот.',
    `ℹ️ <b>Что умеет Binarius</b>
{features}`,
    { fragments: { features: 'featureLines' } },
  ),
  helpConnect: html(
    g.Help,
    '/help: как подключить аккаунт, с названием кнопки /start.',
    `<b>Как подключить аккаунт Binodex</b>
Если аккаунт ещё не подключён, нажми /start, затем «{connectButton}».
📧 Пришли адрес электронной почты и код из письма. Если аккаунта ещё нет, Binodex создаст его.`,
    { fragments: { connectButton: 'connectButton' } },
  ),
  helpCommands: html(
    g.Help,
    '/help: заголовок списка команд; строки команд — описания из группы «Команды».',
    `<b>Команды</b>`,
  ),

  // ---- Демо: выбор актива -------------------------------------------------------------------
  demoGroups: html(
    g.Demo,
    'Демо: выбор типа актива.',
    `🎮 <b>Демо-сделка</b>
Выбери тип актива. Это демо: деньги не нужны.`,
  ),
  demoPairsHeader: html(
    g.Demo,
    'Демо: список активов типа, с названием типа.',
    `🎮 <b>Демо-сделка</b> · {group}
Выбери актив. Число на кнопке — выплата при верном прогнозе, не вероятность.`,
    { vars: ['group'] },
  ),
  demoPage: html(g.Demo, 'Демо: строка страницы списка активов.', `Страница {page}`, {
    vars: ['page'],
  }),
  demoGroupClosed: html(
    g.Demo,
    'Демо: все активы типа закрыты по расписанию.',
    `🔒 <b>{group}: сейчас всё закрыто по расписанию</b>
Выбери другой тип актива.`,
    { vars: ['group'] },
  ),
  demoAsset: html(g.Demo, 'Демо: строка выбранного актива.', `🎯 Актив: {symbol}`, {
    vars: ['symbol'],
  }),
  demoPayout: html(
    g.Demo,
    'Демо и анализ: строка выплаты актива.',
    `💰 Выплата: {payout}% — размер выигрыша при верном прогнозе, не вероятность. Безубыточность: {breakEven}% верных прогнозов.`,
    { vars: ['payout', 'breakEven'] },
  ),
  demoChooseDuration: html(
    g.Demo,
    'Демо: просьба выбрать длительность.',
    `Выбери длительность сделки.`,
  ),
  demoDurationLine: html(
    g.Demo,
    'Демо: строка выбранной длительности.',
    `⏱ Длительность: {label}`,
    {
      vars: ['label'],
    },
  ),
  demoNext: html(
    g.Demo,
    'Демо: под выбранными активом и длительностью, перед анализом.',
    `Дальше — анализ свечей, а за ним кнопка автосессии: бот сам проведёт серию сделок по сигналу.`,
  ),
  demoSignalsHeader: html(
    g.Demo,
    'Демо: экран «Сигналы сейчас» над кнопками пар (#320).',
    `📡 <b>Сигналы сейчас</b> · сделка 15 с
Выбери пару — бот запустит цикл сделок. Сигнал действует одну 15-секундную свечу; перед каждой сделкой бот проверяет его заново.`,
  ),
  demoSignalsEmpty: html(
    g.Demo,
    'Демо: на экране «Сигналы сейчас» нет ни одной пары с сигналом.',
    `📡 Сейчас сигналов нет — обнови через несколько секунд или выбери пару вручную.`,
  ),
  launchHeader: html(g.Demo, 'Экран ставки: пара и длительность цикла.', `🎯 <b>{subject}</b>`, {
    vars: ['subject', 'firstName', 'stake'],
  }),
  launchStake: html(g.Demo, 'Экран ставки: сумма каждой сделки цикла.', `💵 Ставка: {stake}`, {
    vars: ['stake', 'firstName'],
  }),
  launchStakeMinimum: html(
    g.Demo,
    'Экран ставки: сумма не прочитана — будет минимальная ставка брокера.',
    `💵 Ставка: минимальная брокера`,
    { vars: ['firstName', 'stake'] },
  ),
  launchCycle: html(
    g.Demo,
    'Экран ставки: что сделает цикл, с числом сделок.',
    `🤖 Бот проведёт {trades} подряд и перед каждой проверит сигнал. Это демо: деньги не нужны.`,
    { vars: ['trades', 'firstName', 'stake'] },
  ),
  demoCatalogUnavailable: html(
    g.Demo,
    'Демо: каталог активов недоступен.',
    `⚠️ Каталог активов сейчас недоступен. Попробуй через минуту.`,
  ),
  demoNoShortPairs: html(
    g.Demo,
    'Демо: в каталоге нет активов, принимающих 5 или 15 секунд.',
    `Сейчас нет активов для коротких сделок.`,
  ),
  demoCatalogStale: html(
    g.Demo,
    'Демо: каталог активов обновляется.',
    `⏳ Каталог активов обновляется. Попробуй через минуту.`,
  ),
  demoPairMissing: html(
    g.Demo,
    'Демо: выбранного актива больше нет.',
    `❌ Этот актив больше не доступен. Выбери другой.`,
  ),
  demoPairClosed: html(
    g.Demo,
    'Демо: выбранный актив закрыт по расписанию.',
    `🔒 {symbol} сейчас закрыт по расписанию. Выбери другой актив.`,
    { vars: ['symbol'] },
  ),
  demoPayoutTooLow: html(
    g.Demo,
    'Сигналы сейчас: выплата пары ниже порога цикла сделок.',
    `🚫 {symbol}: выплата {payout}% — ниже {payoutFloor}%, цикл на этой паре не запускается. Безубыточность при такой выплате — {breakEven}% верных прогнозов.`,
    { vars: ['symbol', 'payout', 'payoutFloor', 'breakEven'] },
  ),
  demoDurationUnsupported: html(
    g.Demo,
    'Демо: выбранная длительность не подходит активу.',
    `❌ Эта длительность не подходит для {symbol}. Выбери другую.`,
    { vars: ['symbol'] },
  ),
  demoNoDuration: html(
    g.Demo,
    'Демо: у актива нет подходящей длительности.',
    `❌ Для {symbol} нет подходящей длительности. Выбери другой актив.`,
    { vars: ['symbol'] },
  ),
  demoGroupCurrency: plain(
    g.Demo,
    'Демо: тип актива «валюты», на кнопке и в заголовке.',
    '💱 Валюты',
  ),
  demoGroupCommodity: plain(
    g.Demo,
    'Демо: тип актива «сырьё», на кнопке и в заголовке.',
    '🛢 Сырьё',
  ),
  demoGroupStock: plain(g.Demo, 'Демо: тип актива «акции», на кнопке и в заголовке.', '📈 Акции'),
  demoGroupCryptocurrency: plain(
    g.Demo,
    'Демо: тип актива «криптовалюты», на кнопке и в заголовке.',
    '💠 Криптовалюты',
  ),
  demoGroupIndex: plain(
    g.Demo,
    'Демо: тип актива «индексы», на кнопке и в заголовке.',
    '📊 Индексы',
  ),
  demoGroupOther: plain(g.Demo, 'Демо: прочие активы, на кнопке и в заголовке.', '📁 Другие'),
  demoDuration5: plain(g.Demo, 'Демо: длительность 5 секунд, на кнопке и в строках.', '⏱ 5 с'),
  demoDuration15: plain(g.Demo, 'Демо: длительность 15 секунд, на кнопке и в строках.', '⏱ 15 с'),

  // ---- Анализ -------------------------------------------------------------------------------
  analyzing: html(g.Analysis, 'Анализ: пока бот ждёт ответа.', `⏳ Анализирую {subject}…`, {
    vars: ['subject'],
  }),
  analysisHeader: html(
    g.Analysis,
    'Анализ: заголовок с активом и длительностью.',
    `📊 <b>Анализ: {subject}</b>`,
    { vars: ['subject'] },
  ),
  analysisSignalUp: html(g.Analysis, 'Анализ: сигнал вверх.', `📈 <b>Сигнал: {actionUp}</b>`, {
    fragments: { actionUp: 'actionUp' },
  }),
  analysisSignalDown: html(g.Analysis, 'Анализ: сигнал вниз.', `📉 <b>Сигнал: {actionDown}</b>`, {
    fragments: { actionDown: 'actionDown' },
  }),
  analysisNoSignal: html(
    g.Analysis,
    'Анализ: сигнала нет, с причиной.',
    `⏸ <b>Сигнала нет: {reason}</b>`,
    { vars: ['reason'] },
  ),
  analysisTrend: html(g.Analysis, 'Анализ: строка тренда.', `📐 Тренд по EMA: {value}`, {
    vars: ['value'],
  }),
  analysisMomentum: html(g.Analysis, 'Анализ: строка импульса.', `⚡ Импульс по RSI: {value}`, {
    vars: ['value'],
  }),
  analysisVolatility: html(
    g.Analysis,
    'Анализ: строка волатильности.',
    `🌊 Волатильность по ATR: {value}`,
    { vars: ['value'] },
  ),
  analysisCandles: html(
    g.Analysis,
    'Анализ: число закрытых свечей.',
    `🕯 Закрытых свечей: {count}`,
    {
      vars: ['count'],
    },
  ),
  analysisLastPrice: html(g.Analysis, 'Анализ: последняя цена.', `💲 Последняя цена: {price}`, {
    vars: ['price'],
  }),
  analysisCycleUnavailable: html(
    g.Analysis,
    'Анализ: под сигналом на паре с выплатой ниже порога цикла — кнопки сессии нет.',
    `🚫 Цикл на этой паре не запускается: выплата ниже {payoutFloor}%.`,
    { vars: ['payoutFloor'] },
  ),
  analysisDisclaimer: html(
    g.Analysis,
    'Анализ: оговорка под сигналом.',
    `⚠️ Сигнал — не прогноз результата и не гарантия. Это демо: деньги не нужны.`,
  ),
  analysisNoSignalHint: html(
    g.Analysis,
    'Анализ: подсказка, когда сигнала нет.',
    `Без сигнала разовую сделку бот не предлагает. Автосессия дождётся сигнала сама — или повтори анализ позже.`,
  ),
  analysisDataHint: html(
    g.Analysis,
    'Анализ: подсказка, когда данных по свечам недостаточно.',
    `Повтори анализ через несколько секунд или выбери другой актив.`,
  ),
  analysisRateLimited: html(
    g.Analysis,
    'Анализ: брокер ограничил запросы, с секундами до повтора.',
    `⚠️ Брокер ограничил запросы. Попробуй через {seconds} с.`,
    { vars: ['seconds'] },
  ),
  analysisUnavailable: html(
    g.Analysis,
    'Анализ: свечи у брокера не получены.',
    `⚠️ Не удалось получить свечи у брокера. Попробуй ещё раз.`,
  ),
  actionUp: plain(
    g.Analysis,
    'Направление «вверх»: в сигнале, на кнопке сделки и в строке сделки.',
    '⬆️ Вверх',
  ),
  actionDown: plain(
    g.Analysis,
    'Направление «вниз»: в сигнале, на кнопке сделки и в строке сделки.',
    '⬇️ Вниз',
  ),
  stakeButton: plain(
    g.Analysis,
    'Анализ: кнопка открытия сделки, с направлением.',
    '🚀 Открыть сделку: {action}',
    { vars: ['action'] },
  ),
  sessionStartButton: plain(
    g.Analysis,
    'Анализ и итог сделки: кнопка запуска демо-сессии, с числом сделок.',
    '🚀 Сессия из {trades}',
    { vars: ['trades'] },
  ),
  noSignalVolatilityTooLow: plain(
    g.Analysis,
    'Анализ: причина «нет сигнала» — низкая волатильность.',
    'волатильность слишком низкая',
  ),
  noSignalVolatilityTooHigh: plain(
    g.Analysis,
    'Анализ: причина «нет сигнала» — высокая волатильность.',
    'волатильность слишком высокая',
  ),
  noSignalVolatilityBelowTickFloor: plain(
    g.Analysis,
    'Анализ: причина «нет сигнала» — цена движется на считаные шаги котировки.',
    'цена движется на считаные шаги котировки',
  ),
  noSignalTrendFlat: plain(
    g.Analysis,
    'Анализ: причина «нет сигнала» — тренд не определён.',
    'тренд не определён',
  ),
  noSignalRsiNeutral: plain(
    g.Analysis,
    'Анализ: причина «нет сигнала» — нейтральный импульс.',
    'импульс нейтральный',
  ),
  noSignalTrendMomentumDisagree: plain(
    g.Analysis,
    'Анализ: причина «нет сигнала» — тренд и импульс расходятся.',
    'тренд и импульс расходятся',
  ),
  noSignalRsiOverbought: plain(
    g.Analysis,
    'Анализ: причина «нет сигнала» — RSI слишком высокий для входа вверх.',
    'RSI слишком высокий для входа вверх',
  ),
  noSignalRsiOversold: plain(
    g.Analysis,
    'Анализ: причина «нет сигнала» — RSI слишком низкий для входа вниз.',
    'RSI слишком низкий для входа вниз',
  ),
  noSignalInsufficientCandles: plain(
    g.Analysis,
    'Анализ: причина «нет сигнала» — мало свечей.',
    'данных по свечам пока недостаточно',
  ),
  noSignalCandleGap: plain(
    g.Analysis,
    'Анализ: причина «нет сигнала» — пропуск в свечах.',
    'в свечах есть пропуск',
  ),
  noSignalStale: plain(
    g.Analysis,
    'Анализ: причина «нет сигнала» — свечи отстают.',
    'свечи брокера отстают',
  ),
  noSignalInvalidCandle: plain(
    g.Analysis,
    'Анализ: причина «нет сигнала» — свечи с ошибкой.',
    'свечи пришли с ошибкой',
  ),
  trendUp: plain(g.Analysis, 'Анализ: тренд вверх, в строке тренда.', 'вверх'),
  trendDown: plain(g.Analysis, 'Анализ: тренд вниз, в строке тренда.', 'вниз'),
  trendFlat: plain(g.Analysis, 'Анализ: тренд не определён, в строке тренда.', 'не определён'),
  momentumUp: plain(g.Analysis, 'Анализ: импульс вверх, в строке импульса.', 'вверх'),
  momentumDown: plain(g.Analysis, 'Анализ: импульс вниз, в строке импульса.', 'вниз'),
  momentumNeutral: plain(
    g.Analysis,
    'Анализ: нейтральный импульс, в строке импульса.',
    'нейтральный',
  ),
  volatilityNormal: plain(
    g.Analysis,
    'Анализ: волатильность в норме, в строке волатильности.',
    'в норме',
  ),
  volatilityLow: plain(
    g.Analysis,
    'Анализ: низкая волатильность, в строке волатильности.',
    'слишком низкая',
  ),
  volatilityHigh: plain(
    g.Analysis,
    'Анализ: высокая волатильность, в строке волатильности.',
    'слишком высокая',
  ),
  volatilityTickFloor: plain(
    g.Analysis,
    'Анализ: ATR меньше порога в шагах котировки, в строке волатильности.',
    'меньше порога в шагах котировки',
  ),
  analysisAtrTicks: plain(
    g.Analysis,
    'Анализ: ATR в шагах котировки, в строке волатильности.',
    '{count} шагов котировки',
    { vars: ['count'] },
  ),
  emaAbove: plain(g.Analysis, 'Анализ: быстрая EMA выше медленной, в строке тренда.', 'выше'),
  emaBelow: plain(g.Analysis, 'Анализ: быстрая EMA ниже медленной, в строке тренда.', 'ниже'),
  emaEqual: plain(g.Analysis, 'Анализ: быстрая EMA равна медленной, в строке тренда.', 'равна'),

  // ---- Демо-сделка --------------------------------------------------------------------------
  intentHeader: html(g.Trade, 'Сделка: заголовок сообщения статуса.', `🎮 <b>Демо-сделка</b>`),
  intentTrade: html(
    g.Trade,
    'Сделка: строка с активом, направлением, длительностью и ставкой.',
    `📈 {line}`,
    { vars: ['line'] },
  ),
  intentAssetFallback: plain(
    g.Trade,
    'Сделка: вместо названия актива, когда каталог его не знает.',
    'актив #{assetId}',
    { vars: ['assetId'] },
  ),
  intentStake: plain(g.Trade, 'Сделка: ставка в строке сделки.', 'ставка {amount}', {
    vars: ['amount'],
  }),
  intentQueued: html(
    g.Trade,
    'Сделка: заявка создана и ждёт отправки.',
    `⏳ Заявка создана и ждёт отправки брокеру…`,
  ),
  intentSubmitting: html(g.Trade, 'Сделка: заявка отправляется.', `📤 Отправляем заявку брокеру…`),
  intentAccepted: html(g.Trade, 'Сделка: открыта у брокера.', `✅ Сделка открыта у брокера.`),
  intentSettled: html(g.Trade, 'Сделка: закрыта.', `🏁 Сделка закрыта.`),
  intentUnknown: html(
    g.Trade,
    'Сделка: результат уточняется у брокера.',
    `🔎 Результат сделки уточняется у брокера. Токен пока зарезервирован.`,
  ),
  intentManualReview: html(
    g.Trade,
    'Сделка: на ручной проверке.',
    `🛠 Сделка на ручной проверке — напиши в поддержку: /support`,
  ),
  intentRejectedNotConfigured: html(
    g.Trade,
    'Сделка отклонена: исполнение не подключено.',
    `⚠️ Сделка не отправлена: исполнение сделок ещё не подключено. Токен возвращён.`,
  ),
  intentRejectedExpired: html(
    g.Trade,
    'Сделка отклонена: заявку не успели отправить.',
    `⚠️ Заявку не успели отправить вовремя. Токен возвращён.`,
  ),
  intentRejectedByBroker: html(
    g.Trade,
    'Сделка отклонена брокером.',
    `❌ Брокер отклонил сделку. Токен возвращён.`,
  ),
  intentRejectedPublishFailed: html(
    g.Trade,
    'Сделка отклонена: заявка не дошла до исполнителя.',
    `⚠️ Заявка не дошла до исполнителя. Токен возвращён.`,
  ),
  intentRejectedNotFound: html(
    g.Trade,
    'Сделка отклонена: брокер её не открыл.',
    `❌ Брокер сделку не открыл. Токен возвращён.`,
  ),
  intentRejectedManual: html(
    g.Trade,
    'Сделка отклонена при ручной проверке.',
    `❌ Сделка отклонена при ручной проверке. Токен возвращён.`,
  ),
  intentRejectedPaused: html(
    g.Trade,
    'Сделка отклонена: торговля приостановлена общим выключателем.',
    `⏸ Торговля временно приостановлена, попробуйте позже. Токен возвращён.`,
  ),
  intentRejected: html(
    g.Trade,
    'Сделка отклонена по любой другой причине.',
    `❌ Сделка не открыта. Токен возвращён.`,
  ),
  intentDeadline: html(
    g.Trade,
    'Сделка: под статусом, когда бот перестал его обновлять, с названием кнопки обновления.',
    `⏳ Сделка всё ещё обрабатывается — нажми «{refreshIntentButton}» чуть позже.`,
    { fragments: { refreshIntentButton: 'refreshIntentButton' } },
  ),
  intentSessionOffer: html(
    g.Trade,
    'Итог сделки: предложение запустить сессию, с числом сделок.',
    `🤖 Дальше бот может торговать сам: сессия из {trades} на этой паре, сигнал он проверяет перед каждой сделкой.`,
    { vars: ['trades'] },
  ),
  intentStatusUnavailable: html(
    g.Trade,
    'Сделка: статус недоступен.',
    `⚠️ Статус сделки недоступен.`,
  ),
  stakeBalanceMissing: html(
    g.Trade,
    'Кнопка сделки: баланс ещё не получен.',
    `⏳ Баланс Binodex ещё не получен — попробуй через минуту.`,
  ),
  stakeActiveIntent: html(
    g.Trade,
    'Кнопка сделки: предыдущая сделка не завершена.',
    `⏳ Предыдущая сделка ещё не завершена. Дождись её результата.`,
  ),
  tradingPaused: html(
    g.Trade,
    'Кнопка сделки: торговля приостановлена общим выключателем.',
    `⏸ Торговля временно приостановлена, попробуйте позже.`,
  ),
  stakeButtonUsed: html(
    g.Trade,
    'Кнопка сделки: уже использована.',
    `⚠️ Эта кнопка уже использована. Открой анализ заново.`,
  ),
  stakeInsufficientTokens: html(
    g.Trade,
    'Кнопка сделки: не хватает токенов.',
    `🪙 Не хватает токенов для сделки.`,
  ),
  stakeAccountNotConfirmed: html(
    g.Trade,
    'Кнопка сделки: привязка ждёт подтверждения.',
    `⏳ Привязка Binodex ждёт подтверждения — открой /account.`,
  ),
  stakeAccountHalted: html(
    g.Trade,
    'Кнопка сделки: торговля по аккаунту остановлена.',
    `⛔ Торговля по аккаунту остановлена — напиши в поддержку: /support`,
  ),
  stakeOutcomeUnknown: html(
    g.Trade,
    'Кнопка сделки: неизвестно, принята ли заявка.',
    `⚠️ Не удалось узнать, принята ли заявка. Нажми кнопку сделки ещё раз — вторая сделка от этого не откроется.`,
  ),
  stakeAmountChanged: html(
    g.Trade,
    'Кнопка сделки: сумма изменилась после того, как кнопка была нарисована.',
    `⚠️ Сумма сделки изменилась — открой анализ заново.`,
  ),
  stakeBelowMinimum: html(
    g.Trade,
    'Сумма меньше минимальной ставки брокера: на кнопке сделки и при сохранении суммы.',
    `⚠️ Минимальная ставка брокера сейчас {minStake}. Выбери сумму не меньше.`,
    { vars: ['minStake'] },
  ),
  stakeBelowBrokerMinimum: html(
    g.Trade,
    'Старт сессии: сохранённая сумма меньше минимальной ставки брокера.',
    `⚠️ Сохранённая сумма меньше минимальной ставки брокера. Выбери сумму заново.`,
  ),
  stakeAboveAvailable: html(
    g.Trade,
    'Кнопка сделки и старт сессии: сумма больше доступного демо-баланса.',
    `⚠️ На демо-счёте недостаточно средств для этой суммы. Выбери сумму поменьше.`,
  ),
  stakeAboveAvailableAmount: html(
    g.Trade,
    'Сохранение суммы: сумма больше доступного демо-баланса.',
    `⚠️ На демо-счёте доступно {demoAvailable}. Выбери сумму поменьше.`,
    { vars: ['demoAvailable', 'minStake'] },
  ),
  stakePrecision: html(
    g.Trade,
    'Кнопка сделки и старт сессии: в сумме больше знаков после запятой, чем допускает брокер.',
    `⚠️ В сумме слишком много знаков после запятой. Выбери сумму заново.`,
  ),
  stakePrecisionDigits: html(
    g.Trade,
    'Сохранение суммы: слишком много знаков после запятой, с допустимым числом.',
    `❌ Не больше {digits} знаков после запятой.`,
    { vars: ['digits', 'minStake', 'demoAvailable'] },
  ),
  stakePickerHeader: html(g.Trade, 'Экран суммы: заголовок.', `💵 <b>Сумма демо-сделки</b>`, {
    vars: picker,
  }),
  stakePickerCurrent: html(g.Trade, 'Экран суммы: выбранная сейчас сумма.', `Сейчас: {amount}`, {
    vars: ['amount', ...picker],
  }),
  stakePickerMinimum: html(
    g.Trade,
    'Экран суммы: минимальная ставка брокера.',
    `Минимум брокера: {minStake}`,
    { vars: picker },
  ),
  stakePickerAvailable: html(
    g.Trade,
    'Экран суммы: доступный демо-баланс.',
    `Доступно: {demoAvailable}`,
    {
      vars: picker,
    },
  ),
  stakePickerNoPresets: html(
    g.Trade,
    'Экран суммы: демо-баланса не хватает даже на минимальную ставку.',
    `На демо-счёте недостаточно средств даже для минимальной ставки.`,
    { vars: picker },
  ),
  stakeInputPrompt: html(
    g.Trade,
    'Экран суммы: просьба прислать свою сумму текстом.',
    `✏️ Пришли сумму демо-сделки числом, например 5 или 2,50.`,
  ),
  stakeInputInvalid: html(
    g.Trade,
    'Своя сумма: присланное не похоже на сумму.',
    `❌ Введи сумму числом, например 5 или 2,50.`,
  ),
  stakeSaved: html(g.Trade, 'Сумма сохранена.', `✅ Сумма: {stake}`, {
    vars: ['stake', 'firstName'],
  }),
  stakeSavedLine: html(
    g.Trade,
    'Экран ставки: строка над экраном после сохранения суммы.',
    `✅ Ставка сохранена: {stake}`,
    { vars: ['stake', 'firstName'] },
  ),
  stakeSaveUnknown: html(
    g.Trade,
    'Сумма: неизвестно, сохранилась ли она.',
    `⚠️ Не удалось сохранить сумму — попробуй ещё раз.`,
  ),
  // ---- Демо-сессия --------------------------------------------------------------------------
  sessionHeader: html(g.Session, 'Сессия: заголовок сообщения статуса.', `🎮 <b>Демо-сессия</b>`),
  sessionSettings: html(
    g.Session,
    'Сессия: строка с активом, длительностью и ставкой.',
    `📈 {line}`,
    { vars: ['line'] },
  ),
  sessionStep: html(g.Session, 'Сессия: номер текущей сделки из всех.', `🔢 Сделка {step}`, {
    vars: ['step'],
  }),
  sessionScore: html(
    g.Session,
    'Сессия: счёт закрытых сделок, пока сессия идёт.',
    `📊 Счёт: {score}`,
    {
      vars: ['score'],
    },
  ),
  sessionWon: plain(g.Session, 'Сессия: число сделок в плюс, в счёте и итоге.', '{count} в плюс', {
    vars: ['count'],
  }),
  sessionLost: plain(
    g.Session,
    'Сессия: число сделок в минус, в счёте и итоге.',
    '{count} в минус',
    {
      vars: ['count'],
    },
  ),
  sessionTied: plain(
    g.Session,
    'Сессия: число сделок в ноль; показывается, только когда такие есть.',
    '{count} в ноль',
    { vars: ['count'] },
  ),
  sessionTradeOne: plain(g.Session, 'Сессия: слово после числа 1, 21, 31… («1 сделка»).', 'сделка'),
  sessionTradeFew: plain(
    g.Session,
    'Сессия: слово после числа 2–4, 22–24… («3 сделки»).',
    'сделки',
  ),
  sessionTradeMany: plain(
    g.Session,
    'Сессия: слово после остальных чисел («5 сделок», «11 сделок»).',
    'сделок',
  ),
  sessionWaitingSignal: html(
    g.Session,
    'Сессия: пока следующая сделка не открыта.',
    `🔎 Ждём сигнал для следующей сделки…`,
  ),
  sessionCompleted: html(
    g.Session,
    'Сессия: итог, когда все сделки сыграны.',
    `🏁 Сессия завершена: {result}`,
    { vars: ['result'] },
  ),
  sessionTotal: html(g.Session, 'Сессия: итог под причиной остановки.', `📊 Итог: {result}`, {
    vars: ['result'],
  }),
  sessionOpenTradePlaysOut: html(
    g.Session,
    'Сессия остановлена, а последняя сделка ещё идёт.',
    `⏳ Открытая сделка доиграет до конца.`,
  ),
  sessionSettingsUnavailable: html(
    g.Session,
    'Сессия: настройки сессии не прочитаны.',
    `⚠️ Настройки сессии не прочитаны — напиши в поддержку: /support`,
  ),
  sessionDeadline: html(
    g.Session,
    'Сессия: под статусом, когда бот перестал его обновлять, с названием кнопки обновления.',
    `⏳ Сессия ещё идёт — нажми «{sessionRefreshButton}», чтобы увидеть ход.`,
    { fragments: { sessionRefreshButton: 'sessionRefreshButton' } },
  ),
  sessionStatusUnavailable: html(
    g.Session,
    'Сессия: статус недоступен.',
    `⚠️ Статус сессии недоступен.`,
  ),
  sessionJustEnded: html(
    g.Session,
    'Кнопка сессии: прошлая сессия закончилась в момент нажатия.',
    `⏳ Предыдущая сессия только что завершилась. Нажми кнопку ещё раз.`,
  ),
  sessionOutcomeUnknown: html(
    g.Session,
    'Кнопка сессии: неизвестно, запущена ли сессия.',
    `⚠️ Не удалось узнать, запущена ли сессия. Нажми кнопку сессии ещё раз — вторая сессия от этого не запустится.`,
  ),
  sessionInsufficientTokens: html(
    g.Session,
    'Кнопка сессии: не хватает токенов.',
    `🪙 Не хватает токенов: на каждую сделку сессии нужен один токен.`,
  ),
  sessionTooLong: html(
    g.Session,
    'Кнопка сессии: сессия на этой длительности не уложится в час.',
    `⏱ Сессия на этой длительности не уложится в час.`,
  ),
  sessionPairUnavailable: html(
    g.Session,
    'Кнопка сессии: пара недоступна.',
    `⚠️ Пара сейчас недоступна для сессии. Открой анализ заново.`,
  ),
  sessionPayoutTooLow: html(
    g.Session,
    'Кнопка сессии: выплата пары ниже порога цикла сделок.',
    `🚫 Выплата по паре сейчас ниже порога — сессия на ней не запускается. Открой анализ заново.`,
  ),
  sessionStopManualReview: html(
    g.Session,
    'Сессия остановлена: сделка или аккаунт на ручной проверке.',
    `🛠 Сессия остановлена: нужна ручная проверка — напиши в поддержку: /support`,
  ),
  sessionStopRejectedTwice: html(
    g.Session,
    'Сессия остановлена: две сделки подряд не открылись.',
    `❌ Сессия остановлена: две сделки подряд не открылись.`,
  ),
  sessionStopTimeout: html(
    g.Session,
    'Сессия остановлена: истёк час на сессию.',
    `⏱ Сессия остановлена: истёк час на сессию.`,
  ),
  sessionStopStakeStop: html(
    g.Session,
    'Сессия остановлена: ставку не удалось подобрать.',
    `⚠️ Сессия остановлена: ставку не удалось подобрать — проверь демобаланс в /account.`,
  ),
  sessionStopAccountUnavailable: html(
    g.Session,
    'Сессия остановлена: новую сделку открыть нельзя (токены, аккаунт).',
    `⚠️ Сессия остановлена: новую сделку открыть нельзя — проверь токены и аккаунт в /account.`,
  ),
  sessionStopPairUnavailable: html(
    g.Session,
    'Сессия остановлена: пара закрылась или не принимает длительность.',
    `⚠️ Сессия остановлена: пара закрылась или не принимает эту длительность.`,
  ),
  sessionStopBalanceUnavailable: html(
    g.Session,
    'Сессия остановлена: баланс брокера не получен.',
    `⚠️ Сессия остановлена: баланс Binodex не получен.`,
  ),
  sessionStopInvalidSettings: html(
    g.Session,
    'Сессия остановлена: ошибка настроек.',
    `⚠️ Сессия остановлена из-за ошибки настроек — напиши в поддержку: /support`,
  ),
  sessionStopUserStopped: html(
    g.Session,
    'Сессия остановлена кнопкой пользователя.',
    `⏹ Сессия остановлена по твоей команде.`,
  ),

  // ---- Кнопки -------------------------------------------------------------------------------
  confirmButton: plain(
    g.Buttons,
    'Кнопка подтверждения привязки с адресом аккаунта: на /start, в /account и в push.',
    '✅ Подтвердить: {email}',
    { vars: ['email'] },
  ),
  confirmButtonNoEmail: plain(
    g.Buttons,
    'Кнопка подтверждения привязки, когда брокер не прислал адрес.',
    '✅ Подтвердить привязку',
  ),
  connectButton: plain(
    g.Buttons,
    'Кнопка входа по почте под приветствием и в /account; её название цитируют приветствие и /help.',
    '🔗 Подключить аккаунт Binodex',
  ),
  oauthButton: plain(
    g.Buttons,
    'Не показывается с #314 (вход через сайт скрыт). Была кнопкой входа через сайт под приветствием и в /account.',
    '🌐 Войти через сайт Binodex',
  ),
  loginButton: plain(
    g.Buttons,
    'Не показывается с #314 (вход через сайт скрыт). Кнопка, открывающая вход через сайт.',
    '🌐 Войти в Binodex',
  ),
  resendButton: plain(
    g.Buttons,
    'Вход по почте: кнопка повторного запроса кода.',
    '🔄 Запросить код ещё раз',
  ),
  changeEmailButton: plain(g.Buttons, 'Вход по почте: кнопка смены адреса.', '✏️ Изменить адрес'),
  demoButton: plain(
    g.Buttons,
    'Карточка и /menu: вход в демо — экран «Сигналы сейчас».',
    '🎮 Демо-торговля',
  ),
  demoSignalsRefreshButton: plain(
    g.Buttons,
    'Сигналы сейчас: перечитать список пар с сигналом.',
    '🔄 Обновить',
  ),
  demoManualButton: plain(
    g.Buttons,
    'Сигналы сейчас: ручной путь — тип актива, пара, длительность, анализ.',
    '🧭 Выбрать пару вручную',
  ),
  launchCycleButton: plain(g.Buttons, 'Экран ставки: запуск цикла сделок.', '🚀 Запустить цикл'),
  stakeChangeButton: plain(g.Buttons, 'Экран ставки: открыть выбор суммы.', '💵 Изменить ставку'),
  backToListButton: plain(g.Buttons, 'Экран ставки: назад к сигналам.', '↩️ К списку'),
  stakeBackLaunchButton: plain(g.Buttons, 'Экран суммы: назад к экрану ставки.', '↩️ К запуску'),
  sessionAgainButton: plain(
    g.Buttons,
    'Итог сессии: новая сессия с теми же активом и длительностью.',
    '🔁 Ещё сессия',
  ),
  demoAnalysisButton: plain(g.Buttons, 'Демо: кнопка анализа.', '📊 Анализ'),
  demoRetryButton: plain(
    g.Buttons,
    'Кнопка повтора того же чтения или команды после сбоя: каталог, «сервис недоступен».',
    '🔄 Повторить',
  ),
  menuButton: plain(g.Buttons, 'Кнопка «в меню»: карточка статуса, как /menu.', '🏠 В меню'),
  newAnalysisButton: plain(
    g.Buttons,
    'Конец сделки и сессии: анализ той же пары и длительности заново.',
    '📊 Новый анализ',
  ),
  toSignalsButton: plain(
    g.Buttons,
    'Конец сделки и сессии: экран «Сигналы сейчас».',
    '📡 К сигналам',
  ),
  demoBackGroupsButton: plain(g.Buttons, 'Демо: кнопка назад к типам актива.', '↩️ Типы'),
  demoBackPairsButton: plain(g.Buttons, 'Демо: кнопка назад к активам.', '↩️ Активы'),
  demoBackDurationsButton: plain(
    g.Buttons,
    'Демо: кнопка назад к длительностям.',
    '↩️ Длительность',
  ),
  demoPrevButton: plain(g.Buttons, 'Демо: предыдущая страница активов.', '◀️'),
  demoNextButton: plain(g.Buttons, 'Демо: следующая страница активов.', '▶️'),
  repeatAnalysisButton: plain(g.Buttons, 'Анализ: кнопка повтора анализа.', '🔄 Повторить анализ'),
  analysisMoreButton: plain(g.Buttons, 'Анализ: кнопка, раскрывающая разовую сделку.', '➕ Ещё'),
  refreshIntentButton: plain(
    g.Buttons,
    'Сделка: кнопка обновления статуса; её название цитирует текст о долгой обработке.',
    '🔄 Обновить статус',
  ),
  supportButton: plain(g.Buttons, '/support: кнопка чата с поддержкой.', '💬 Написать в поддержку'),
  sessionRefreshButton: plain(
    g.Buttons,
    'Сессия: кнопка обновления статуса; её название цитирует текст о долгой сессии.',
    '🔄 Обновить',
  ),
  sessionStopButton: plain(g.Buttons, 'Сессия: кнопка остановки сессии.', '⏹ Остановить сессию'),
  stakeMenuButton: plain(
    g.Buttons,
    'Раскрытие «➕ Ещё» на анализе, /settings и отказы сделки: кнопка экрана суммы.',
    '💵 Сумма',
  ),
  stakeCustomButton: plain(g.Buttons, 'Экран суммы: кнопка своей суммы.', '✏️ Своя сумма'),
  stakeResetButton: plain(
    g.Buttons,
    'Экран суммы: сброс к минимальной ставке брокера.',
    '🔁 Минимальная брокера',
  ),
  stakeBackAnalysisButton: plain(
    g.Buttons,
    'Назад к анализу пары: с экрана суммы и после сбоя запуска сделки или сессии.',
    '↩️ Назад к анализу',
  ),
  stakeBackSettingsButton: plain(
    g.Buttons,
    'Экран суммы: назад к /settings.',
    '↩️ Назад к настройкам',
  ),
  stakeBackButton: plain(g.Buttons, 'Своя сумма: назад к экрану суммы.', '↩️ Назад'),
  settingsStakeButton: plain(
    g.Buttons,
    '/settings: кнопка смены суммы демо-сделки.',
    '💵 Изменить',
  ),

  // ---- Команды: описания (без emoji) --------------------------------------------------------
  startCommand: plain(g.Commands, 'Описание /start в меню команд и в /help.', 'Начать', {
    limit: COMMAND_LIMIT,
  }),
  menuCommand: plain(g.Commands, 'Описание /menu в меню команд и в /help.', 'Главное меню', {
    limit: COMMAND_LIMIT,
  }),
  accountCommand: plain(
    g.Commands,
    'Описание /account в меню команд и в /help.',
    'Аккаунт Binodex',
    {
      limit: COMMAND_LIMIT,
    },
  ),
  settingsCommand: plain(
    g.Commands,
    'Описание /settings в меню команд и в /help.',
    'Настройки уведомлений',
    { limit: COMMAND_LIMIT },
  ),
  helpCommand: plain(g.Commands, 'Описание /help в меню команд и в /help.', 'Помощь', {
    limit: COMMAND_LIMIT,
  }),
  supportCommand: plain(g.Commands, 'Описание /support в меню команд и в /help.', 'Поддержка', {
    limit: COMMAND_LIMIT,
  }),

  // ---- Профиль бота -------------------------------------------------------------------------
  profileDescription: plain(
    g.Profile,
    'Блок «Что умеет этот бот?» в пустом чате до нажатия «Запустить».',
    `🚀 Binarius — торговля на Binodex прямо в Telegram.

🤖 Автосессия: бот сам проводит серию демо-сделок по сигналу, ты смотришь на результат.
🎮 Демо без риска: деньги не нужны, разовая сделка — по желанию.
📊 Баланс, токены и история сделок — прямо в этом чате.
📧 Подключение за минуту: пришли адрес электронной почты и код из письма.

👉 Нажми «Запустить» — и начнём.`,
    { limit: DESCRIPTION_LIMIT, singleLine: false },
  ),
  profileShortDescription: plain(
    g.Profile,
    'Строка на странице профиля бота и в превью ссылки на него.',
    '🚀 Автосессии на Binodex прямо в Telegram: бот сам торгует демо по сигналу, ты смотришь результат',
    { limit: SHORT_DESCRIPTION_LIMIT },
  ),
};

type Catalog = typeof BOT_TEXT_CATALOG;
export type BotTextKey = keyof Catalog;
export type BotHtmlKey = BotHtmlKeyOf<Catalog>;
export type BotPlainKey = BotPlainKeyOf<Catalog>;
export type BotStaticHtmlKey = {
  [K in BotHtmlKey]: [keyof Catalog[K]['variables']] extends [never] ? K : never;
}[BotHtmlKey];
export type BotStaticPlainKey = {
  [K in BotPlainKey]: [keyof Catalog[K]['variables']] extends [never] ? K : never;
}[BotPlainKey];
export type BotTextKeyOfGroup<G extends BotTextGroup> = {
  [K in BotTextKey]: Catalog[K]['group'] extends G ? K : never;
}[BotTextKey];
export type BotHtmlTexts = BotHtmlTextsOf<Catalog>;
export type BotPlainTexts = BotPlainTextsOf<Catalog>;

export const botTextKeysOf = <G extends BotTextGroup>(...groups: G[]): BotTextKeyOfGroup<G>[] =>
  (Object.keys(BOT_TEXT_CATALOG) as BotTextKey[]).filter((key): key is BotTextKeyOfGroup<G> =>
    (groups as readonly BotTextGroup[]).includes(BOT_TEXT_CATALOG[key].group),
  );

export const defaultBotTextSource: BotTextSource<BotTextKey> = {
  sourceOf: (key) => BOT_TEXT_CATALOG[key].source,
};

export const botTextProblems = (
  key: BotTextKey,
  source: string,
  lookup: BotTextSource<BotTextKey> = defaultBotTextSource,
): BotTextProblem[] => botTextEntryProblems(BOT_TEXT_CATALOG, key, source, lookup);

export type BotTextSamples = BotTextSamplesOf<Catalog>;

export const createBotTexts = (source: BotTextSource<BotTextKey>): BotTextViews<Catalog> =>
  createBotTextViews(BOT_TEXT_CATALOG, source);
