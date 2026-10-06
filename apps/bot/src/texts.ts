import {
  BrokerAccountStatus,
  isPendingLink,
  LINK_LABELS,
  LINK_TEXTS,
  LinkBonusSkipReason,
  NotificationLevel,
  telegramHtml,
  type LinkBonusGrantView,
  type LinkedAccountView,
  type TelegramHtml,
} from '@binarius/shared';
import type { BotCommand } from 'grammy/types';

// in place of an address the broker did not send; a fragment, so it is nested without a second
// escape
const UNKNOWN_ADDRESS = telegramHtml`адрес неизвестен`;
const addressOf = (email: string | null): string | TelegramHtml =>
  email === null ? UNKNOWN_ADDRESS : email;

// What the bot offers, in the account card and in /help: one source for both HTML copies (#184).
// PROFILE.description keeps its own plain copy, which Telegram does not parse.
const FEATURE_LINES = telegramHtml`🎮 Демо-торговля без риска: пробуй на демобалансе, деньги не нужны.
🤖 Автоторговля за токены: бот открывает сделки на Binodex за тебя.
📊 Баланс, токены и история сделок прямо в этом чате.`;

// The /settings buttons, also the legend of its message: one source for both (#120)
const LEVEL_LABELS = {
  [NotificationLevel.All]: '🔔 Все',
  [NotificationLevel.Reduced]: '🔕 Реже',
  [NotificationLevel.Off]: '❌ Выключить',
} as const satisfies Record<NotificationLevel, string>;

