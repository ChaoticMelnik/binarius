import type { FastifyBaseLogger } from 'fastify';
import { InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import { createTelegramFileIds } from '@binarius/shared';
import { sharedFile } from '../package-root';

// The session's waiting message's animation (#860, Rule 59): the scanner's radar the bot's wait
// sends too (#859, packages/shared/assets). Uploaded per process until an answer brings its
// file_id, then sent by it (telegram-file-ids.ts in @binarius/shared); a refused file forgets its
// id, so the next send uploads the file again. The file_id is never logged (Rule 8).
export const SCAN_ANIMATION_PATH = sharedFile('assets', 'scan-radar.gif');

export interface ScanMedia {
  // the file_id when one is known, else the file
  animation: () => string | InputFile;
  remember: (result: Message | true) => void;
  forget: () => void;
}

export function createScanMedia(logger: FastifyBaseLogger): ScanMedia {
  const ids = createTelegramFileIds<'animation'>();
  return {
    animation: () => ids.get('animation') ?? new InputFile(SCAN_ANIMATION_PATH),
    remember: (result) => {
      if (!ids.remember('animation', result)) {
        logger.warn({ reason: 'no_file_id' }, 'the scan media is not remembered');
      }
    },
    forget: () => {
      ids.forget('animation');
    },
  };
}
