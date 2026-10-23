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
  Invite: 'invite',
  Stars: 'stars',
  Demo: 'demo',
  Analysis: 'analysis',
  Trade: 'trade',
  Session: 'session',
  Deposit: 'deposit',
  Mailing: 'mailing',
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
  [BotTextGroup.Invite]: '/invite',
  [BotTextGroup.Stars]: 'Покупка токенов',
  [BotTextGroup.Demo]: 'Демо: выбор актива',
  [BotTextGroup.Analysis]: 'Анализ',
  [BotTextGroup.Trade]: 'Демо-сделка',
  [BotTextGroup.Session]: 'Сессия',
  [BotTextGroup.Deposit]: 'Пополнение',
  [BotTextGroup.Mailing]: 'Напоминания',
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

// Pick's own mapped type, spelled out: a Pick of the registry's typeof is written into the .d.ts
// with the whole registry inlined for every key, which put the catalog past what tsc serializes
// (#464); this form lists only the key's own variables.
type VariablesOf<V extends readonly BotTextVarName[]> = {
  readonly [K in V[number]]: BotTextVars[K];
};
const variablesOf = <V extends readonly BotTextVarName[]>(names: V | undefined): VariablesOf<V> =>
  Object.fromEntries((names ?? []).map((name) => [name, BOT_TEXT_VARS[name]])) as VariablesOf<V>;

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
// what the backend holds when it prints a session's trade (#464)
const tradeNotice = ['cycle', 'step', 'stake', 'outcome', 'openPrice', 'closePrice'] as const;
const caption = { limit: TELEGRAM_CAPTION_LIMIT };
// What a status card's handler holds: the access read and the user's first_name (docs/bot-texts.md
// → Variables); the stake picker's adds the minimum and both balances, so either mode's picker
// prints the bound it shows (#326).
const user = [
  'firstName',
  'tokens',
  'reservedTokens',
  'demoBalance',
  'realBalance',
  'mode',
  'stake',
] as const;
const picker = [...user, 'minStake', 'demoAvailable', 'realAvailable'] as const;

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
    '/menu и итог сессии: баланс устарел, с возрастом снимка.',
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
  statusHintReal: html(
    g.Menu,
    '/menu: подсказка внизу карточки в реальном режиме (#121), с действующей реальной ставкой (#326).',
    `⚠️ Реальный режим: сделки идут на реальные деньги на сумму {stake}.`,
    { ...caption, vars: user },
  ),
  balanceUnavailable: plain(
    g.Menu,
    'Вместо {demoBalance} и {realBalance}, когда свежего снимка баланса нет.',
    'нет свежих данных',
  ),
  ageSecondsUnit: plain(
    g.Menu,
    'Единица {age} меньше минуты: «5 с назад» в строке о свежести баланса (#508).',
    'с',
  ),
  ageMinutesUnit: plain(
    g.Menu,
    'Единица {age} от минуты: «5 мин назад» в строке о свежести баланса (#508).',
    'мин',
  ),

  // ---- Экран выбора языка (#508, docs/bot-navigation.md → The language screen) ------------------
  languageScreen: html(
    g.Menu,
    'Экран выбора языка: открывается командой /language (и кнопкой «🌐 Язык/Language» карточки статуса, отправленной до #708).',
    `🌐 <b>Язык бота</b>
Выбери, на каком языке бот будет писать тебе.`,
  ),
  languageNeedsStart: html(
    g.Menu,
    'Выбор языка до первого /start: пользователя ещё нет.',
    `Нажми /start, и я покажу выбор языка.`,
  ),
  languageRuButton: plain(g.Menu, 'Экран выбора языка: кнопка русского языка.', '🇷🇺 Русский'),
  languageEnButton: plain(g.Menu, 'Экран выбора языка: кнопка английского языка.', '🇬🇧 English'),

  // ---- Экран режима торговли (#474, docs/trading-mode.md → The mode screen) --------------------
  modeHeader: html(g.Menu, 'Экран режима торговли: заголовок.', `⚙️ <b>Режим торговли</b>`),
  modeCurrent: html(g.Menu, 'Экран режима: текущий режим.', `Сейчас: <b>{mode}</b>`, {
    vars: ['mode'],
  }),
  modeRealBalance: html(
    g.Menu,
    'Экран режима: реальный баланс по снимку; без свежего снимка — «нет свежих данных».',
    `💵 Реальный баланс: {realBalance}`,
    { vars: ['realBalance'] },
  ),
  modeRealStake: html(
    g.Menu,
    'Экран режима: сумма реальной сделки — сохранённая или минимальная ставка брокера (#326).',
    `💼 Сумма реальной сделки: <b>{stake}</b>`,
    { vars: ['stake'] },
  ),
  modeWarning: html(
    g.Menu,
    'Экран режима: что значит реальный режим и как из него выйти.',
    `⚠️ В реальном режиме сделки и сессии идут на реальные деньги. В сессии ставка растёт после проигрыша. Вернуться в демо можно здесь же или командой /stop.`,
  ),
  modeStopsSession: html(
    g.Menu,
    'Экран режима и подтверждение: смена режима останавливает активную сессию (#327).',
    `⏹ Смена режима останавливает активную сессию.`,
  ),
  modePaused: html(
    g.Menu,
    'Экран режима: торговля приостановлена общим выключателем.',
    `⏸ Торговля сейчас приостановлена — сделки пойдут, когда её откроют.`,
  ),
  modeConfirm: html(
    g.Menu,
    'Экран режима: подтверждение включения реального режима, с суммой реальной сделки.',
    `Включить реальный режим? Сделки пойдут на реальные деньги на сумму <b>{stake}</b>.`,
    { vars: ['stake'] },
  ),
  modeStakeOutOfBounds: html(
    g.Menu,
    'Подтверждение реального режима: сохранённая реальная сумма не проходит проверку суммы по снимку баланса; включить всё равно можно.',
    `⚠️ Сумма {stake} сейчас не подходит к реальному счёту (доступно {realAvailable}, минимум {minStake}) — сделки будут отклоняться, пока не изменишь её в /settings → «{settingsStakeRealButton}».`,
    {
      vars: ['stake', 'realAvailable', 'minStake'],
      fragments: { settingsStakeRealButton: 'settingsStakeRealButton' },
    },
  ),
  modeEnabled: html(
    g.Menu,
    'Экран режима: реальный режим включён.',
    `✅ Режим: REAL. Сделки и сессии теперь идут на реальные деньги — карточка в /menu покажет REAL.`,
  ),
  modeDisabled: html(
    g.Menu,
    'Экран режима: возврат в демо.',
    `✅ Режим: DEMO. Следующие сделки пойдут на демо-счёт.`,
  ),
  modeSessionStopped: html(
    g.Menu,
    'Экран режима: под итогом переключения, когда смена режима остановила активную сессию (#327).',
    `⏹ Активная сессия остановлена.`,
  ),
  modeBelowMinimum: html(
    g.Menu,
    'Экран режима: на реальном счёте меньше минимальной ставки брокера.',
    `⚠️ На реальном счёте меньше минимальной ставки брокера — пополни счёт Binodex и попробуй снова.`,
  ),
  modeOutcomeUnknown: html(
    g.Menu,
    'Экран режима: неизвестно, переключился ли режим.',
    `⚠️ Не удалось узнать, переключился ли режим — открой экран режима ещё раз.`,
  ),
  modeStopReset: html(
    g.Menu,
    '/stop: пользователь был в реальном режиме и переключён в демо.',
    `🎮 Режим: DEMO — следующие сделки пойдут на демо.`,
  ),
  modeNotReset: html(
    g.Menu,
    '/stop: режим торговли не удалось переключить в демо.',
    `⚠️ Режим не переключён — открой /menu.`,
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
  settingsStakeReal: html(
    g.Settings,
    '/settings: строка с суммой реальной сделки под строкой демо-суммы (#326).',
    `💼 Сумма реальной сделки: <b>{stake}</b>`,
    { vars: ['level', 'stake', 'firstName'] },
  ),
  stakeMinimumLabel: plain(
    g.Settings,
    'Сумма сделки (демо или реальной) не выбрана: так она называется в /settings, на экране суммы и после сброса.',
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

  // ---- /invite (#115, docs/referrals.md) ----------------------------------------------------
  inviteScreen: html(
    g.Invite,
    '/invite, кнопка «👥 Позвать»: персональная ссылка, число приглашённых, сколько из них подключили партнёрский аккаунт Binodex и сколько токенов получено за приглашения.',
    `👥 <b>Пригласи друга</b>
Твоя ссылка:
{referralLink}
Приглашено: {count}
Подключили аккаунт: {connected}
Получено токенов: {earnedTokens}`,
    { vars: ['referralLink', 'count', 'connected', 'earnedTokens'] },
  ),
  inviteNeedsStart: html(
    g.Invite,
    '/invite до первого /start: бот ещё не знает пользователя.',
    `Нажми /start, и я пришлю ссылку-приглашение.`,
  ),
  inviteShareText: plain(
    g.Invite,
    'Текст, который «Поделиться» подставляет к ссылке-приглашению в выбранном чате.',
    'Торгую в демо с сигналами в Binarius — заходи по моей ссылке',
    { limit: 200 },
  ),

  // ---- Покупка токенов (#117, docs/stars.md) ------------------------------------------------
  buyScreen: html(
    g.Stars,
    '/buy и кнопка «⭐ Купить»: выбор пакета.',
    `⭐ <b>Купить токены</b>
Токены оплачивают сделки автоторговли. Выбери пакет — оплата в Telegram Stars.`,
  ),
  buyNeedsAccount: html(
    g.Stars,
    'Покупка без подключённого аккаунта Binodex: под текстом кнопка подключения.',
    `Купить токены можно после подключения аккаунта Binodex — кнопка ниже.`,
  ),
  buyPackageGone: html(
    g.Stars,
    'Нажат пакет, который больше не продаётся: под текстом актуальные пакеты.',
    `Этот пакет больше не продаётся. Выбери другой.`,
  ),
  starsCredited: html(
    g.Stars,
    'После оплаты: токены начислены. Также push, когда начисление сделала фоновая сверка.',
    `⭐ Начислено {purchasedTokens} токенов. Баланс: {tokenBalance}`,
    { vars: ['purchasedTokens', 'tokenBalance'] },
  ),
  starsHeld: html(
    g.Stars,
    'После оплаты: платёж не прошёл проверку при начислении (сумма, пакет, плательщик).',
    `Платёж получен, начисление проверит поддержка.`,
  ),
  starsPending: html(
    g.Stars,
    'После оплаты: бот не получил ответ о начислении; фоновая сверка начислит токены.',
    `Платёж получен, токены начислятся в течение нескольких минут.`,
  ),
  starsInvoiceTitle: plain(
    g.Stars,
    'Счёт на оплату: название (Telegram показывает без разметки, до 32 символов).',
    'Токены Binarius',
    { limit: 32 },
  ),
  starsInvoiceDescription: plain(
    g.Stars,
    'Счёт на оплату: описание (без разметки, до 255 символов).',
    '{purchasedTokens} токенов для автоторговли в Binarius',
    { limit: 255, vars: ['purchasedTokens'] },
  ),
  buyPackageButton: plain(
    g.Stars,
    'Экран покупки: кнопка пакета.',
    '🪙 {purchasedTokens} токенов — {stars} ⭐',
    { vars: ['purchasedTokens', 'stars'] },
  ),
  starsPayButton: plain(
    g.Stars,
    'Счёт на оплату: кнопка оплаты, первая под счётом (Telegram заменяет ⭐ значком звезды).',
    '⭐ Оплатить {stars}',
    { vars: ['stars'] },
  ),
  starsPreCheckoutRefused: plain(
    g.Stars,
    'Telegram показывает при отказе в оплате: пакет, цена или аккаунт не прошли проверку.',
    'Покупка недоступна. Открой /buy и выбери пакет заново.',
    { limit: 255 },
  ),
  starsPreCheckoutFailed: plain(
    g.Stars,
    'Telegram показывает при отказе в оплате: бот не смог проверить покупку.',
    'Не удалось проверить покупку, попробуй ещё раз.',
    { limit: 255 },
  ),

  // ---- Демо: выбор актива -------------------------------------------------------------------
  demoGroups: html(
    g.Demo,
    'Ручной выбор пары: тип актива; общий для демо и реального режима (#121).',
    `🧭 <b>Выбор пары</b>
Выбери тип актива.`,
  ),
  demoPairsHeader: html(
    g.Demo,
    'Ручной выбор пары: активы типа, с названием типа; общий для демо и реального режима (#121).',
    `🧭 <b>Выбор пары</b> · {group}
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
    'Сводка пары перед анализом; общий для демо и реального режима (#121).',
    `Дальше — анализ свечей: бот покажет сигнал и что можно сделать по нему.`,
  ),
  demoSignalsHeader: html(
    g.Demo,
    'Экран «Сигналы сейчас» над кнопками пар с сигналом на 5 с (#320, #685); через 30 с без выбора экран становится «Начать торговлю» (#664); общий для демо и реального режима (#121).',
    `📡 <b>Сигналы сейчас</b> · {label}
Выбери пару. Сигнал держится одну свечу ({label}), поэтому перед сделкой бот проверяет его заново.`,
    { vars: ['label'] },
  ),
  signalsWaiting: html(
    g.Demo,
    'Экран «Сигналы сейчас», пока ни у одной пары нет сигнала: бот проверяет пары на каждой свече и откроет список в этом же сообщении (#664).',
    `🔎 <b>Анализирую сигналы</b> · {label}
Проверяю пары на каждой свече. Как только появится сигнал, список откроется здесь.`,
    { vars: ['label'] },
  ),
  signalsExpired: html(
    g.Demo,
    'Шаг «Начать торговлю»: список пар через 30 с без выбора, ожидание сигнала после остановки бота или через час (#664).',
    `🚀 <b>Начать торговлю</b>
Сигнал держится одну свечу ({label}), и этот список устарел. Открой свежие сигналы или выбери пару вручную.`,
    { vars: ['label'] },
  ),
  pairWaiting: html(
    g.Demo,
    'Ожидание сигнала по выбранной паре: бот проверяет её на каждой свече и продолжит в этом же сообщении (#664).',
    `⏳ <b>Проверяю сигнал по {symbol}</b>
Смотрю на каждой свече ({label}). Как только сигнал появится, продолжим здесь.`,
    { vars: ['symbol', 'label'] },
  ),
  pairWaitingAlternatives: html(
    g.Demo,
    'Ожидание сигнала пары и анализа: строка над кнопками других пар с сигналом, первые 30 с (#664).',
    `Сигнал уже есть по другим парам — можно не ждать и выбрать одну из них 👇`,
  ),
  launchHeader: html(
    g.Demo,
    'Экран ставки и экран суммы демо-цикла (#476): пара и длительность цикла.',
    `🎯 <b>{subject}</b>`,
    {
      vars: ['subject', 'firstName', 'stake'],
    },
  ),
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
    'Экран ставки и экран суммы демо-цикла (#476): что сделает сессия, с числом циклов.',
    `🤖 Бот проведёт {cycles} подряд и перед каждой сделкой проверит сигнал. Это демо: деньги не нужны.`,
    { vars: ['cycles', 'firstName', 'stake'] },
  ),
  launchCycleReal: html(
    g.Demo,
    'Экран ставки в реальном режиме (#327): что сделает сессия, с числом циклов.',
    `🤖 Бот проведёт {cycles} подряд и перед каждой сделкой проверит сигнал. Реальный режим: сделки идут на реальные деньги.`,
    { vars: ['cycles', 'firstName', 'stake'] },
  ),
  demoCatalogUnavailable: html(
    g.Demo,
    'Демо: каталог активов недоступен.',
    `⚠️ Каталог активов сейчас недоступен. Попробуй через минуту.`,
  ),
  demoNoShortPairs: html(
    g.Demo,
    'Демо: в каталоге нет активов, принимающих 5 секунд.',
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
  demoDurationUnsupported: html(
    g.Demo,
    'Демо: актив не принимает сделки на 5 секунд (#685).',
    `❌ {symbol} не принимает сделки на {label}. Выбери другой актив.`,
    { vars: ['symbol', 'label'] },
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
    '💠 Крипта',
  ),
  demoGroupIndex: plain(
    g.Demo,
    'Демо: тип актива «индексы», на кнопке и в заголовке.',
    '📊 Индексы',
  ),
  demoGroupOther: plain(g.Demo, 'Демо: прочие активы, на кнопке и в заголовке.', '📁 Другие'),
  demoDuration5: plain(g.Demo, 'Демо: длительность 5 секунд, в строках и заголовках.', '⏱ 5 с'),

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
  analysisCardUp: html(
    g.Analysis,
    'Анализ: заголовок карточки при сигнале вверх, под картинкой быка.',
    `🟢 <b>Сильный сигнал на рост</b>`,
  ),
  analysisCardDown: html(
    g.Analysis,
    'Анализ: заголовок карточки при сигнале вниз, под картинкой медведя.',
    `🔴 <b>Сильный сигнал на падение</b>`,
  ),
  analysisChooseAmount: html(
    g.Analysis,
    'Анализ: последняя строка карточки в демо, когда под ней кнопки сумм сделки.',
    `Выбери сумму сделки 👇`,
  ),
  analysisWaiting: html(
    g.Analysis,
    'Анализ без сигнала: бот ждёт сигнал на следующих свечах и откроет карточку в этом же сообщении (#664).',
    `⏳ <b>Проверяю сигнал…</b> Как только он появится, здесь откроется карточка сигнала.`,
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
  analysisDisclaimer: html(
    g.Analysis,
    'Анализ: оговорка под сигналом.',
    `⚠️ Сигнал — не прогноз результата и не гарантия. Это демо: деньги не нужны.`,
  ),
  analysisDisclaimerReal: html(
    g.Analysis,
    'Анализ: оговорка под сигналом в реальном режиме (#121).',
    `⚠️ Сигнал — не прогноз результата и не гарантия. Реальный режим: сделка идёт на реальные деньги.`,
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
    'Направление «вверх»: на кнопке сделки и в строке сделки.',
    '⬆️ Вверх',
  ),
  actionDown: plain(
    g.Analysis,
    'Направление «вниз»: на кнопке сделки и в строке сделки.',
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
    'Анализ и итог сделки: кнопка запуска сессии, с числом циклов; в реальном режиме бот дописывает « · REAL».',
    '🚀 Сессия из {cycles}',
    { vars: ['cycles'] },
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
    '{count} шага котировки',
    { vars: ['count'] },
  ),
  emaAbove: plain(g.Analysis, 'Анализ: быстрая EMA выше медленной, в строке тренда.', 'выше'),
  emaBelow: plain(g.Analysis, 'Анализ: быстрая EMA ниже медленной, в строке тренда.', 'ниже'),
  emaEqual: plain(g.Analysis, 'Анализ: быстрая EMA равна медленной, в строке тренда.', 'равна'),
  cardRowPair: plain(g.Analysis, 'Карточка анализа: подпись строки пары в блоке.', 'Пара'),
  cardRowRsi: plain(g.Analysis, 'Карточка анализа: подпись строки RSI в блоке.', 'RSI'),
  cardRowMacd: plain(g.Analysis, 'Карточка анализа: подпись строки MACD в блоке.', 'MACD'),
  cardRowMa50: plain(g.Analysis, 'Карточка анализа: подпись строки MA50 в блоке.', 'MA50'),
  cardRowMa200: plain(g.Analysis, 'Карточка анализа: подпись строки MA200 в блоке.', 'MA200'),
  cardRowTrend: plain(g.Analysis, 'Карточка анализа: подпись строки тренда в блоке.', 'Тренд EMA'),
  cardRowVolatility: plain(
    g.Analysis,
    'Карточка анализа: подпись строки волатильности в блоке.',
    'Волатильность',
  ),
  cardRowDirection: plain(
    g.Analysis,
    'Карточка анализа: подпись строки направления в блоке.',
    'Направление',
  ),
  rsiOverbought: plain(
    g.Analysis,
    'Карточка анализа: RSI не ниже верхней границы Signal, в строке RSI.',
    'перекуплен',
  ),
  rsiOversold: plain(
    g.Analysis,
    'Карточка анализа: RSI не выше нижней границы Signal, в строке RSI.',
    'перепродан',
  ),
  rsiNeutral: plain(
    g.Analysis,
    'Карточка анализа: RSI между границами Signal, в строке RSI.',
    'нейтрально',
  ),
  macdCrossUp: plain(
    g.Analysis,
    'Карточка анализа: MACD пересёк сигнальную линию вверх на последней свече, в строке MACD.',
    'пересечение вверх',
  ),
  macdCrossDown: plain(
    g.Analysis,
    'Карточка анализа: MACD пересёк сигнальную линию вниз на последней свече, в строке MACD.',
    'пересечение вниз',
  ),
  macdAbove: plain(
    g.Analysis,
    'Карточка анализа: MACD выше сигнальной линии без пересечения, в строке MACD.',
    'выше сигнальной',
  ),
  macdBelow: plain(
    g.Analysis,
    'Карточка анализа: MACD ниже сигнальной линии без пересечения, в строке MACD.',
    'ниже сигнальной',
  ),
  macdEqual: plain(
    g.Analysis,
    'Карточка анализа: MACD равен сигнальной линии, в строке MACD.',
    'на сигнальной',
  ),
  maPriceAbove: plain(
    g.Analysis,
    'Карточка анализа: последняя цена выше скользящей средней, в строке MA.',
    'цена выше',
  ),
  maPriceBelow: plain(
    g.Analysis,
    'Карточка анализа: последняя цена ниже скользящей средней, в строке MA.',
    'цена ниже',
  ),
  maPriceEqual: plain(
    g.Analysis,
    'Карточка анализа: последняя цена равна скользящей средней, в строке MA.',
    'цена на MA',
  ),
  cardDirectionUp: plain(
    g.Analysis,
    'Карточка анализа: направление сигнала вверх, последняя строка блока.',
    '⬆️ ВВЕРХ 🟢',
  ),
  cardDirectionDown: plain(
    g.Analysis,
    'Карточка анализа: направление сигнала вниз, последняя строка блока.',
    '⬇️ ВНИЗ 🔴',
  ),
  indicatorShortData: plain(
    g.Analysis,
    'Карточка анализа: индикатору не хватило закрытых свечей, вместо значения в его строке.',
    'данных мало ({count} из {required})',
    { vars: ['count', 'required'] },
  ),

  // ---- Демо-сделка --------------------------------------------------------------------------
  intentHeader: html(g.Trade, 'Сделка: заголовок сообщения статуса.', `🎮 <b>Демо-сделка</b>`),
  intentHeaderReal: html(
    g.Trade,
    'Сделка: заголовок сообщения статуса реальной сделки (#121).',
    `💼 <b>Реальная сделка</b>`,
  ),
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
  intentRejectedDemoOnly: html(
    g.Trade,
    'Сделка отклонена: сервер запущен с DEMO_ONLY, реальные сделки отключены.',
    `⚠️ Сделка отклонена: реальные сделки на этом сервере отключены. Токен возвращён.`,
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
    'Итог сделки: предложение запустить сессию, с числом циклов.',
    `🤖 Дальше бот может торговать сам: сессия из {cycles} на этой паре, сигнал он проверяет перед каждой сделкой.`,
    { vars: ['cycles'] },
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
  tradingDemoOnly: html(
    g.Trade,
    'Кнопка сделки или сессии: сервер запущен с DEMO_ONLY, реальные сделки отключены.',
    `⚠️ Реальные сделки на этом сервере отключены — доступен только демо-режим.`,
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
    'Кнопка сделки: режим или сумма изменились после того, как кнопка была нарисована.',
    `⚠️ Режим или сумма сделки изменились — открой анализ заново.`,
  ),
  stakeRealModeOff: html(
    g.Trade,
    'Кнопка реальной сделки: реальный режим выключили после того, как кнопка была нарисована.',
    `⚠️ Реальный режим выключен — включи его в меню и открой анализ заново.`,
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
  stakeAboveAvailableReal: html(
    g.Trade,
    'Кнопка реальной сделки: сумма больше доступного реального баланса (#326).',
    `⚠️ На реальном счёте недостаточно средств для этой суммы. Выбери сумму поменьше.`,
  ),
  stakeAboveAvailableAmount: html(
    g.Trade,
    'Сохранение суммы: сумма больше доступного демо-баланса.',
    `⚠️ На демо-счёте доступно {demoAvailable}. Выбери сумму поменьше.`,
    { vars: ['demoAvailable', 'minStake'] },
  ),
  stakeAboveAvailableAmountReal: html(
    g.Trade,
    'Сохранение реальной суммы: сумма больше доступного реального баланса (#326).',
    `⚠️ На реальном счёте доступно {realAvailable}. Выбери сумму поменьше.`,
    { vars: ['realAvailable', 'minStake'] },
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
  // its own key: a refusal carries only the balance of its mode (#326)
  stakePrecisionDigitsReal: html(
    g.Trade,
    'Сохранение реальной суммы: слишком много знаков после запятой, с допустимым числом (#326).',
    `❌ Не больше {digits} знаков после запятой.`,
    { vars: ['digits', 'minStake', 'realAvailable'] },
  ),
  stakePickerHeader: html(g.Trade, 'Экран суммы: заголовок.', `💵 <b>Сумма демо-сделки</b>`, {
    vars: picker,
  }),
  stakePickerHeaderReal: html(
    g.Trade,
    'Экран реальной суммы: заголовок (#326).',
    `💼 <b>Сумма реальной сделки</b>`,
    { vars: picker },
  ),
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
  stakePickerAvailableReal: html(
    g.Trade,
    'Экран реальной суммы: доступный реальный баланс (#326).',
    `Реальный баланс: {realAvailable}`,
    { vars: picker },
  ),
  stakePickerNoPresets: html(
    g.Trade,
    'Экран суммы: демо-баланса не хватает даже на минимальную ставку.',
    `На демо-счёте недостаточно средств даже для минимальной ставки.`,
    { vars: picker },
  ),
  stakePickerNoPresetsReal: html(
    g.Trade,
    'Экран реальной суммы: реального баланса не хватает даже на минимальную ставку (#326).',
    `На реальном счёте недостаточно средств даже для минимальной ставки.`,
    { vars: picker },
  ),
  stakeInputPrompt: html(
    g.Trade,
    'Экран суммы: просьба прислать свою сумму текстом.',
    `✏️ Пришли сумму демо-сделки числом, например 5 или 2,50.`,
  ),
  stakeInputPromptReal: html(
    g.Trade,
    'Экран реальной суммы: просьба прислать свою сумму текстом (#326).',
    `✏️ Пришли сумму реальной сделки числом, например 5 или 2,50.`,
  ),
  stakeInputInvalid: html(
    g.Trade,
    'Своя сумма («✏️ Ввести»): присланное не похоже на сумму.',
    `❌ Введи сумму числом, например 5 или 2,50.`,
  ),
  stakeSaved: html(g.Trade, 'Демо-ставка сохранена.', `✅ Демо-ставка: {stake}`, {
    vars: ['stake', 'firstName'],
  }),
  stakeSavedReal: html(
    g.Trade,
    'Реальная ставка сохранена (#326).',
    `✅ Реальная ставка: {stake}`,
    {
      vars: ['stake', 'firstName'],
    },
  ),
  stakeSavedLine: html(
    g.Trade,
    'Экран ставки: строка над экраном после сохранения суммы демо-ставки.',
    `✅ Демо-ставка сохранена: {stake}`,
    { vars: ['stake', 'firstName'] },
  ),
  stakeSavedLineReal: html(
    g.Trade,
    'Экран ставки: строка над экраном после сохранения суммы реальной ставки (#326).',
    `✅ Реальная ставка сохранена: {stake}`,
    { vars: ['stake', 'firstName'] },
  ),
  stakeSaveUnknown: html(
    g.Trade,
    'Сумма: неизвестно, сохранилась ли она.',
    `⚠️ Не удалось сохранить сумму — попробуй ещё раз.`,
  ),
  // ---- Сессия -------------------------------------------------------------------------------
  sessionHeader: html(
    g.Session,
    'Сессия: заголовок сообщения статуса демо-сессии.',
    `🎮 <b>Демо-сессия</b>`,
  ),
  sessionHeaderReal: html(
    g.Session,
    'Сессия: заголовок сообщения статуса реальной сессии (#327).',
    `💼 <b>Реальная сессия</b>`,
  ),
  sessionPair: html(g.Session, 'Сессия: строка торговой пары.', `🔹 Торговая пара: {symbol}`, {
    vars: ['symbol'],
  }),
  sessionStake: html(g.Session, 'Сессия: строка суммы сделки.', `🔹 Сумма сделки: {stake}`, {
    vars: ['stake'],
  }),
  sessionExpiry: html(
    g.Session,
    'Сессия: строка времени экспирации сделки.',
    `🔹 Время экспирации: {duration}`,
    { vars: ['duration'] },
  ),
  sessionSignalUp: html(
    g.Session,
    'Сессия: строка направления сигнала вверх, пятая строка шапки (#568).',
    '📡 Сигнал: ⬆️ Вверх',
  ),
  sessionSignalDown: html(
    g.Session,
    'Сессия: строка направления сигнала вниз, пятая строка шапки (#568).',
    '📡 Сигнал: ⬇️ Вниз',
  ),
  sessionRunning: html(
    g.Session,
    'Сессия: под параметрами сессии, пока она идёт.',
    `Торговая сессия запущена…`,
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
  sessionCycleOne: plain(g.Session, 'Сессия: слово после числа 1, 21, 31… («1 цикл»).', 'цикл'),
  sessionCycleFew: plain(g.Session, 'Сессия: слово после числа 2–4, 22–24… («3 цикла»).', 'цикла'),
  sessionCycleMany: plain(
    g.Session,
    'Сессия: слово после остальных чисел («5 циклов», «11 циклов»).',
    'циклов',
  ),
  sessionCandleOne: plain(
    g.Session,
    'Сессия: слово «свеча» после числа 1, 21, 31… («21 свеча», #637).',
    'свеча',
  ),
  sessionCandleFew: plain(
    g.Session,
    'Сессия: слово «свеча» после числа 2–4, 22–24… («22 свечи», #637).',
    'свечи',
  ),
  sessionCandleMany: plain(
    g.Session,
    'Сессия: слово «свеча» после остальных чисел («20 свечей», #637).',
    'свечей',
  ),
  sessionWaitingSignal: html(
    g.Session,
    'Сессия: сообщение ожидания под сообщениями сессии, с кнопкой остановки, только пока сессия ждёт сигнал (последнее решение — «сигнала нет»); шлёт backend.',
    `🔎 Ждём сигнал для следующей сделки…`,
  ),
  sessionCompleted: html(
    g.Session,
    'Сессия: итог, когда все циклы закрыты (#552): число циклов, затем сделки и счёт.',
    `🏁 Сессия завершена: {cycles}, {result}`,
    { vars: ['cycles', 'result'] },
  ),
  sessionTotal: html(g.Session, 'Сессия: итог под причиной остановки.', `📊 Итог: {result}`, {
    vars: ['result'],
  }),
  sessionResult: html(
    g.Session,
    'Сессия: результат закрытых сделок в $, в итоге.',
    `💰 Результат: {profit}`,
    { vars: ['profit'] },
  ),
  sessionBalanceDemo: html(
    g.Session,
    'Сессия: демобаланс после сессии.',
    `🧪 Демобаланс: {amount}`,
    {
      vars: ['amount'],
    },
  ),
  sessionBalanceReal: html(
    g.Session,
    'Сессия: реальный баланс после сессии.',
    `💵 Реальный баланс: {amount}`,
    { vars: ['amount'] },
  ),
  sessionOpenTradePlaysOut: html(
    g.Session,
    'Сессия остановлена, а последняя сделка открыта у брокера (accepted).',
    `⏳ Открытая сделка доиграет до конца.`,
  ),
  sessionLastTradeChecking: html(
    g.Session,
    'Сессия остановлена, итог последней сделки неизвестен (unknown/reconciling): уточняется у брокера.',
    `🔎 Итог последней сделки уточняется у брокера.`,
  ),
  sessionLastTradeOpening: html(
    g.Session,
    'Сессия остановлена, последняя заявка ещё не открыта (planned/reserved/queued/submitting).',
    `⏳ Последняя сделка ещё открывается: если откроется — доиграет до конца.`,
  ),
  sessionSettingsUnavailable: html(
    g.Session,
    'Сессия: настройки сессии не прочитаны.',
    `⚠️ Настройки сессии не прочитаны — напиши в поддержку: /support`,
  ),
  sessionStatusUnavailable: html(
    g.Session,
    'Сессия: статус недоступен.',
    `⚠️ Статус сессии недоступен.`,
  ),
  sessionNoneActive: html(g.Session, '/stop: активных сессий нет.', `Активных сессий нет.`),
  sessionsStopped: html(
    g.Session,
    '/stop: остановлено больше одной сессии.',
    `⏹ Остановлено сессий: {count}. Открытые сделки доиграют до конца.`,
    { vars: ['count'] },
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
  sessionAccountChanged: html(
    g.Session,
    'Кнопка сессии (#745): метку H1 аккаунта сняли во время старта; новый анализ стартует обычную сессию.',
    `⚙️ Настройки аккаунта изменились — открой анализ заново.`,
  ),
  sessionSignalUnavailable: html(
    g.Session,
    'Кнопка сессии: сигнал пары не удалось проверить (#509).',
    `⚠️ Не удалось проверить сигнал пары — повтори анализ.`,
  ),
  sessionStopNoSignalTimeout: html(
    g.Session,
    'Сессия остановлена: по паре не было сигнала столько свечей интервала сессии (#509, #637).',
    `⏳ Сессия остановлена: по паре не было сигнала {noSignalCandles} по {candleSec} с. Выбери другую пару.`,
    { vars: ['noSignalCandles', 'candleSec'] },
  ),
  sessionStopNoSignalTimeoutNoSettings: html(
    g.Session,
    'Сессия остановлена без сигнала, настройки сессии не читаются — строка без числа свечей (#637).',
    `⏳ Сессия остановлена: по паре долго не было сигнала. Выбери другую пару.`,
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
    `⚠️ Сессия остановлена: ставку не удалось подобрать — проверь баланс в /account.`,
  ),
  sessionStopMaxSteps: html(
    g.Session,
    'Сессия остановлена: серия проигрышей дошла до лимита повышений ставки (#450).',
    `🛑 Сессия остановлена: серия проигрышей дошла до лимита повышений ставки.`,
  ),
  sessionStopMaxStake: html(
    g.Session,
    'Сессия остановлена: следующая ставка вышла бы за лимит размера ставки (#450).',
    `🛑 Сессия остановлена: следующая ставка вышла бы за лимит размера ставки.`,
  ),
  sessionStopMaxSessionLoss: html(
    g.Session,
    'Сессия остановлена: следующая сделка могла бы превысить лимит убытка сессии (#450).',
    `🛑 Сессия остановлена: следующая сделка могла бы превысить лимит убытка сессии.`,
  ),
  sessionStopSessionDuration: html(
    g.Session,
    "Сессия остановлена: истёк час на сессию по часам worker'а (лимит ставки, #450).",
    `⏱ Сессия остановлена: истёк час на сессию.`,
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
    'Сессия остановлена пользователем: кнопкой или /stop.',
    `⏹ Сессия остановлена по твоей команде.`,
  ),
  // The summary card (#318, docs/bot-session.md → The summary message): labels drawn on the image,
  // each limit the width of its slot there; the caption under the photo is the whole summary
  // (#537, #709: sessionSummary in bot-text-messages.ts).
  sessionCardTitle: plain(g.Session, 'Картинка-итог: подпись под активом.', 'СЕССИЯ ЗАВЕРШЕНА', {
    limit: 24,
  }),
  sessionCardResult: plain(g.Session, 'Картинка-итог: подпись над результатом в $.', 'ИТОГ', {
    limit: 12,
  }),
  sessionCardTrade: plain(g.Session, 'Картинка-итог: заголовок колонки сделки.', 'Сделка {count}', {
    vars: ['count'],
    limit: 16,
  }),
  sessionCardLegendEntry: plain(g.Session, 'Картинка-итог: легенда, точка входа.', 'Вход', {
    limit: 12,
  }),
  sessionCardLegendWin: plain(g.Session, 'Картинка-итог: легенда, сделка в плюс.', 'Плюс', {
    limit: 12,
  }),
  sessionCardLegendLoss: plain(g.Session, 'Картинка-итог: легенда, сделка в минус.', 'Минус', {
    limit: 12,
  }),
  sessionCardLegendTie: plain(g.Session, 'Картинка-итог: легенда, сделка в ноль.', 'Ноль', {
    limit: 12,
  }),
  sessionCardFooter: plain(
    g.Session,
    'Картинка-итог: нижняя строка — число сделок и счёт.',
    '{trades} · {score}',
    { vars: ['trades', 'score'], limit: 64 },
  ),
  // The promo card shared by «📤 Поделиться» (#538, docs/bot-session.md → Sharing the card): a
  // card of its own, drawn when the share is pressed; each limit the width of its slot there.
  sessionPromoResult: plain(
    g.Session,
    'Промо-карточка «Поделиться»: подпись над результатом в $.',
    'Мой результат сессии',
    { limit: 32 },
  ),
  sessionPromoUp: plain(
    g.Session,
    'Промо-карточка «Поделиться»: плашка направления вверх.',
    'ВВЕРХ',
    { limit: 12 },
  ),
  sessionPromoDown: plain(
    g.Session,
    'Промо-карточка «Поделиться»: плашка направления вниз.',
    'ВНИЗ',
    { limit: 12 },
  ),
  sessionPromoBrand: plain(
    g.Session,
    'Промо-карточка «Поделиться»: название бота у знака.',
    'Binarius',
    { limit: 24 },
  ),
  sessionPromoCall: plain(
    g.Session,
    'Промо-карточка «Поделиться»: призыв под названием бота.',
    'Торгуй со мной в Binarius и получи бесплатные токены!',
    { limit: 80 },
  ),
  sessionPromoWhen: plain(
    g.Session,
    'Промо-карточка «Поделиться»: время и дата окончания сессии.',
    '{sessionEnd} МСК',
    { vars: ['sessionEnd'], limit: 32 },
  ),
  sessionShareCaption: html(
    g.Session,
    'Промо-карточка «📤 Поделиться»: подпись в выбранном чате. Ссылка — реферальная ссылка отправителя (без кода — общая ссылка бота), простым текстом.',
    `Присоединяйся к Binarius — получи бесплатные токены!
{referralLink}`,
    { ...caption, vars: ['referralLink'] },
  ),

  // Sent by the backend only (#464, #551, #700, docs/bot-session.md → Trade messages): a message
  // per cycle of a session, its steps added by editing it - each trade's block when it opens, with
  // the session's «⏹» (#722), then edited into its result, which takes the «⏹» off - without
  // sound, and the summary once it is finished.
  sessionTradeWon: html(
    g.Session,
    'Блок сделки в сообщении цикла сессии, выигрыш: цикл и шаг, ставка → ставка + прибыль, цены. Заменяет блок открытой сделки, снимая «⏹»; шаги цикла — в том же сообщении. Без звука.',
    `⚡ Цикл {cycle} Шаг {step}
<pre>🟢 Ставка: {stake} → {outcome}
📊 Цена: {openPrice} → {closePrice}</pre>`,
    { vars: tradeNotice },
  ),
  sessionTradeLost: html(
    g.Session,
    'Блок сделки в сообщении цикла сессии, проигрыш: ставка → потеря со знаком минус. Снимает кнопку «⏹» блока открытой сделки.',
    `⚡ Цикл {cycle} Шаг {step}
<pre>🔴 Ставка: {stake} → {outcome}
📊 Цена: {openPrice} → {closePrice}</pre>`,
    { vars: tradeNotice },
  ),
  sessionTradeTied: html(
    g.Session,
    'Блок сделки в сообщении цикла сессии, ничья: ставка → $0.00, ставка вернулась; следующая сделка — следующий шаг того же цикла. Снимает кнопку «⏹» блока открытой сделки.',
    `⚡ Цикл {cycle} Шаг {step}
<pre>⚪ Ставка: {stake} → {outcome}, ставка вернулась
📊 Цена: {openPrice} → {closePrice}</pre>`,
    { vars: tradeNotice },
  ),
  sessionTradeOpen: html(
    g.Session,
    'Блок открытой сделки в сообщении цикла (#700): цикл и шаг, ставка, направление, цена открытия; под ним «⏹ Остановить сессию» (#722). При расчёте правится в итог, кнопка снимается.',
    `⚡ Цикл {cycle} Шаг {step}
<pre>⏳ Ставка: {stake} · {action} · сделка открыта
📊 Цена: {openPrice} → …</pre>`,
    { vars: ['cycle', 'step', 'stake', 'action', 'openPrice'] },
  ),
  sessionAdaptiveStake: html(
    g.Session,
    'Строка сообщения цикла сессии: под блоком проигранного шага 1 сразу после проигрыша; после ничьей шага 1 — над блоком шага 2 (открытым или рассчитанным). Один раз на цикл.',
    `🔄 Адаптивная ставка включена`,
  ),
  sessionSummarySymbol: html(
    g.Session,
    "Итог сессии (со звуком): первая строка подписи картинки-итога, которую шлёт бот; под ней строки итога из сообщения сессии. Текстовый итог backend'а (запасной путь) — те же строки.",
    `📈 {symbol}`,
    { vars: ['symbol'] },
  ),

  // ---- Пополнение (#112, docs/deposit.md) -------------------------------------------------
  // Sent by the backend only, after the cashier's credited event, with the «menuButton» button.
  depositCredited: html(
    g.Deposit,
    'Push после пополнения в кассе: реальный баланс из снимка брокера, с кнопкой меню.',
    `💳 <b>Пополнение получено</b>
Реальный баланс: {realBalance}`,
    { vars: ['realBalance'] },
  ),

  // ---- Напоминания (#202, docs/mailing.md) -------------------------------------------------
  // Sent by the backend's mailing engine only; the first-session chain with the «demoButton» button.
  firstSessionReminder1h: html(
    g.Mailing,
    'Напоминание через час после подключения аккаунта, если демо-сессия ещё не запускалась.',
    `🤖 <b>Аккаунт подключён — осталось запустить демо</b>

🎮 Бот сам проведёт серию демо-сделок по сигналу, а ты посмотришь на результат.
💡 Это демо: деньги не нужны.
👇 Нажми «{demoButton}», чтобы начать.`,
    { fragments: { demoButton: 'demoButton' } },
  ),
  firstSessionReminder24h: html(
    g.Mailing,
    'Напоминание через сутки после подключения аккаунта, если демо-сессия ещё не запускалась.',
    `⏳ <b>Одними размышлениями вперёд не сдвинешься</b>

🎮 В демо-сессии бот сам торгует на демо-счёте, а ты смотришь, как он принимает решения.
💡 Деньги для этого не нужны.
👇 Нажми «{demoButton}» — и бот начнёт.`,
    { fragments: { demoButton: 'demoButton' } },
  ),
  firstSessionReminder72h: html(
    g.Mailing,
    'Напоминание через трое суток после подключения аккаунта, если демо-сессия ещё не запускалась; последнее в цепочке.',
    `🚦 <b>Этот шаг открывает всё остальное</b>

🎮 Первая демо-сессия покажет, как бот выбирает сделки и ведёт серию.
💡 Это демо: деньги не нужны.
👇 Нажми «{demoButton}» — дальше бот всё сделает сам.`,
    { fragments: { demoButton: 'demoButton' } },
  ),
  // with the «newAnalysisButton» button of the same pair and duration (#484)
  analysisUnusedReminder: html(
    g.Mailing,
    'Напоминание через 10 минут после анализа с сигналом, если сделка и сессия не запущены и другой анализ не открыт; только в демо.',
    `🧠 <b>Анализ готов, но ещё не использован</b>

📊 Анализ пары готов, а сумма сделки так и не выбрана — без неё ничего не запустится.
🔄 Сигнал за это время мог измениться, поэтому бот проверит пару заново.
👇 Нажми «{newAnalysisButton}».`,
    { fragments: { newAnalysisButton: 'newAnalysisButton' } },
  ),
  // with the «inviteMoreButton» button, the /invite screen (#576)
  referralRewarded: html(
    g.Mailing,
    'Уведомление пригласившему о награде за приглашённого, который подключил партнёрский аккаунт Binodex (#116): сумма — из строки начисления.',
    `🎁 <b>Друг подключил Binodex</b>

🪙 Начислено токенов за приглашение: +{rewardTokens}
👇 Нажми «{inviteMoreButton}», чтобы пригласить ещё.`,
    { vars: ['rewardTokens'], fragments: { inviteMoreButton: 'inviteMoreButton' } },
  ),
  // The low-token nudge (#123, docs/mailing.md → The low-token nudge): the balance against the
  // user's own starter pack, the threshold's balance in {nudgeTokens}. 50 %: the entry button
  // («demoButton», «tradeButton» in real mode), so the text does not name it; 80 % and 100 %: the
  // cashier («depositButton», or the entry without https) and «buyButton» under it. No promise of
  // tokens for a deposit (#386).
  tokensHalfUsed: html(
    g.Mailing,
    'Напоминание, когда на балансе осталось не больше половины стартового пакета токенов (для пакета 100 — 50 токенов); один раз, с кнопкой входа в торговлю.',
    `🪙 <b>Баланс токенов уменьшился</b>

Токенов на балансе: не больше {nudgeTokens}. Один токен — одна сделка автоторговли.
👇 Нажми кнопку ниже, чтобы продолжить.`,
    { vars: ['nudgeTokens'] },
  ),
  tokensLow: html(
    g.Mailing,
    'Напоминание, когда на балансе осталось не больше 20 % стартового пакета токенов (для пакета 100 — 20 токенов); один раз, с кнопками кассы и покупки токенов.',
    `⏳ <b>Токенов на балансе мало</b>

Токенов на балансе: не больше {nudgeTokens}. Один токен — одна сделка автоторговли.
👇 «{buyButton}» — пакеты токенов.`,
    { vars: ['nudgeTokens'], fragments: { buyButton: 'buyButton' } },
  ),
  tokensOut: html(
    g.Mailing,
    'Напоминание, когда токенов на балансе не осталось; один раз, с кнопками кассы и покупки токенов.',
    `🔋 <b>На балансе нет токенов</b>

Каждой сделке автоторговли нужен один токен.
👇 «{buyButton}» — пакеты токенов.`,
    { vars: ['nudgeTokens'], fragments: { buyButton: 'buyButton' } },
  ),
  // The switch to real after a deposit (#686, docs/trading-mode.md → The automatic switch after
  // a deposit): no deposit amount and no balance (clarify В6); {stake} is the real stake in use.
  realModeByDeposit: html(
    g.Mailing,
    'Сообщение после пополнения реальными деньгами, когда бот перевёл пользователя из демо в реальный режим (#686); с кнопками экрана режима и меню.',
    `💳 <b>Пополнение получено — включён реальный режим</b>

Режим: REAL. Сделки и сессии теперь идут на реальные деньги.
💵 Сумма сделки: {stake}
Вернуться в демо: /settings → «{settingsModeButton}».`,
    { vars: ['stake'], fragments: { settingsModeButton: 'settingsModeButton' } },
  ),
  // Retention (#124, docs/mailing.md → Retention): demo users only, except tokensOutStill. A push
  // may be planned late (an unblock, the level back from off), so no text names an age. Counts
  // only, no money; no promise of a result.
  inactiveReminder: html(
    g.Mailing,
    'Напоминание демо-пользователю, у которого была хотя бы одна сессия, после трёх суток без активности; не чаще раза в неделю, с кнопкой входа в демо.',
    `🌙 <b>Рынок не спит</b>

📡 Бот продолжает проверять пары на сигналы — можно посмотреть, что есть сейчас.
🎮 Это демо: деньги не нужны, бот сам проводит сделки.
👇 Нажми «{demoButton}», чтобы продолжить.`,
    { fragments: { demoButton: 'demoButton' } },
  ),
  // with «sessionRelaunchButton», the cycle's door of the session's pair, or the entry when the
  // session's settings do not name it, so the text names no button
  sessionIdleReminder: html(
    g.Mailing,
    'Напоминание через сутки после конца демо-сессии, если новая не запускалась: итог той сессии и кнопка запуска на той же паре.',
    `🔁 <b>Последняя демо-сессия завершена</b>

📊 Её итог: {result}.
🎮 Новую сессию можно запустить в один шаг.
👇 Нажми кнопку ниже.`,
    { vars: ['result'] },
  ),
  weeklySummary: html(
    g.Mailing,
    'Сводка по понедельникам (10:00 UTC) демо-пользователю со сделками за прошлую неделю: число сделок, в плюс, в минус, в ноль.',
    `📅 <b>Демо-итоги прошлой недели</b>

📊 Итог: {result}.
💡 Это демо: деньги в сделках не участвуют.
👇 Нажми «{demoButton}», чтобы продолжить.`,
    { vars: ['result'], fragments: { demoButton: 'demoButton' } },
  ),
  // after tokensOut, with the cashier («depositButton», or the entry without https) and «buyButton»
  tokensOutStill: html(
    g.Mailing,
    'Повтор через двое суток после напоминания «нет токенов», если баланс так и остался нулевым; один раз, с кнопками кассы и покупки токенов.',
    `🔋 <b>Токенов на балансе по-прежнему нет</b>

Без токенов автоторговля не запускается: каждой сделке нужен один токен.
👇 «{buyButton}» — пакеты токенов.`,
    { fragments: { buyButton: 'buyButton' } },
  ),
  sessionRelaunchButton: plain(
    g.Mailing,
    'Напоминание после демо-сессии: новая сессия на той же паре — экран суммы цикла.',
    '🔁 Запустить снова',
  ),
  // a label of the backend's message only, so in this group and not in «Кнопки» (#576)
  inviteMoreButton: plain(
    g.Mailing,
    'Уведомление о награде за приглашение: кнопка экрана приглашения (/invite).',
    '👥 Пригласить ещё',
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
  resendButton: plain(g.Buttons, 'Вход по почте: кнопка повторного запроса кода.', '🔄 Новый код'),
  changeEmailButton: plain(g.Buttons, 'Вход по почте: кнопка смены адреса.', '✏️ Изменить адрес'),
  demoButton: plain(
    g.Buttons,
    'Карточка, /menu и напоминания: вход в демо — экран «Сигналы сейчас» (#685).',
    '🎮 Демо-торговля',
  ),
  demoSignalsRefreshButton: plain(
    g.Buttons,
    'Сигналы сейчас: перечитать список пар с сигналом.',
    '🔄 Обновить',
  ),
  demoManualButton: plain(
    g.Buttons,
    'Сигналы сейчас: ручной путь — тип актива, пара, сводка, анализ.',
    '🧭 Вручную',
  ),
  launchCycleButton: plain(
    g.Buttons,
    'Экран ставки (реальный режим; в демо — экран суммы, #476): запуск цикла сделок, бот дописывает « · REAL».',
    '🚀 Запустить цикл',
  ),
  stakeChangeButton: plain(
    g.Buttons,
    'Экран ставки (реальный режим; в демо — экран суммы, #476): открыть выбор суммы.',
    '💵 Ставка',
  ),
  backToListButton: plain(
    g.Buttons,
    'Экран ставки и экран суммы цикла: назад к сигналам.',
    '↩️ К списку',
  ),
  stakeBackLaunchButton: plain(g.Buttons, 'Экран суммы: назад к экрану ставки.', '↩️ К запуску'),
  sessionAgainButton: plain(
    g.Buttons,
    'Итог сессии: новая сессия на том же активе; у реальной сессии бот дописывает « · REAL».',
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
    'Конец сделки и сессии, напоминание об анализе: анализ той же пары заново.',
    '📊 Анализ',
  ),
  toSignalsButton: plain(g.Buttons, 'Конец сделки и сессии: экран «Сигналы сейчас».', '📡 Сигналы'),
  showSignalsButton: plain(
    g.Buttons,
    'Шаг «Начать торговлю» (#664): свежий экран «Сигналы сейчас».',
    '📡 Показать сигналы',
  ),
  otherPairButton: plain(
    g.Buttons,
    'Сессия, остановленная без сигнала (#509, #637): экран «Сигналы сейчас».',
    '🔀 Выбрать другую пару',
  ),
  demoBackGroupsButton: plain(g.Buttons, 'Демо: кнопка назад к типам актива.', '↩️ Типы'),
  demoBackPairsButton: plain(g.Buttons, 'Демо: кнопка назад к активам.', '↩️ Активы'),
  demoBackPairButton: plain(g.Buttons, 'Демо: кнопка назад к сводке пары (#685).', '↩️ К паре'),
  demoPrevButton: plain(g.Buttons, 'Демо: предыдущая страница активов.', '◀️'),
  demoNextButton: plain(g.Buttons, 'Демо: следующая страница активов.', '▶️'),
  repeatAnalysisButton: plain(g.Buttons, 'Анализ: кнопка повтора анализа.', '🔄 Заново'),
  analysisMoreButton: plain(g.Buttons, 'Анализ: кнопка, раскрывающая разовую сделку.', '➕ Ещё'),
  refreshIntentButton: plain(
    g.Buttons,
    'Сделка: кнопка обновления статуса; её название цитирует текст о долгой обработке.',
    '🔄 Обновить',
  ),
  supportButton: plain(g.Buttons, '/support: кнопка чата с поддержкой.', '💬 Поддержка'),
  sessionStopButton: plain(
    g.Buttons,
    'Сессия: кнопка остановки под сообщением ожидания и под блоком открытой сделки; шлёт backend.',
    '⏹ Остановить сессию',
  ),
  stakeMenuButton: plain(
    g.Buttons,
    'Раскрытие «➕ Ещё» на анализе, /settings и отказы сделки: кнопка экрана суммы.',
    '💵 Сумма',
  ),
  stakeCustomButton: plain(g.Buttons, 'Экран суммы: кнопка своей суммы.', '✏️ Ввести'),
  stakeResetButton: plain(
    g.Buttons,
    'Экран суммы: сброс к минимальной ставке брокера.',
    '🔁 Минимум',
  ),
  stakeBackAnalysisButton: plain(
    g.Buttons,
    'Назад к анализу пары: с экрана суммы и после сбоя запуска сделки или сессии.',
    '↩️ К анализу',
  ),
  stakeBackSettingsButton: plain(g.Buttons, 'Экран суммы: назад к /settings.', '↩️ Настройки'),
  stakeBackButton: plain(g.Buttons, 'Своя сумма («✏️ Ввести»): назад к экрану суммы.', '↩️ Назад'),
  settingsStakeDemoButton: plain(
    g.Buttons,
    '/settings: кнопка смены суммы демо-сделки.',
    '💵 Демо',
  ),
  settingsStakeRealButton: plain(
    g.Buttons,
    '/settings: кнопка смены суммы реальной сделки (#326).',
    '💼 Реал',
  ),
  // in one row with «🏠 В меню» (#686): a lone navigation button is refused (lone_button)
  settingsModeButton: plain(
    g.Buttons,
    '/settings и сообщение о переходе в реальный режим после пополнения (#686): экран режима торговли.',
    '⚙️ Режим торговли',
  ),

  tradeButton: plain(
    g.Buttons,
    'Карточка статуса и напоминание о токенах (#123) в реальном режиме: вход в торговлю, как «Демо-торговля».',
    '🚀 Торговать',
  ),
  modeBackDemoButton: plain(g.Buttons, 'Экран режима: возврат в демо.', '🎮 В демо'),
  modeEnableButton: plain(
    g.Buttons,
    'Экран режима: шаг подтверждения реального режима.',
    '💼 Включить реальный режим',
  ),
  modeConfirmButton: plain(
    g.Buttons,
    'Экран режима: подтверждение реального режима.',
    '✅ Подтверждаю',
  ),
  modeCancelButton: plain(g.Buttons, 'Экран режима: отмена подтверждения.', '↩️ Отмена'),
  modeScreenButton: plain(
    g.Buttons,
    'Отказы и итоги переключения режима: снова экран режима.',
    '⚙️ Режим',
  ),
  inviteButton: plain(
    g.Buttons,
    'Карточка статуса и итог сессии: кнопка экрана приглашения.',
    '👥 Позвать',
  ),
  inviteShareButton: plain(
    g.Buttons,
    '/invite: кнопка, открывающая выбор чата для ссылки-приглашения.',
    '📤 Поделиться',
  ),
  buyButton: plain(
    g.Buttons,
    'Карточка статуса, отказ «не хватает токенов» и напоминания 80 % и 100 % о токенах (#123): экран покупки токенов.',
    '⭐ Купить',
  ),
  depositButton: plain(
    g.Buttons,
    'Карточка статуса, отказ «не хватает токенов», конец сессии и напоминания 80 % и 100 % о токенах (#123): касса пополнения (Mini App).',
    '💳 Пополнить',
  ),
  sessionShareButton: plain(
    g.Buttons,
    'Кнопка под картинкой-итогом сессии: выбор чата, куда отправить картинку.',
    '📤 Поделиться',
  ),

  // ---- Команды: описания (без emoji) --------------------------------------------------------
  startCommand: plain(g.Commands, 'Описание /start в меню команд и в /help.', 'Начать', {
    limit: COMMAND_LIMIT,
  }),
  menuCommand: plain(g.Commands, 'Описание /menu в меню команд и в /help.', 'Главное меню', {
    limit: COMMAND_LIMIT,
  }),
  stopCommand: plain(g.Commands, 'Описание /stop в меню команд и в /help.', 'Остановить сессию', {
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
  languageCommand: plain(g.Commands, 'Описание /language в меню команд и в /help.', 'Язык бота', {
    limit: COMMAND_LIMIT,
  }),
  inviteCommand: plain(
    g.Commands,
    'Описание /invite в меню команд и в /help.',
    'Пригласить друга',
    { limit: COMMAND_LIMIT },
  ),
  buyCommand: plain(g.Commands, 'Описание /buy в меню команд и в /help.', 'Купить токены', {
    limit: COMMAND_LIMIT,
  }),
  helpCommand: plain(g.Commands, 'Описание /help в меню команд и в /help.', 'Помощь', {
    limit: COMMAND_LIMIT,
  }),
  supportCommand: plain(g.Commands, 'Описание /support в меню команд и в /help.', 'Поддержка', {
    limit: COMMAND_LIMIT,
  }),
  paysupportCommand: plain(
    g.Commands,
    'Описание /paysupport в меню команд и в /help.',
    'Вопросы по оплате Stars и возврат',
    { limit: COMMAND_LIMIT },
  ),

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
  cycleStakeChoose: html(
    g.Demo,
    'Экран суммы демо-цикла (#476): под строкой цикла, над кнопками сумм.',
    `Выбери сумму сделки 👇`,
    { vars: ['firstName'] },
  ),
  stakeRiskButton: plain(
    g.Demo,
    'Экран суммы демо-цикла (#476): кнопка суммы от $10 — сумма (с ✅, если она в силе) и пометка риска.',
    `{amount} · риск`,
    { vars: ['amount'] },
  ),
  paysupportScreen: html(
    g.Stars,
    '/paysupport: заголовок над последними оплатами Stars.',
    `⭐ <b>Оплаты Telegram Stars</b>
Последние оплаты. Нужен возврат — нажми кнопку под оплатой: заявку рассмотрит сотрудник поддержки и вернёт Stars. Токены, которые уже потрачены, не возвращаются.`,
  ),
  paysupportLinePaid: html(
    g.Stars,
    '/paysupport: строка оплаты, по которой начислены токены.',
    `✅ {paymentDate} — {stars} ⭐, оплачено`,
    { vars: ['paymentDate', 'stars'] },
  ),
  paysupportLineHeld: html(
    g.Stars,
    '/paysupport: строка оплаты, которую проверяет поддержка (токены не начислены).',
    `⏳ {paymentDate} — {stars} ⭐, на проверке`,
    { vars: ['paymentDate', 'stars'] },
  ),
  paysupportLineRequested: html(
    g.Stars,
    '/paysupport: строка оплаты, по которой уже есть заявка на возврат.',
    `📨 {paymentDate} — {stars} ⭐, заявка на возврат принята`,
    { vars: ['paymentDate', 'stars'] },
  ),
  paysupportLineRefunded: html(
    g.Stars,
    '/paysupport: строка возвращённой оплаты.',
    `↩️ {paymentDate} — {stars} ⭐, возвращено`,
    { vars: ['paymentDate', 'stars'] },
  ),
  paysupportEmpty: html(
    g.Stars,
    '/paysupport без оплат Stars: под текстом кнопка поддержки.',
    `Оплат Telegram Stars нет. Вопрос по оплате — напиши в поддержку.`,
  ),
  paysupportRequested: html(
    g.Stars,
    'После «Нужен возврат»: заявка принята.',
    `📨 Заявка на возврат принята. Сотрудник поддержки проверит оплату и вернёт Stars — Telegram пришлёт уведомление о возврате.`,
  ),
  paysupportAlreadyRequested: html(
    g.Stars,
    'После «Нужен возврат»: по этой оплате заявка уже есть.',
    `Заявка на возврат этой оплаты уже есть — сотрудник поддержки её рассмотрит.`,
  ),
  paysupportAlreadyRefunded: html(
    g.Stars,
    'После «Нужен возврат»: оплата уже возвращена.',
    `Эта оплата уже возвращена.`,
  ),
  paysupportNotFound: html(
    g.Stars,
    'После «Нужен возврат»: оплата не найдена.',
    `Оплата не найдена. Открой список заново.`,
  ),
  paysupportRefundButton: plain(
    g.Stars,
    '/paysupport: кнопка заявки на возврат под оплатой.',
    '↩️ Нужен возврат: {paymentDate}',
    { vars: ['paymentDate'] },
  ),
  paysupportListButton: plain(
    g.Stars,
    'После заявки на возврат: назад к списку оплат.',
    '↩️ К списку оплат',
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