// Messages are Telegram HTML, sent with parse_mode HTML by send.ts only. Every hole goes through
// telegramHtml, which escapes it: the address in codeSent is what the user typed, the name on the
// account card is what the user put in Telegram. A static part is the author's, so a literal `&`
// or `<` there is written as an entity — texts.test.ts runs the validator over every entry. The
// texts the backend's push sends too live in LINK_TEXTS.
export const TEXTS = {
  ...LINK_TEXTS,
  welcome: telegramHtml`🚀 <b>Binarius — торговля на Binodex прямо в Telegram</b>

Подключи аккаунт Binodex, и бот откроет меню.

<b>Как подключить</b>
1️⃣ Нажми «🔗 Подключить аккаунт Binodex» и пришли адрес электронной почты.
2️⃣ Пришли код из письма. Если аккаунта ещё нет, Binodex создаст его.
3️⃣ Готово — аккаунт подключён, бот открывает меню.

🌐 Удобнее через браузер? Кнопка «🌐 Войти через сайт Binodex» подключит аккаунт на сайте брокера.`,
  welcomeBack: telegramHtml`👋 <b>С возвращением!</b>
Аккаунт Binodex уже подключён.`,
  // the link's lifetime is the backend's (OAUTH_STATE_TTL_MS) and is deliberately not repeated here
  loginLink: telegramHtml`🌐 <b>Вход через сайт Binodex</b>
Открой вход по кнопке ниже, а затем вернись в этот чат.`,
  unavailable: telegramHtml`⚠️ Сервис временно недоступен. Попробуй позже.`,
  // The account card (#200): the caption of its photo, or the text when the photo is refused,
  // assembled by accountCard below. The name is Telegram's first_name: the Bot API guarantees it
  // non-empty, not non-blank, and a padded name would pad the line.
  cardGreeting: (firstName: string) => {
    const name = firstName.trim();
    return name === '' ? telegramHtml`🎉 <b>Привет!</b>` : telegramHtml`🎉 <b>Привет, ${name}!</b>`;
  },
  cardEmail: (email: string) => telegramHtml`📧 Аккаунт Binodex: ${email}`,
  cardBody: telegramHtml`✅ <b>Аккаунт Binodex подключён</b>

<b>Что теперь доступно</b>
${FEATURE_LINES}
🆘 Если что-то пошло не так — напиши в поддержку: /support`,
  // the number is the backend's (LINK_BONUS_TOKENS), printed as it arrives
  cardBonusGranted: (tokens: string) =>
    telegramHtml`<blockquote>🎁 Начислено токенов автоторговли: ${tokens}</blockquote>`,
  cardBonusNotPartner: telegramHtml`ℹ️ Стартовые токены начисляются только аккаунтам, зарегистрированным через Binarius.`,
  cardBonusAlready: telegramHtml`ℹ️ Стартовые токены уже были начислены раньше.`,
  confirmNotFound: telegramHtml`❌ Привязка не найдена. Начни подключение заново через /start.`,
  confirmAlreadyDone: telegramHtml`❌ Эта привязка уже подтверждена или больше не ждёт подтверждения.`,
  // the email dialog; the backend's limits and the dialog's lifetime are not repeated here,
  // for the same reason as loginLink
  emailPrompt: telegramHtml`📧 <b>Пришли адрес электронной почты</b>
Тот, на который зарегистрирован аккаунт Binodex. Если аккаунта ещё нет, Binodex создаст его на этот адрес.`,
  emailInvalid: telegramHtml`❌ Это не похоже на адрес электронной почты. Пришли адрес вида name@example.com.`,
  emailRefused: telegramHtml`❌ Binodex не принял этот адрес. Проверь его и пришли ещё раз.`,
  // the address is the one the user just typed, shown back so a typo is visible next to the
  // button that fixes it
  codeSent: (email: string) => telegramHtml`📩 <b>Код отправлен на ${email}</b>
Пришли его сюда одним сообщением.`,
  codeInvalid: telegramHtml`❌ Код не подошёл: он неверный или устарел. Пришли код ещё раз или запроси новый.`,
  tooManyCodeRequests: telegramHtml`⚠️ Слишком много запросов кода. Подожди несколько минут и начни заново через /start.`,
  // the route's ceiling across all users (too_many_requests): nothing of this user's was spent,
  // so the step stays and the same message is asked for again
  sendCodeBusy: telegramHtml`⚠️ Сейчас слишком много запросов. Подожди немного и пришли адрес ещё раз.`,
  loginBusy: telegramHtml`⚠️ Сейчас слишком много запросов. Подожди немного и пришли код ещё раз.`,
  // a new code refused either way: the one already sent is still good
  resendRefused: telegramHtml`⚠️ Новый код сейчас запросить нельзя: слишком много запросов. Если письмо с кодом уже пришло — пришли код из него.`,
  // the send-code answer was lost or broken, and the letter may still have gone out
  codeSentUnknown: (
    email: string,
  ) => telegramHtml`⚠️ Не удалось подтвердить отправку кода на ${email}.
Если письмо пришло — пришли код из него. Если нет — нажми «🔄 Запросить код ещё раз».`,
  tooManyCodeAttempts: telegramHtml`⚠️ Слишком много попыток ввести код. Подожди несколько минут и начни заново через /start.`,
  // «🔄 Запросить код ещё раз» with no dialog behind it: expired, finished by a login, or dropped
  // by a restart — the bot cannot tell which, so the text must hold for all of them
  codeRequestStale: telegramHtml`⚠️ Этот запрос кода уже не действует. Если аккаунт ещё не подключён, начни заново через /start.`,
  // /account (#185), assembled by accountStatus below: a header, a blank line, one line per link
  accountNone: telegramHtml`❌ <b>Аккаунт Binodex не подключён</b>
Подключи его: по почте или через сайт Binodex — кнопки ниже.`,
  // the header when at least one link is active
  accountConnected: telegramHtml`✅ <b>Аккаунт Binodex подключён</b>`,
  // the header when no link is active and one waits
  accountPending: telegramHtml`⏳ <b>Привязка ждёт подтверждения</b>
Если вход выполнял ты — подтверди её по кнопке ниже.`,
  // the header when every link is revoked
  accountRevoked: telegramHtml`⚠️ <b>Подключение Binodex отозвано</b>
Войди заново: по почте или через сайт Binodex — кнопки ниже.`,
  accountLineActive: (email: string | null) => telegramHtml`✅ Подключён: ${addressOf(email)}`,
  accountLinePending: (email: string | null) =>
    telegramHtml`⏳ Ждёт подтверждения: ${addressOf(email)}`,
  accountLineRevoked: (email: string | null) =>
    telegramHtml`⚠️ Подключение отозвано: ${addressOf(email)}`,
  accountUnknownAddress: UNKNOWN_ADDRESS,
  // /settings (#120); the hole is the current level's label (settingsText below)
  settings: (current: string) => telegramHtml`🔔 <b>Уведомления</b>
Так бот присылает напоминания и подсказки — например, когда ты ещё не начал демо.
Ответы на твои команды и итоги твоих сделок приходят всегда.

Сейчас выбрано: <b>${current}</b>

${LEVEL_LABELS.all} — каждое напоминание.
${LEVEL_LABELS.reduced} — не чаще одного в день.
${LEVEL_LABELS.off} — никаких напоминаний.`,
  // /support (#120), sent with the url button to SUPPORT's account
  support: telegramHtml`🆘 <b>Поддержка</b>
Если что-то пошло не так или есть вопрос — напиши нам.
👇 Нажми кнопку ниже, откроется чат с поддержкой.`,
  // /help (#184), assembled by helpText below. The command lines are not here: commands.ts
  // imports LABELS from this file, so BOT_COMMANDS is passed in by bot.ts instead of imported.
  helpAbout: telegramHtml`ℹ️ <b>Что умеет Binarius</b>
${FEATURE_LINES}`,
  helpConnect: telegramHtml`<b>Как подключить аккаунт Binodex</b>
Если аккаунт ещё не подключён, нажми /start и выбери способ:
📧 «🔗 Подключить аккаунт Binodex» — пришли адрес почты и код из письма.
🌐 «🌐 Войти через сайт Binodex» — вход на сайте брокера.`,
  helpCommands: telegramHtml`<b>Команды</b>`,
} as const satisfies Record<string, TelegramHtml | ((value: string) => TelegramHtml)>;

