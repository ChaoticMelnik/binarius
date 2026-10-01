// Bot API limits the texts below have to fit in. The welcome is the tight one: with a video it
// travels as a caption, and sendVideo takes "0-1024 characters after entities parsing".
export const CAPTION_LIMIT = 1024;
export const MESSAGE_LIMIT = 4096;

// Sent without parse_mode: the confirm button carries the email the broker reported, which is
// someone else's data, and plain text can neither be broken by a stray underscore in it nor
// turned into markup by it.
export const TEXTS = {
  welcome: [
    'Binarius — торговля на Binodex прямо в Telegram.',
    '',
    'Что дальше:',
    '1. Нажмите «Подключить аккаунт Binodex» и пришлите адрес электронной почты.',
    '2. Пришлите код из письма — аккаунт подключится, а если его ещё нет, Binodex его создаст.',
    '3. После подключения бот откроет меню.',
    '',
    'Удобнее через браузер? Кнопка «Войти через сайт Binodex» подключит аккаунт на сайте брокера.',
    '',
    'Торговля сопряжена с риском потери вложенных средств. Решения о сделках вы принимаете самостоятельно.',
  ].join('\n'),
  connectButton: 'Подключить аккаунт Binodex',
  oauthButton: 'Войти через сайт Binodex',
  welcomeBack: 'С возвращением! Аккаунт Binodex уже подключён.',
  // the link's lifetime is the backend's (OAUTH_STATE_TTL_MS) and is deliberately not repeated here
  loginLink: 'Откройте вход в Binodex по кнопке ниже, а затем вернитесь в этот чат.',
  loginButton: 'Войти в Binodex',
  blocked: 'Доступ ограничен. Если это ошибка, напишите в поддержку.',
  unavailable: 'Сервис временно недоступен. Попробуйте позже.',
  confirmPrompt: 'Найдена новая привязка аккаунта Binodex. Если вход выполняли вы — подтвердите.',
  confirmButton: (email: string | null) =>
    email === null ? 'Подтвердить привязку' : `Подтвердить: ${email}`,
  // the number is the backend's (LINK_BONUS_TOKENS), printed as it arrives
  linkedWithBonus: (tokens: string) =>
    `Аккаунт Binodex подключён. Начислено токенов автоторговли: ${tokens}.`,
  linkedNoBonusNotPartner:
    'Аккаунт Binodex подключён. Стартовые токены начисляются только аккаунтам, зарегистрированным через Binarius.',
  linkedNoBonusAlready: 'Аккаунт Binodex подключён. Стартовые токены уже были начислены ранее.',
  confirmNotFound: 'Привязка не найдена. Начните подключение заново через /start.',
  confirmAlreadyDone: 'Эта привязка уже подтверждена или больше не ожидает подтверждения.',
  // the email dialog; the backend's limits and the dialog's lifetime are not repeated here,
  // for the same reason as loginLink
  emailPrompt:
    'Пришлите адрес электронной почты аккаунта Binodex. Если аккаунта ещё нет, Binodex создаст его на этот адрес.',
  emailInvalid: 'Это не похоже на адрес электронной почты. Пришлите адрес вида name@example.com.',
  emailRefused: 'Binodex не принял этот адрес. Проверьте его и пришлите ещё раз.',
  // the address is the one the user just typed, shown back so a typo is visible next to the
  // button that fixes it
  codeSent: (email: string) => `Код отправлен на ${email}. Пришлите его сюда одним сообщением.`,
  codeInvalid: 'Код не подошёл: он неверный или устарел. Пришлите код ещё раз или запросите новый.',
  resendButton: 'Запросить код ещё раз',
  changeEmailButton: 'Изменить адрес',
  tooManyCodeRequests:
    'Слишком много запросов кода. Подождите несколько минут и начните заново через /start.',
  tooManyCodeAttempts:
    'Слишком много попыток ввести код. Подождите несколько минут и начните заново через /start.',
  accountTaken:
    'Этот аккаунт Binodex уже подключён к другому пользователю Telegram. Если это ошибка, напишите в поддержку.',
  // the recheck after an unknown outcome knows the account is active, not what was paid
  linkedActive: 'Аккаунт Binodex подключён.',
  dialogExpired: 'Время ожидания кода истекло. Начните заново через /start.',
} as const;
