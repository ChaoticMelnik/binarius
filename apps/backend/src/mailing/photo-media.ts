import type { FastifyBaseLogger } from 'fastify';
import { InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import { createTelegramFileIds } from '@binarius/shared';

// A mailing's picture (#879, Rule 58), as the session's scanner animation (scan-media.ts): uploaded
// per process until an answer brings its file_id, then sent by it; a refused file forgets its id,
// so the next send uploads the file again. The file_id is never logged (Rule 8).
export interface PhotoMedia {
  // the file_id when one is known, else the file
  photo: () => string | InputFile;
  remember: (result: Message | true) => void;
  forget: () => void;
}

export function createPhotoMedia({
  path,
  name,
  logger,
}: {
  path: string;
  // for the log line only
  name: string;
  logger: FastifyBaseLogger;
}): PhotoMedia {
  const ids = createTelegramFileIds<'photo'>();
  return {
    photo: () => ids.get('photo') ?? new InputFile(path),
    remember: (result) => {
      if (!ids.remember('photo', result)) {
        logger.warn({ reason: 'no_file_id', media: name }, 'mailing photo not remembered');
      }
    },
    forget: () => {
      ids.forget('photo');
    },
  };
}
