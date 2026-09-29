import { GrammyError, HttpError } from 'grammy';
import { errorIdentity } from '@binarius/shared';

export interface TelegramErrorFields {
  method?: string;
  telegramErrorCode?: number;
  transportError?: { name: string; code?: string };
}

// What is safe to record about a failed Bot API call, here and in audit_log. `description` and
// `payload` are not: the payload holds the message being sent — for this bot, the staff
// member's login, address and the one-time code — and no pino redact path can scrub either,
// because they are strings and free-form objects.
//
// grammY throws GrammyError only when Telegram answered `ok: false`; a transport failure or our
// own timeoutSeconds abort throws HttpError, which has no `method` field, so the method is
// passed in where the call site knows it and the wrapped failure is reduced to its identity.
//
// A copy of apps/bot/src/logging.ts rather than a shared module: it is grammY-specific and
// packages/shared depends on no framework. Unifying the two is separate work.
export function telegramErrorFields(error: unknown, method?: string): TelegramErrorFields {
  if (error instanceof GrammyError) {
    return { method: error.method, telegramErrorCode: error.error_code };
  }
  const known = method === undefined ? {} : { method };
  if (error instanceof HttpError) return { ...known, transportError: errorIdentity(error.error) };
  return known;
}
