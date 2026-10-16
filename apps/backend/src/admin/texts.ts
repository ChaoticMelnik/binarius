import { ServiceAccountNotWorkingReason } from '@binarius/shared';

// Everything the staff bot says. Russian, per the project's language convention; the code
// around it is English.

const SERVICE_ACCOUNT_REASON_LABELS = {
  [ServiceAccountNotWorkingReason.UserBlocked]: 'пользователь заблокирован',
  [ServiceAccountNotWorkingReason.Pending]: 'не подтверждён в боте',
  [ServiceAccountNotWorkingReason.Revoked]: 'отозван',
  [ServiceAccountNotWorkingReason.TokenExpired]: 'токен истёк',
} as const satisfies Record<ServiceAccountNotWorkingReason, string>;

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

  // A refund asked for from the client bot's /paysupport (#118, docs/stars.md → /paysupport). The
  // command is the one a staff member runs on the server; the reason is theirs to write.
  refundRequested: ({
    chargeId,
    packageCode,
    stars,
    status,
    payerTelegramUserId,
  }: {
    chargeId: string;
    packageCode: string;
    stars: number;
    status: string;
    payerTelegramUserId: string;
  }): string =>
    [
      'Запрос возврата Stars из /paysupport.',
      `Оплата: ${chargeId}`,
      `Пакет: ${packageCode}, ${String(stars)} ⭐, статус ${status}`,
      `Плательщик: ${payerTelegramUserId}`,
      '',
      'Команда на сервере:',
      `pnpm --filter @binarius/backend stars refund ${chargeId} --reason "…"`,
    ].join('\n'),

  confirmButton: 'Подтвердить вход',
  denyButton: 'Это не я',

  code: (code: string): string =>
    [
      `Код для входа: ${code}`,
      'Он действует 5 минут и используется один раз.',
      'Никому не сообщайте код: сотрудники Binarius его никогда не спрашивают.',
    ].join('\n'),

  // The service-account alerts (#391, docs/service-accounts.md → The alert). Plain text, no
  // token and no account id: the label is the broker email, or the broker's user id without one.
  serviceAccountsBelow: ({
    working,
    marked,
    min,
    notWorking,
  }: {
    working: number;
    marked: number;
    min: number;
    notWorking: {
      label: string;
      reason: ServiceAccountNotWorkingReason;
      revokedReason: string | null;
    }[];
  }): string =>
    [
      `Служебных аккаунтов брокера в работе: ${String(working)} из минимум ${String(min)} (отмечено: ${String(marked)}).`,
      ...(notWorking.length === 0
        ? []
        : [
            'Не в работе:',
            ...notWorking.map(
              ({ label, reason, revokedReason }) =>
                `— ${label}: ${SERVICE_ACCOUNT_REASON_LABELS[reason]}${
                  reason === ServiceAccountNotWorkingReason.Revoked && revokedReason !== null
                    ? ` (${revokedReason})`
                    : ''
                }`,
            ),
          ]),
    ].join('\n'),

  serviceAccountsRestored: ({ working, min }: { working: number; min: number }): string =>
    `Служебные аккаунты брокера восстановлены: в работе ${String(working)} из минимум ${String(min)}.`,

  // Button answers: they go out through answerCallbackQuery, whose text the Bot API caps at 200
  // characters. texts.test.ts lists them by name, so a new one needs a line there too.
  confirmed: 'Код отправлен.',
  codeFailed: 'Не удалось отправить код. Попытка закрыта — начните вход заново.',
  denied: 'Вход отклонён, событие записано.',
  stale: 'Запрос устарел или уже обработан.',
} as const;
