import { LINK_LABELS, LINK_TEXTS, telegramHtml, type TelegramHtml } from '@binarius/shared';

// Messages are Telegram HTML, sent with parse_mode HTML by send.ts only. Every hole goes through
// telegramHtml, which escapes it: the address in codeSent is what the user typed. A static part
// is the author's, so a literal `&` or `<` there is written as an entity — texts.test.ts runs the
// validator over every entry. Multi-line values start at column zero: indentation inside a
// template is part of the message. The texts the backend's push sends too live in LINK_TEXTS.
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
  // the number is the backend's (LINK_BONUS_TOKENS), printed as it arrives
  linkedWithBonus: (tokens: string) => telegramHtml`✅ <b>Аккаунт Binodex подключён!</b>

<blockquote>🎁 Начислено токенов автоторговли: ${tokens}</blockquote>`,
  linkedNoBonusNotPartner: telegramHtml`✅ <b>Аккаунт Binodex подключён!</b>
Стартовые токены начисляются только аккаунтам, зарегистрированным через Binarius.`,
  linkedNoBonusAlready: telegramHtml`✅ <b>Аккаунт Binodex подключён!</b>
Стартовые токены уже были начислены раньше.`,
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
