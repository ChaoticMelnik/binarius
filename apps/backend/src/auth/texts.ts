import { telegramHtml, type TelegramHtml } from '@binarius/shared';

// What the backend itself says to a Telegram user about a login. Texts the bot sends too live in
// @binarius/shared (LINK_TEXTS); this one only the push after the OAuth callback sends.

export const AUTH_TEXTS = {
  // the state is spent by then, so retrying needs a new login, which /start begins
  oauthLoginFailed: telegramHtml`❌ Не удалось завершить вход через сайт Binodex. Попробуй ещё раз через /start.`,
} as const satisfies Record<string, TelegramHtml>;
