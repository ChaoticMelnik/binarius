import type { InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import type { TradeAction } from '@binarius/shared';
import { SETUP_CARD_PHOTO_PATHS } from './assets';
import type { Logger } from './logging';
import { createMediaFiles } from './media-files';

// The pictures of a signal's direction (#482, #568): the analysis card's and the session
// message's, each sent by its file_id once an answer brings one (media-files.ts, Rule 72; a «not
// modified» answer brings none).
export interface SetupCardPhotos {
  // the file_id when one is known, else the file
  photo: (action: TradeAction) => string | InputFile;
  remember: (action: TradeAction, result: Message | true) => void;
  forget: (action: TradeAction) => void;
}

export function createSetupCardPhotos(logger: Logger): SetupCardPhotos {
  const files = createMediaFiles(SETUP_CARD_PHOTO_PATHS, logger, 'the setup card picture');
  return { photo: files.file, remember: files.remember, forget: files.forget };
}
