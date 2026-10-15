// Everything the cashier page says (#111). Russian, addressing the user with «вы» as the OAuth
// pages do; these are web texts, not the bot's catalog. The page script holds none of it: it only
// chooses which server-rendered block to show.

export const CASHIER_TEXTS = {
  title: 'Пополнение счёта',
  working: 'Открываем кассу…',
  widgetTitle: 'Касса Binodex',
  retryButton: 'Повторить',
  closeButton: 'Вернуться в Telegram',

  openFromTelegram: 'Откройте кассу из Telegram ещё раз.',
  busy: 'Сейчас слишком много запросов. Подождите минуту и нажмите «Повторить».',
  unavailable: 'Касса сейчас недоступна. Попробуйте ещё раз.',
  rejected: 'Не удалось открыть кассу. Напишите в поддержку: команда /support в боте.',
  demoOnly: 'Пополнение на этом сервере отключено.',
  connectFirst: 'Сначала подключите аккаунт Binodex в боте.',
  ambiguous:
    'К вашему Telegram подключено несколько аккаунтов Binodex. Напишите в поддержку: команда /support в боте.',
  blocked: 'Доступ ограничен.',
  relogin: 'Войдите в Binodex заново через бота, затем откройте кассу ещё раз.',
} as const;
