import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_CARD_PHOTO_PATH } from './assets';

// The account card goes out as sendPhoto with this file, so a missing or out-of-limits picture
// would cost every new user their success message; here it costs a red `pnpm check` instead.
// Limits are the Bot API's, sendPhoto → photo: "The photo must be at most 10 MB in size. The
// photo's width and height must not exceed 10000 in total. Width and height ratio must be at
// most 20."
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_MAX_WIDTH_PLUS_HEIGHT = 10_000;
const PHOTO_MAX_RATIO = 20;

// Width and height from the first baseline, extended or progressive frame header (SOF0-SOF2);
// undefined when the segments end before one.
function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // start of scan: entropy-coded data follows, and no frame header came before it
    if (marker === 0xda) return undefined;
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

describe('the account card picture', () => {
  const bytes = readFileSync(ACCOUNT_CARD_PHOTO_PATH);

  it('is a JPEG', () => {
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('is within the size limit of a photo', () => {
    expect(statSync(ACCOUNT_CARD_PHOTO_PATH).size).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
  });

  it('is within the dimension and ratio limits of a photo', () => {
    const size = jpegSize(bytes);
    expect(size).toBeDefined();
    const { width, height } = size ?? { width: 0, height: 0 };
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(width + height).toBeLessThanOrEqual(PHOTO_MAX_WIDTH_PLUS_HEIGHT);
    expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(PHOTO_MAX_RATIO);
  });
});
