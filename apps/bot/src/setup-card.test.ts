import { InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { TradeAction } from '@binarius/shared';
import { createSetupCardPhotos } from './setup-card';
import { fakeLogger, USER } from './testing';

const sent = (photo?: { file_id: string }[]): Message =>
  ({
    message_id: 1,
    date: 1,
    chat: { id: USER.id, type: 'private', first_name: USER.first_name },
    ...(photo === undefined
      ? {}
      : {
          photo: photo.map(({ file_id }, index) => ({
            file_id,
            file_unique_id: `u-${String(index)}`,
            width: 100,
            height: 100,
          })),
        }),
  }) as Message;
const fileName = (photo: string | InputFile) =>
  photo instanceof InputFile ? photo.filename : photo;

describe('createSetupCardPhotos (#568)', () => {
  it('SC1 the file once per direction, then the largest size’s file_id', () => {
    const photos = createSetupCardPhotos(fakeLogger());
    expect(fileName(photos.photo(TradeAction.Up))).toBe('setup-bull.png');
    expect(fileName(photos.photo(TradeAction.Down))).toBe('setup-bear.png');
    photos.remember(TradeAction.Up, sent([{ file_id: 'small' }, { file_id: 'large' }]));
    expect(photos.photo(TradeAction.Up)).toBe('large');
    expect(fileName(photos.photo(TradeAction.Down))).toBe('setup-bear.png');
  });

  it('SC2 a forgotten direction uploads its file again', () => {
    const photos = createSetupCardPhotos(fakeLogger());
    photos.remember(TradeAction.Down, sent([{ file_id: 'bear' }]));
    photos.forget(TradeAction.Down);
    expect(fileName(photos.photo(TradeAction.Down))).toBe('setup-bear.png');
  });

  it('SC3 an edit answered `true` remembers nothing and warns of nothing', () => {
    const logger = fakeLogger();
    const photos = createSetupCardPhotos(logger);
    photos.remember(TradeAction.Up, true);
    expect(fileName(photos.photo(TradeAction.Up))).toBe('setup-bull.png');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('SC4 an answer without sizes warns and leaves the file for the next one', () => {
    const logger = fakeLogger();
    const photos = createSetupCardPhotos(logger);
    photos.remember(TradeAction.Up, sent([]));
    photos.remember(TradeAction.Up, sent());
    expect(logger.warn.mock.calls).toEqual([
      [{ reason: 'no_file_id' }, 'the setup card picture is not remembered'],
      [{ reason: 'no_file_id' }, 'the setup card picture is not remembered'],
    ]);
    expect(fileName(photos.photo(TradeAction.Up))).toBe('setup-bull.png');
  });
});
