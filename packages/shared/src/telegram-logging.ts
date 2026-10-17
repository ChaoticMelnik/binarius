import { errorIdentity } from './logging';

export interface TelegramErrorFields {
  method?: string;
  telegramErrorCode?: number;
  transportError?: { name: string; code?: string };
}

interface BotApiRefusal extends Error {
  method: string;
  error_code: number;
  description: string;
}

interface TransportFailure extends Error {
  error: unknown;
}

// Typed by shape, as telegram-refusals.ts is, so this package needs no grammY. A refusal is read
// off the fields grammY's GrammyError always carries (method, error_code, description), not off
// its name: `instanceof GrammyError` did not read the name either, and an error renamed on its way
// up is still the same refusal. HttpError has no fields of its own but the wrapped `error`, so its
// name — set in grammY's constructor (grammy core/error.js) — is what tells it apart. The log-line
// tests of apps/bot and apps/backend hold the parity with the real classes.
function isBotApiRefusal(error: unknown): error is BotApiRefusal {
  const fields = error as Partial<BotApiRefusal>;
  return (
    error instanceof Error &&
    typeof fields.method === 'string' &&
    typeof fields.error_code === 'number' &&
    typeof fields.description === 'string'
  );
}

function isTransportFailure(error: unknown): error is TransportFailure {
  return error instanceof Error && error.name === 'HttpError' && 'error' in error;
}

// What is safe to record about a failed Bot API call, in the logs and in audit_log. `description`
// and `payload` are not: the payload holds the message being sent — a user's own text on its way
// back to them; from the staff bot, the staff member's login, address and the one-time code; from
// the link push (#128), the email of the Binodex account on the confirm button — and its chat_id
// is the Telegram id. No pino redact path can scrub either, because they are strings and free-form
// objects.
//
// grammY throws GrammyError only when Telegram answered `ok: false`; a transport failure or our
// own timeoutSeconds abort throws HttpError, which has no `method` field. Its own message names the
// method and, when the transport supplied one, the HTTP status, but the wrapped error is whatever
// the transport threw, and its message can quote the URL the token sits in. So the method is
// passed in where the call site knows it, and the wrapped failure is reduced to its identity,
// never its message.
export function telegramErrorFields(error: unknown, method?: string): TelegramErrorFields {
  if (isBotApiRefusal(error)) {
    return { method: error.method, telegramErrorCode: error.error_code };
  }
  const known = method === undefined ? {} : { method };
  if (isTransportFailure(error)) return { ...known, transportError: errorIdentity(error.error) };
  return known;
}
