import type pino from 'pino';
import { GrammyError } from 'grammy';

export type Logger = Pick<pino.Logger, 'info' | 'warn' | 'error' | 'debug'>;

export interface TelegramErrorFields {
  method?: string;
  telegramErrorCode?: number;
}

// The two fields of a Bot API failure that are safe to log. `description` and `payload` are not:
// the payload holds the message we were sending (a user's own text on its way back to them),
// and no pino redact path can scrub either — they are strings and free-form objects.
export function telegramErrorFields(error: unknown): TelegramErrorFields {
  if (!(error instanceof GrammyError)) return {};
  return { method: error.method, telegramErrorCode: error.error_code };
}
