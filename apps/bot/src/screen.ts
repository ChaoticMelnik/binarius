import type { GrammyError } from 'grammy';

// One classification of a refused edit for every screen edited in place: the /settings levels
// (bot.ts) and the demo (demo.ts).

// What a refused editMessageText means, from Telegram's own wording (telegram-bot-api Client.cpp:
// MESSAGE_NOT_MODIFIED → "message is not modified: …", check_message → "message to edit not
// found", tdlib's edit_message_text → "message can't be edited"), always as a 400. The
// description is compared by its lead phrase, since the not-modified tail is free text, and is
// never logged: telegramErrorFields carries only the method and the code. Anything else is not
// ours to interpret.
const EDIT_ALREADY_SHOWN = 'message is not modified';
const EDIT_TARGET_GONE = ['message to edit not found', "message can't be edited"] as const;

export function editRefusal(error: GrammyError): 'shown' | 'gone' | undefined {
  if (error.error_code !== 400) return undefined;
  if (error.description.includes(EDIT_ALREADY_SHOWN)) return 'shown';
  if (EDIT_TARGET_GONE.some((phrase) => error.description.includes(phrase))) return 'gone';
  return undefined;
}
