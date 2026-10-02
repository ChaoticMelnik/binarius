import {
  LINK_LABELS,
  LINK_TEXTS,
  LinkBonusSkipReason,
  telegramHtml,
  type LinkBonusGrantView,
  type TelegramHtml,
} from '@binarius/shared';

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
  cardGreeting: (firstName: string) =>
    firstName.trim() === ''
      ? telegramHtml`🎉 <b>Привет!</b>`
      : telegramHtml`🎉 <b>Привет, ${firstName.trim()}!</b>`,
  cardEmail: (email: string) => telegramHtml`📧 Аккаунт Binodex: ${email}`,
  cardBody: telegramHtml`✅ <b>Аккаунт Binodex подключён</b>

<b>Что теперь доступно</b>
🎮 Демо-торговля без риска: пробуй на демобалансе, деньги не нужны.
🤖 Автоторговля за токены: бот открывает сделки на Binodex за тебя.
📊 Баланс, токены и история сделок прямо в этом чате.
🆘 Если что-то пошло не так — напиши в поддержку.`,
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
} as const satisfies Record<string, TelegramHtml | ((value: string) => TelegramHtml)>;

// Only these three fields reach the card, so no token, code or other secret can. `email` is null
// when the address of the connected account is not known; `grant` is null when what the login
// paid is not known (the recheck after a lost answer).
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
  return bonus === null
    ? telegramHtml`${header}

${TEXTS.cardBody}`
    : telegramHtml`${header}

${TEXTS.cardBody}

${bonus}`;
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
} as const satisfies Record<string, string | ((value: string | null) => string)>;

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
