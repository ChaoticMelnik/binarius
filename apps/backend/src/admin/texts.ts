// Everything the staff bot says. Russian, per the project's language convention; the code
// around it is English.

export const ADMIN_TEXTS = {
  start: (telegramUserId: string): string =>
    [
      'Это служебный бот Binarius для входа сотрудников в админку.',
      `Ваш Telegram ID: ${telegramUserId}`,
      'Передайте его тому, кто заводит учётную запись.',
    ].join('\n'),

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
    [`Код для входа: ${code}`, 'Он действует 5 минут и используется один раз.'].join('\n'),

  confirmed: 'Код отправлен.',
  denied: 'Вход отклонён, событие записано.',
  stale: 'Запрос устарел или уже обработан.',
  unavailable: 'Не удалось обработать запрос. Попробуйте войти заново.',
} as const;
