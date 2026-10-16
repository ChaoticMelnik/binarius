// One classification of a refused edit for every message edited in place: the bot's screens (the
// /settings levels in bot.ts, the demo in demo.ts) and the backend's session cycle message (#551,
// apps/backend/src/trading/session-notices.ts); and of a refused delete, for the launch screen the
// session start removes (#418, apps/bot/src/trading-session.ts). The error is typed by its shape,
// so this package needs no grammY: a GrammyError is one.
export interface TelegramRefusal {
  error_code: number;
  description: string;
}

// What a refused editMessageText means, from Telegram's own wording (telegram-bot-api Client.cpp:
// MESSAGE_NOT_MODIFIED → "message is not modified: …", check_message → "message to edit not
// found", tdlib's edit_message_text → "message can't be edited"), always as a 400. The
// description is compared by its lead phrase, since the not-modified tail is free text, and is
// never logged: telegramErrorFields carries only the method and the code. Anything else is not
// ours to interpret. "there is no text in the message to edit" is the answer for a message whose
// text is a caption — a photo or a video, such as the session's summary card (#318): its screen
// goes anew, as for a gone one. That wording is taken from public reports of the Bot API's 400,
// not observed live here (docs/bot-session.md → The summary card).
const EDIT_ALREADY_SHOWN = 'message is not modified';
const EDIT_TARGET_GONE = [
  'message to edit not found',
  "message can't be edited",
  'there is no text in the message to edit',
] as const;

export function editRefusal(error: TelegramRefusal): 'shown' | 'gone' | undefined {
  if (error.error_code !== 400) return undefined;
  if (error.description.includes(EDIT_ALREADY_SHOWN)) return 'shown';
  if (EDIT_TARGET_GONE.some((phrase) => error.description.includes(phrase))) return 'gone';
  return undefined;
}

// What a refused deleteMessage means, always as a 400: "message to delete not found" (the server's
// check_message in telegram-bot-api Client.cpp) is a message already gone; the forbidden delete
// comes in two spellings — the server's MESSAGE_DELETE_FORBIDDEN → "message can't be deleted" and
// tdlib's pre-check "Message can't be deleted [for everyone]" (older than 48 h in a private chat) —
// so only their common "can't be deleted" is compared. The description is never logged, as for
// editRefusal.
const DELETE_TARGET_GONE = 'message to delete not found';
const DELETE_FORBIDDEN = "can't be deleted";

export function deleteRefusal(error: TelegramRefusal): 'gone' | 'forbidden' | undefined {
  if (error.error_code !== 400) return undefined;
  if (error.description.includes(DELETE_TARGET_GONE)) return 'gone';
  if (error.description.includes(DELETE_FORBIDDEN)) return 'forbidden';
  return undefined;
}
