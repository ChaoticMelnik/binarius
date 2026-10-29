import type { Api } from 'grammy';
import type { Update } from 'grammy/types';
import { capturePushApi } from '@binarius/backend/e2e';
import { BOT_INFO, captureApi, inlineButtons, USER, type ApiCall } from '@binarius/bot/e2e';
import type { Bot } from 'grammy';

// Methods whose result is a message: the bot and the push read its message_id (a delete, an edit,
// a pin, the status message the tracker edits), the summary card reads the photo's file_id, the
// wait for a signal the animation's (#859). editMessageMedia answers by the media it was given.
const MESSAGE_METHODS = ['sendMessage', 'sendVideo', 'editMessageText', 'editMessageCaption'];
const MEDIA_METHODS = ['sendPhoto', 'sendAnimation', 'editMessageMedia'];

export interface TelegramSide {
  calls: ApiCall[];
  // the message_id each call answered with or edited
  messageIdOf(call: ApiCall): number | undefined;
  callsOf(method: string): ApiCall[];
}

// Both senders of the run share one message_id sequence, so an id the push sent can never be taken
// for one the bot sent.
export function createTelegram() {
  let lastMessageId = 1_000;
  const ids = new WeakMap<Record<string, unknown>, number>();

  function program(answers: Map<string, (payload: Record<string, unknown>) => unknown>) {
    const kindOf = (method: string, payload: Record<string, unknown>) => {
      if (method === 'sendPhoto') return 'photo';
      if (method === 'sendAnimation') return 'animation';
      return (payload.media as { type?: string } | undefined)?.type === 'animation'
        ? 'animation'
        : 'photo';
    };
    const message = (payload: Record<string, unknown>, media: 'photo' | 'animation' | null) => {
      const edited = typeof payload.message_id === 'number' ? payload.message_id : undefined;
      const id = edited ?? (lastMessageId += 1);
      ids.set(payload, id);
      return {
        message_id: id,
        date: Math.floor(Date.now() / 1000),
        chat: { id: USER.id, type: 'private', first_name: USER.first_name },
        ...(media === 'animation'
          ? {
              animation: {
                file_id: `animation-${id}`,
                file_unique_id: `u-${id}-a`,
                width: 640,
                height: 320,
                duration: 2,
              },
            }
          : {}),
        ...(media === 'photo'
          ? {
              photo: [
                { file_id: `photo-${id}-s`, file_unique_id: `u-${id}-s`, width: 90, height: 90 },
                { file_id: `photo-${id}-l`, file_unique_id: `u-${id}-l`, width: 900, height: 900 },
              ],
            }
          : {}),
      };
    };
    for (const method of MESSAGE_METHODS) answers.set(method, (payload) => message(payload, null));
    for (const method of MEDIA_METHODS) {
      answers.set(method, (payload) => message(payload, kindOf(method, payload)));
    }
  }

  const side = (calls: ApiCall[]): TelegramSide => ({
    calls,
    messageIdOf: (call) => ids.get(call.payload),
    callsOf: (method) => calls.filter((call) => call.method === method),
  });

  return {
    // the bot's transport, with captureApi's refusal of a repeated write (#350)
    bot(bot: Bot): TelegramSide {
      const captured = captureApi(bot);
      program(captured.answers);
      return side(captured.calls);
    },
    // the backend's push (auth/client-push.ts)
    push(push: { api: Api }): TelegramSide {
      const captured = capturePushApi(push);
      program(captured.answers);
      return side(captured.calls);
    },
  };
}

const isPhoto = (call: ApiCall) => MEDIA_METHODS.includes(call.method);

// The newest message of the bot in the chat carrying a button that matches; the press goes to that
// message, a photo's press as a photo's (#482), an animation's as one under a caption too (#859). Other chats are skipped: in the repeat run (#106)
// B and C get welcomes with the same connect button.
export function findButton(side: TelegramSide, match: (label: string) => boolean, chatId: number) {
  for (let index = side.calls.length - 1; index >= 0; index -= 1) {
    const call = side.calls[index];
    if (call === undefined || call.payload.reply_markup === undefined) continue;
    if (call.payload.chat_id !== chatId) continue;
    const button = inlineButtons(call.payload).find((candidate) => match(candidate.text));
    if (button?.callback_data === undefined) continue;
    const messageId = side.messageIdOf(call);
    if (messageId === undefined) continue;
    return { data: button.callback_data, messageId, photo: isPhoto(call) };
  }
  return undefined;
}

let updateId = 50_000;

export function pressUpdate(press: { data: string; messageId: number; photo: boolean }): Update {
  updateId += 1;
  return {
    update_id: updateId,
    callback_query: {
      id: `query-${updateId}`,
      from: USER,
      chat_instance: 'e2e',
      data: press.data,
      message: {
        message_id: press.messageId,
        date: 1,
        chat: { id: USER.id, type: 'private', first_name: USER.first_name },
        from: { ...BOT_INFO },
        ...(press.photo
          ? {
              photo: [{ file_id: 'pressed', file_unique_id: 'pressed', width: 90, height: 90 }],
              caption: 'card',
            }
          : { text: 'screen' }),
      },
    },
  } as unknown as Update;
}
