import { describe, expect, it } from 'vitest';
import { CAPTION_LIMIT, MESSAGE_LIMIT, TEXTS } from './texts';

// The Bot API counts its 1024/4096 limits in UTF-16 code units, which is what String#length
// returns; counting code points would let an astral character through here and be refused by
// Telegram.
describe('texts', () => {
  // the welcome travels as a caption whenever WELCOME_VIDEO_FILE_ID is set, and a caption over
  // the limit is refused by the Bot API — which would only show up once a video is configured
  it('keeps the welcome inside the caption limit', () => {
    expect(TEXTS.welcome.length).toBeLessThanOrEqual(CAPTION_LIMIT);
  });

  it.each(Object.entries(TEXTS))(
    'keeps %s inside the message limit and non-empty',
    (_key, text) => {
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    },
  );
});