// The /help message: the three blocks, then one line per command in the menu's order.
export function helpText(commands: readonly BotCommand[]): TelegramHtml {
  // a hole holding an array is joined without a separator, so each line carries its newline
  const lines = commands.map(
    ({ command, description }) => telegramHtml`
/${command} — ${description}`,
  );
  return telegramHtml`${TEXTS.helpAbout}

${TEXTS.helpConnect}

${TEXTS.helpCommands}${lines}`;
}

// What /account says about the user's links, in the order given (newest first). No link at all
// is accountNone; otherwise the header follows the best link there is.
export function accountStatus(accounts: readonly LinkedAccountView[]): TelegramHtml {
  const [first, ...rest] = accounts.map(accountLine);
  if (first === undefined) return TEXTS.accountNone;
  const header = accounts.some((account) => account.status === BrokerAccountStatus.Active)
    ? TEXTS.accountConnected
    : accounts.some(isPendingLink)
      ? TEXTS.accountPending
      : TEXTS.accountRevoked;
  // a hole holding an array is joined without a separator, so the newlines are written here
  const lines = rest.reduce(
    (joined, line) => telegramHtml`${joined}
${line}`,
    first,
  );
  return telegramHtml`${header}

${lines}`;
}

function accountLine(account: LinkedAccountView): TelegramHtml {
  switch (account.status) {
    case BrokerAccountStatus.Active:
      return TEXTS.accountLineActive(account.email);
    case BrokerAccountStatus.Pending:
      return TEXTS.accountLinePending(account.email);
    case BrokerAccountStatus.Revoked:
      return TEXTS.accountLineRevoked(account.email);
  }
}

