// Everything the Mini App login pages say. Russian, per the project's language convention. The
// page script holds none of it: it only chooses which server-rendered block to show.

export const OAUTH_TEXTS = {
  loginTitle: 'Вход через Binodex',
  redirecting: 'Переходим на сайт Binodex…',
  authorizeLink: 'Перейти на сайт Binodex',

  callbackTitle: 'Вход через Binodex',
  working: 'Проверяем вход…',
  closeButton: 'Вернуться в Telegram',

  linked: 'Готово. Вернитесь в Telegram — бот прислал сообщение о подключении.',
  openFromTelegram: 'Откройте вход из Telegram ещё раз.',
  busy: 'Сейчас слишком много запросов. Через минуту откройте вход из Telegram ещё раз.',
  startOver: 'Ссылка для входа устарела. Начните заново через /start.',
  blocked: 'Доступ ограничен.',
  taken: 'Этот аккаунт Binodex уже подключён к другому пользователю Telegram.',
  unknown:
    'Не удалось получить результат входа. Вернитесь в Telegram: если вход прошёл, бот прислал сообщение, иначе начните заново через /start.',

  refusedTitle: 'Вход не начат',
  refusedLogin: 'Ссылка для входа неверна. Начните заново из бота.',
  refusedCallbackTitle: 'Вход не завершён',
  refusedCallback: 'Не удалось завершить вход. Начните заново из бота.',
} as const;
