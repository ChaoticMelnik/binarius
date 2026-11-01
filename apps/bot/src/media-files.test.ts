import { InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { createMediaFiles } from './media-files';
import { fakeLogger, USER } from './testing';

const PATHS = { card: '/assets/card.jpg', still: '/assets/still.png' } as const;

const sent = (photo?: readonly string[]): Message =>
  ({
    message_id: 1,
    date: 1,
    chat: { id: USER.id, type: 'private', first_name: USER.first_name },
    ...(photo === undefined
      ? {}
      : {
          photo: photo.map((file_id, index) => ({
            file_id,
            file_unique_id: `u-${String(index)}`,
            width: 100,
            height: 100,
          })),
        }),
  }) as Message;
const nameOf = (file: string | InputFile) => (file instanceof InputFile ? file.filename : file);

describe('createMediaFiles (#875)', () => {
  it('MF1 the file until an answer brings its id, then the id of the largest size', () => {
    const files = createMediaFiles(PATHS, fakeLogger(), 'the picture');
    expect(nameOf(files.file('card'))).toBe('card.jpg');
    files.remember('card', sent(['small', 'large']));
    expect(files.file('card')).toBe('large');
    expect(nameOf(files.file('still'))).toBe('still.png');
  });

  it('MF2 a forgotten key uploads its file again', () => {
    const files = createMediaFiles(PATHS, fakeLogger(), 'the picture');
    files.remember('card', sent(['large']));
    files.forget('card');
    expect(nameOf(files.file('card'))).toBe('card.jpg');
  });

  it('MF3 an answer without sizes warns by `what` and the key field, and keeps the file', () => {
    const logger = fakeLogger();
    const files = createMediaFiles(PATHS, logger, 'the picture', 'kind');
    files.remember('still', sent());
    files.remember('still', true);
    expect(logger.warn.mock.calls).toEqual([
      [{ reason: 'no_file_id', kind: 'still' }, 'the picture is not remembered'],
    ]);
    expect(nameOf(files.file('still'))).toBe('still.png');
  });
});
