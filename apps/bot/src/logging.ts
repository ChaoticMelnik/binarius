import type pino from 'pino';
import { GrammyError, HttpError } from 'grammy';
import { errorIdentity } from '@binarius/shared';

export type Logger = Pick<pino.Logger, 'info' | 'warn' | 'error' | 'debug'>;

export interface TelegramErrorFields {
  method?: string;
  telegramErrorCode?: number;
  transportError?: { name: string; code?: string };
}

// What is safe to log about a failed Bot API call. `description` and `payload` are not: the
// payload holds the message we were sending (a user's own text on its way back to them), and
// no pino redact path can scrub either — they are strings and free-form objects.
//
// grammY throws GrammyError only when Telegram answered `ok: false`; a transport failure or
// our own timeoutSeconds abort throws HttpError, which carries no method and whose message
// quotes the URL the token sits in. So the method is passed in where the call site knows it,
// and the wrapped failure is reduced to its identity, never its message.
export function telegramErrorFields(error: unknown, method?: string): TelegramErrorFields {
  if (error instanceof GrammyError) {
    return { method: error.method, telegramErrorCode: error.error_code };
  }
  const known = method === undefined ? {} : { method };
  if (error instanceof HttpError) return { ...known, transportError: errorIdentity(error.error) };
  return known;
}
