import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_CARD_PHOTO_PATH, SETUP_CARD_PHOTO_PATHS } from './assets';

// The account card goes out as sendPhoto with this file, so a missing or out-of-limits picture
// would cost every new user their success message; here it costs a red `pnpm check` instead. The
// analysis card's two pictures (#482) the same: a refused one costs the card its picture.
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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Width and height from IHDR, which the PNG specification puts first: its length (4 bytes) and
// type follow the signature, then the width and the height as 4-byte big-endian integers.
function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe.each(Object.entries(SETUP_CARD_PHOTO_PATHS))('the analysis card picture %s', (_, path) => {
  const bytes = readFileSync(path);

  it('is a PNG', () => {
    expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  });

  it('is within the size limit of a photo', () => {
    expect(statSync(path).size).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
  });

  it('is within the dimension and ratio limits of a photo', () => {
    const size = pngSize(bytes);
    expect(size).toBeDefined();
    const { width, height } = size ?? { width: 0, height: 0 };
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(width + height).toBeLessThanOrEqual(PHOTO_MAX_WIDTH_PLUS_HEIGHT);
    expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(PHOTO_MAX_RATIO);
  });
});

it('draws the bull and the bear from two different files', () => {
  expect(SETUP_CARD_PHOTO_PATHS.up).toMatch(/setup-bull\.png$/);
  expect(SETUP_CARD_PHOTO_PATHS.down).toMatch(/setup-bear\.png$/);
  const [up, down] = [SETUP_CARD_PHOTO_PATHS.up, SETUP_CARD_PHOTO_PATHS.down].map((path) =>
    readFileSync(path),
  );
  expect(up?.equals(down ?? Buffer.alloc(0))).toBe(false);
});
