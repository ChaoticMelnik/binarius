import { LINK_TEXTS } from '@binarius/shared';

// Sent without parse_mode: the confirm button carries the email the broker reported, which is
// someone else's data, and plain text can neither be broken by a stray underscore in it nor
// turned into markup by it. The texts the backend's push sends too live in LINK_TEXTS.
export const TEXTS = {
  ...LINK_TEXTS,
  welcome: [
    'Binarius — торговля на Binodex прямо в Telegram.',
    '',
    'Что дальше:',
    '1. Нажмите «Подключить аккаунт Binodex» и пришлите адрес электронной почты.',
    '2. Пришлите код из письма — аккаунт подключится, а если его ещё нет, Binodex его создаст.',
    '3. После подключения бот откроет меню.',
    '',
    'Удобнее через браузер? Кнопка «Войти через сайт Binodex» подключит аккаунт на сайте брокера.',
  ].join('\n'),
  connectButton: 'Подключить аккаунт Binodex',
  oauthButton: 'Войти через сайт Binodex',
  welcomeBack: 'С возвращением! Аккаунт Binodex уже подключён.',
  // the link's lifetime is the backend's (OAUTH_STATE_TTL_MS) and is deliberately not repeated here
  loginLink: 'Откройте вход в Binodex по кнопке ниже, а затем вернитесь в этот чат.',
  loginButton: 'Войти в Binodex',
  unavailable: 'Сервис временно недоступен. Попробуйте позже.',
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
  // the route's ceiling across all users (too_many_requests): nothing of this user's was spent,
  // so the step stays and the same message is asked for again
  sendCodeBusy: 'Сейчас слишком много запросов. Подождите немного и пришлите адрес ещё раз.',
  loginBusy: 'Сейчас слишком много запросов. Подождите немного и пришлите код ещё раз.',
  // a new code refused either way: the one already sent is still good
  resendRefused:
    'Новый код сейчас запросить нельзя: слишком много запросов. Если письмо с кодом уже пришло — пришлите код из него.',
  // the send-code answer was lost or broken, and the letter may still have gone out
  codeSentUnknown: (email: string) =>
    `Не удалось подтвердить отправку кода на ${email}. Если письмо пришло — пришлите код из него. Если нет — нажмите «Запросить код ещё раз».`,
  tooManyCodeAttempts:
    'Слишком много попыток ввести код. Подождите несколько минут и начните заново через /start.',
  // «Запросить код ещё раз» with no dialog behind it: expired, finished by a login, or dropped by
  // a restart — the bot cannot tell which, so the text must hold for all of them
  codeRequestStale:
    'Этот запрос кода уже не действует. Если аккаунт ещё не подключён, начните заново через /start.',
  // the description of /start in Telegram's command menu; the Bot API bounds it at 256
  // characters, held by commands.test.ts
  startCommand: 'Начать',
} as const;
