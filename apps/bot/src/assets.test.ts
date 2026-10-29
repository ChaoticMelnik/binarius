import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CARD_PHOTO_PATH,
  PROMO_LOGO_PATH,
  SCAN_ANIMATION_PATH,
  SCAN_STILL_PATH,
  SETUP_CARD_PHOTO_PATHS,
} from './assets';

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

describe.each(Object.entries(SETUP_CARD_PHOTO_PATHS))('the setup card picture %s', (_, path) => {
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

// The promo card's logo (#594): the issue's minimum side, and a bound on the bytes, since the data
// URI (4/3 of the file) is built into every promo SVG.
const LOGO_MIN_SIDE = 256;
const LOGO_MAX_BYTES = 512 * 1024;

describe('the promo logo (#594)', () => {
  const bytes = readFileSync(PROMO_LOGO_PATH);

  it('A1 is bot-logo.png, a PNG', () => {
    expect(PROMO_LOGO_PATH).toMatch(/bot-logo\.png$/);
    expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  });

  it('A2 is a square of at least the minimum side, within the byte bound', () => {
    const size = pngSize(bytes);
    expect(size).toBeDefined();
    const { width, height } = size ?? { width: 0, height: 0 };
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(LOGO_MIN_SIDE);
    expect(statSync(PROMO_LOGO_PATH).size).toBeLessThanOrEqual(LOGO_MAX_BYTES);
  });
});

// The wait's media (#859): the owner may replace either file without a code change, so the gate
// holds the Bot API's limits, not the generated bytes. sendAnimation → animation: "GIF or H.264/
// MPEG-4 AVC video without sound", up to 50 MB by upload; a GIF's size from its logical screen, an
// MP4 by its ftyp box. The still goes as a photo, under the photo limits above.
const ANIMATION_MAX_BYTES = 50 * 1024 * 1024;

describe('the scan media (#859)', () => {
  const animation = readFileSync(SCAN_ANIMATION_PATH);

  it('A3 the animation is a GIF89a or an MP4, within the upload limit', () => {
    const gif = animation.toString('latin1', 0, 6) === 'GIF89a';
    const mp4 = animation.toString('latin1', 4, 8) === 'ftyp';
    expect(gif || mp4).toBe(true);
    expect(statSync(SCAN_ANIMATION_PATH).size).toBeLessThanOrEqual(ANIMATION_MAX_BYTES);
  });

  it('A4 a GIF animation is within the dimension and ratio limits', () => {
    if (animation.toString('latin1', 0, 6) !== 'GIF89a') return;
    const width = animation.readUInt16LE(6);
    const height = animation.readUInt16LE(8);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(width + height).toBeLessThanOrEqual(PHOTO_MAX_WIDTH_PLUS_HEIGHT);
    expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(PHOTO_MAX_RATIO);
  });

  it('A5 the still is a PNG within the photo limits', () => {
    const bytes = readFileSync(SCAN_STILL_PATH);
    expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(statSync(SCAN_STILL_PATH).size).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
    const { width, height } = pngSize(bytes) ?? { width: 0, height: 0 };
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(width + height).toBeLessThanOrEqual(PHOTO_MAX_WIDTH_PLUS_HEIGHT);
    expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(PHOTO_MAX_RATIO);
  });
});
