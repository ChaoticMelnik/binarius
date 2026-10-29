import { InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import { createTelegramFileIds } from '@binarius/shared';
import { SCAN_ANIMATION_PATH, SCAN_STILL_PATH } from './assets';
import type { Logger } from './logging';

// The wait for a signal's media (#859, Rule 58): the scanner's animation while the wait runs, its
// still once it ends. Each is uploaded per process until an answer brings its file_id, then sent by
// it (telegram-file-ids.ts in @binarius/shared); a refused file forgets its id, so the next send
// uploads the file again.
export type ScanMediaKind = 'animation' | 'still';

const PATHS = {
  animation: SCAN_ANIMATION_PATH,
  still: SCAN_STILL_PATH,
} as const satisfies Record<ScanMediaKind, string>;

export interface ScanMedia {
  // the file_id when one is known, else the file
  file: (kind: ScanMediaKind) => string | InputFile;
  remember: (kind: ScanMediaKind, result: Message | true) => void;
  forget: (kind: ScanMediaKind) => void;
}

export function createScanMedia(logger: Logger): ScanMedia {
  const ids = createTelegramFileIds<ScanMediaKind>();
  return {
    file: (kind) => ids.get(kind) ?? new InputFile(PATHS[kind]),
    remember: (kind, result) => {
      if (!ids.remember(kind, result)) {
        logger.warn({ reason: 'no_file_id', kind }, 'the scan media is not remembered');
      }
    },
    forget: (kind) => {
      ids.forget(kind);
    },
  };
}
