import { InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import { createTelegramFileIds } from '@binarius/shared';
import type { Logger } from './logging';

// A picture or an animation the bot sends again and again (#875, Rule 72): uploaded per process
// and key until an answer brings its file_id, then sent by it (telegram-file-ids.ts in
// @binarius/shared, Rule 58). Memory only, so a restart, or a second bot process, uploads each
// again, and a file replaced on disk shows after a restart; a refused file forgets its id, so the
// next send uploads the file.
export interface MediaFiles<K extends string> {
  // the file_id when one is known, else the file
  file: (key: K) => string | InputFile;
  // reads the file_id from a send's or an editMessageMedia's answer; an inline edit's `true`
  // carries none and is ignored
  remember: (key: K, result: Message | true) => void;
  forget: (key: K) => void;
}

// `keyField` names the key in the warn of an answer without an id; without it the warn carries
// only the reason
export function createMediaFiles<K extends string>(
  paths: Readonly<Record<K, string>>,
  logger: Logger,
  what: string,
  keyField?: string,
): MediaFiles<K> {
  const ids = createTelegramFileIds<K>();
  return {
    file: (key) => ids.get(key) ?? new InputFile(paths[key]),
    remember: (key, result) => {
      if (!ids.remember(key, result)) {
        logger.warn(
          { reason: 'no_file_id', ...(keyField === undefined ? {} : { [keyField]: key }) },
          `${what} is not remembered`,
        );
      }
    },
    forget: (key) => {
      ids.forget(key);
    },
  };
}
