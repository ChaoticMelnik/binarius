// Everything the staff bot says. Russian, per the project's language convention; the code
// around it is English.

export const ADMIN_TEXTS = {
  // /start for an active staff member: the button that sends a login link (#448)
  start:
    'Это служебный бот Binarius для входа сотрудников в админку. Нажмите «Войти в админку», чтобы получить ссылку для входа.',

  // One template for everyone who is not an active staff member — nobody's account and a
  // disabled one alike — so the answer says nothing about which it is. The id is the sender's
  // own: it is how the operator learns the id to create an account with.
  noAccess: (telegramUserId: string): string =>
    [
      'Доступа нет.',
      `Ваш Telegram ID: ${telegramUserId}`,
      'Передайте его тому, кто заводит учётную запись.',
    ].join('\n'),

  linkButton: 'Войти в админку',

  link: (url: string): string =>
    [
      'Ссылка для входа в админку:',
      url,
      '',
      'Она действует 5 минут и открывается один раз. Никому её не пересылайте.',
    ].join('\n'),

  linkFailed: 'Не удалось отправить ссылку. Нажмите кнопку ещё раз.',
  linkRateLimited: 'Слишком много ссылок за 15 минут. Попробуйте позже.',

  // Everything the person needs to recognise the attempt as theirs, or to refuse it. The login
  // is here on purpose: one Telegram account belongs to one staff member, so it tells them
  // which account is being entered, not someone else's.
  prompt: ({
    login,
    ip,
    userAgent,
    at,
  }: {
    login: string;
    ip: string;
    userAgent: string;
    at: string;
  }): string =>
    [
      'Запрос на вход в админку.',
      `Учётная запись: ${login}`,
      `Адрес: ${ip}`,
      `Браузер: ${userAgent === '' ? 'не указан' : userAgent}`,
      `Время: ${at}`,
      '',
      'Если это не вы — нажмите «Это не я», и мы запишем попытку.',
    ].join('\n'),

  confirmButton: 'Подтвердить вход',
  denyButton: 'Это не я',

  code: (code: string): string =>
    [
      `Код для входа: ${code}`,
      'Он действует 5 минут и используется один раз.',
      'Никому не сообщайте код: сотрудники Binarius его никогда не спрашивают.',
    ].join('\n'),

  // Button answers: they go out through answerCallbackQuery, whose text the Bot API caps at 200
  // characters. texts.test.ts lists them by name, so a new one needs a line there too.
  confirmed: 'Код отправлен.',
  codeFailed: 'Не удалось отправить код. Попытка закрыта — начните вход заново.',
  denied: 'Вход отклонён, событие записано.',
  stale: 'Запрос устарел или уже обработан.',
} as const;
