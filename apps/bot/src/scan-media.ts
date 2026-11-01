import { SCAN_ANIMATION_PATH, SCAN_STILL_PATH } from './assets';
import type { Logger } from './logging';
import { createMediaFiles, type MediaFiles } from './media-files';

// The wait for a signal's media (#859, Rule 58): the scanner's animation while the wait runs, its
// still once it ends, each sent by its file_id once an answer brings one (media-files.ts, Rule 72).
export type ScanMediaKind = 'animation' | 'still';

const PATHS = {
  animation: SCAN_ANIMATION_PATH,
  still: SCAN_STILL_PATH,
} as const satisfies Record<ScanMediaKind, string>;

export type ScanMedia = MediaFiles<ScanMediaKind>;

export function createScanMedia(logger: Logger): ScanMedia {
  return createMediaFiles(PATHS, logger, 'the scan media', 'kind');
}