// Only these three fields reach the card, so no token, code or other secret can. `email` is null
// when the address of the connected account is not known — the broker sent none or a blank one
// (addressOrNull), or the recheck after a lost answer; `grant` is null when what the login paid
// is not known (that recheck).
export interface AccountCardInput {
  firstName: string;
  email: string | null;
  grant: LinkBonusGrantView | null;
}

// Blocks separated by one blank line; an absent block takes its blank line with it.
export function accountCard({ firstName, email, grant }: AccountCardInput): TelegramHtml {
  const greeting = TEXTS.cardGreeting(firstName);
  const header =
    email === null
      ? greeting
      : telegramHtml`${greeting}
${TEXTS.cardEmail(email)}`;
  const bonus = bonusOf(grant);
  const tail = bonus === null ? [] : [telegramHtml`\n\n${bonus}`];
  return telegramHtml`${header}

${TEXTS.cardBody}${tail}`;
}

function bonusOf(grant: LinkBonusGrantView | null): TelegramHtml | null {
  if (grant === null) return null;
  if (grant.granted) return TEXTS.cardBonusGranted(grant.tokens);
  return grant.reason === LinkBonusSkipReason.NotPartnerClient
    ? TEXTS.cardBonusNotPartner
    : TEXTS.cardBonusAlready;
}

// Button labels and the command description: Telegram does not parse them, so they are plain
// strings and are never escaped — an entity here would be shown literally.
export const LABELS = {
  ...LINK_LABELS,
  connectButton: '🔗 Подключить аккаунт Binodex',
  oauthButton: '🌐 Войти через сайт Binodex',
  loginButton: '🌐 Войти в Binodex',
  resendButton: '🔄 Запросить код ещё раз',
  changeEmailButton: '✏️ Изменить адрес',
  // the description of /start in Telegram's command menu, not a button, so no emoji (owner,
  // 2026-10-02); the Bot API bounds it at 256 characters, held by commands.test.ts
  startCommand: 'Начать',
  // the description of /account, plain like startCommand (#185)
  accountCommand: 'Аккаунт Binodex',
  // the descriptions of /settings and /support, plain like startCommand (#120)
  settingsCommand: 'Настройки уведомлений',
  supportCommand: 'Поддержка',
  // the description of /help, plain like startCommand (#184)
  helpCommand: 'Помощь',
  supportButton: '💬 Написать в поддержку',
} as const satisfies Record<string, string | ((value: string | null) => string)>;

export const levelLabel = (level: NotificationLevel): string => LEVEL_LABELS[level];
// the label of the level that is selected now, on its button
export const currentLevelLabel = (level: NotificationLevel): string => `${levelLabel(level)} ✅`;
export const settingsText = (level: NotificationLevel): TelegramHtml =>
  TEXTS.settings(levelLabel(level));

// Where /support leads (#120). A temporary personal account: #220 replaces it, and this is the one
// line to change.
export const SUPPORT = { telegramUsername: 'dimmelya' } as const;
export const supportUrl = (): string => `https://t.me/${SUPPORT.telegramUsername}`;

// The bot's profile: `description` is the «Что умеет этот бот?» block an empty chat shows before
// Start, `shortDescription` the line on the profile page and in the preview of a shared link.
// Telegram parses neither, so like LABELS they are plain and never escaped; line breaks are kept
// as written. The Bot API limits (512 and 120) are held by texts.test.ts.
export const PROFILE = {
  description: `🚀 Binarius — торговля на Binodex прямо в Telegram.

🎮 Демо-торговля без риска: пробуй на демобалансе, деньги не нужны.
🤖 Автоторговля за токены: бот открывает сделки на Binodex за тебя.
📊 Баланс, токены и история сделок — прямо в этом чате.
📧 Подключение за минуту: пришли адрес электронной почты и код из письма.

👉 Нажми «Запустить» — и начнём.`,
  shortDescription:
    '🚀 Торговля на Binodex прямо в Telegram: демо без риска и автоторговля за токены',
} as const satisfies Record<string, string>;
