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
    '1. Подключите аккаунт Binodex — кнопка ниже.',
    '2. Войдите на стороне брокера и вернитесь в этот чат.',
    '3. После подключения бот откроет меню.',
    '',
    'Торговля сопряжена с риском потери вложенных средств. Решения о сделках вы принимаете самостоятельно.',
  ].join('\n'),
  connectButton: 'Подключить аккаунт Binodex',
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
} as const;
