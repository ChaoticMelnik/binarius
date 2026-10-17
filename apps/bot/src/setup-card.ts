import { InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import type { TradeAction } from '@binarius/shared';
import { SETUP_CARD_PHOTO_PATHS } from './assets';
import type { Logger } from './logging';

// The pictures of a signal's direction (#482, #568): the analysis card's and the session
// message's. Each is uploaded once per process and direction, then sent by the file_id Telegram
// answered with. Memory only, so a restart, or a second bot process, uploads each once again; a
// refused photo forgets its file_id, so the next one uploads the file.
export interface SetupCardPhotos {
  // the file_id when one is known, else the file
  photo: (action: TradeAction) => string | InputFile;
  // reads the file_id from a sendPhoto's or an editMessageMedia's answer; an inline edit's `true`
  // carries none and is ignored
  remember: (action: TradeAction, result: Message | true) => void;
  forget: (action: TradeAction) => void;
}

export function createSetupCardPhotos(logger: Logger): SetupCardPhotos {
  const ids = new Map<TradeAction, string>();
  return {
    photo: (action) => ids.get(action) ?? new InputFile(SETUP_CARD_PHOTO_PATHS[action]),
    remember: (action, result) => {
      if (result === true || ids.has(action)) return;
      // the largest size is last; any size names the same photo to Telegram
      const fileId = result.photo?.at(-1)?.file_id;
      if (fileId === undefined) {
        logger.warn({ reason: 'no_file_id' }, 'the setup card picture is not remembered');
        return;
      }
      ids.set(action, fileId);
    },
    forget: (action) => {
      ids.delete(action);
    },
  };
}
