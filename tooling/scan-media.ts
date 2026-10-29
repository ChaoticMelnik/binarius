import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

// The media of the bot's wait for a signal (#859, Rule 58, docs/bot-demo.md → The wait for a
// signal): a looping radar GIF, which Telegram's sendAnimation turns into a silent looping video,
// and its still frame as a PNG for the screens that end the wait. Pure Node, no dependency: GIF89a
// with LZW and the NETSCAPE loop block, PNG through node:zlib. Deterministic. The files are the
// defaults: the owner may put any GIF or MP4 and PNG in their place without a code change
// (apps/bot/src/assets.test.ts gates the format and the size only). Run:
// node tooling/scan-media.ts

// 2:1 like the analysis card's pictures (1 280 × 640), so the bubble keeps its shape when the
// animation becomes a photo
export const SCAN_MEDIA_WIDTH = 640;
export const SCAN_MEDIA_HEIGHT = 320;
export const SCAN_FRAMES = 36;
// a GIF delay is in hundredths of a second: 60 ms a frame, a 2.16 s turn
export const SCAN_FRAME_DELAY_CS = 6;

const CX = SCAN_MEDIA_WIDTH / 2;
const CY = SCAN_MEDIA_HEIGHT / 2;
const RADIUS = 140;
const GRID_STEP = 32;
const TAIL = Math.PI * 0.75;

// The signal cards' colours: their navy ground, blue rings, a green sweep fading behind its head,
// gold blips lit as the sweep passes them.
export const SCAN_PALETTE: readonly (readonly [number, number, number])[] = [
  [0x0b, 0x1a, 0x3a],
  [0x11, 0x2a, 0x55],
  [0x1b, 0x46, 0x86],
  [0x27, 0x5c, 0xa8],
  [0x0f, 0x3a, 0x33],
  [0x14, 0x5e, 0x40],
  [0x1d, 0x8a, 0x4e],
  [0x2a, 0xc0, 0x5e],
  [0x39, 0xff, 0x6a],
  [0x8a, 0x6a, 0x2a],
  [0xf0, 0xc0, 0x5a],
  [0xff, 0xf0, 0xb0],
];
const C = {
  grid: 1,
  ring: 2,
  rim: 3,
  sweep: [8, 7, 6, 5, 4],
  blipDim: 9,
  blipLit: 10,
  blipHot: 11,
} as const;
// 2^5 = 32 palette entries: the GIF's colour table and its LZW minimum code size
const PALETTE_BITS = 5;

// [angle, fraction of the radius]
const BLIPS: readonly (readonly [number, number])[] = [
  [0.35, 0.9],
  [1.9, 0.55],
  [3.1, 0.75],
  [4.4, 0.4],
  [5.3, 0.85],
];

const TURN = 2 * Math.PI;
const wrap = (angle: number) => ((angle % TURN) + TURN) % TURN;

// One frame as palette indices, row by row. The still has no sweep and no lit blip.
export function renderFrame(
  frame: number,
  { still = false }: { still?: boolean } = {},
): Uint8Array {
  const width = SCAN_MEDIA_WIDTH;
  const height = SCAN_MEDIA_HEIGHT;
  const pixels = new Uint8Array(width * height);
  const set = (x: number, y: number, colour: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) pixels[y * width + x] = colour;
  };
  for (let y = 0; y < height; y += GRID_STEP) for (let x = 0; x < width; x++) set(x, y, C.grid);
  for (let x = 0; x < width; x += GRID_STEP) for (let y = 0; y < height; y++) set(x, y, C.grid);
  const theta = (TURN * frame) / SCAN_FRAMES;
  const rings = [RADIUS * 0.25, RADIUS * 0.5, RADIUS * 0.75, RADIUS];
  for (let y = CY - RADIUS; y <= CY + RADIUS; y++) {
    for (let x = CX - RADIUS; x <= CX + RADIUS; x++) {
      const dx = x - CX;
      const dy = y - CY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > RADIUS) continue;
      if (!still) {
        const behind = TURN - wrap(Math.atan2(dy, dx) - theta);
        if (behind < TAIL) {
          const t = behind / TAIL;
          const shade = t < 0.03 ? 0 : t < 0.2 ? 1 : t < 0.4 ? 2 : t < 0.7 ? 3 : 4;
          set(x, y, C.sweep[shade] ?? C.grid);
        }
      }
      for (const ring of rings) {
        if (Math.abs(d - ring) < 1.2) set(x, y, ring === RADIUS ? C.rim : C.ring);
      }
      if (Math.abs(dx) < 1 || Math.abs(dy) < 1) set(x, y, C.ring);
    }
  }
  for (const [angle, fraction] of BLIPS) {
    const bx = Math.round(CX + Math.cos(angle) * RADIUS * fraction);
    const by = Math.round(CY + Math.sin(angle) * RADIUS * fraction);
    const behind = wrap(theta - angle);
    const colour = still
      ? C.blipDim
      : behind < 0.15
        ? C.blipHot
        : behind < 1.2
          ? C.blipLit
          : C.blipDim;
    for (let y = -4; y <= 4; y++) {
      for (let x = -4; x <= 4; x++) if (x * x + y * y <= 16) set(bx + x, by + y, colour);
    }
  }
  return pixels;
}

// GIF LZW (GIF89a spec, appendix F): variable-width codes, least significant bit first, a clear
// code when the table is full at 4 096
export function lzwEncode(pixels: Uint8Array, minCodeSize: number): Buffer {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  let table = new Map<number, number>();
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  const emit = (code: number) => {
    buffer |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(buffer & 0xff);
      buffer >>>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  let prefix = pixels[0] ?? 0;
  for (let i = 1; i < pixels.length; i++) {
    const pixel = pixels[i] ?? 0;
    const key = prefix * 4096 + pixel;
    const found = table.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      table.set(key, next);
      next += 1;
      if (next - 1 === 1 << codeSize && codeSize < 12) codeSize += 1;
    } else {
      emit(clear);
      table = new Map();
      next = end + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = pixel;
  }
  emit(prefix);
  emit(end);
  if (bits > 0) out.push(buffer & 0xff);
  return Buffer.from(out);
}

const subBlocks = (data: Buffer): Buffer => {
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
};

const u16 = (value: number) => Buffer.from([value & 0xff, value >> 8]);

export function encodeGif(frames: readonly Uint8Array[], delayCs: number): Buffer {
  const parts: Buffer[] = [Buffer.from('GIF89a', 'latin1')];
  // logical screen: a global colour table of 2^PALETTE_BITS entries
  parts.push(
    u16(SCAN_MEDIA_WIDTH),
    u16(SCAN_MEDIA_HEIGHT),
    Buffer.from([0x80 | ((PALETTE_BITS - 1) << 4) | (PALETTE_BITS - 1), 0, 0]),
  );
  const palette = Buffer.alloc(3 * (1 << PALETTE_BITS));
  SCAN_PALETTE.forEach((rgb, i) => palette.set(rgb, i * 3));
  parts.push(palette);
  // NETSCAPE2.0: loop forever (count 0)
  parts.push(
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('NETSCAPE2.0', 'latin1'),
    Buffer.from([3, 1, 0, 0, 0]),
  );
  for (const frame of frames) {
    // graphic control: disposal 1 (leave the frame), the delay, no transparency
    parts.push(Buffer.from([0x21, 0xf9, 4, 0x04]), u16(delayCs), Buffer.from([0, 0]));
    parts.push(
      Buffer.from([0x2c]),
      u16(0),
      u16(0),
      u16(SCAN_MEDIA_WIDTH),
      u16(SCAN_MEDIA_HEIGHT),
      Buffer.from([0, PALETTE_BITS]),
      subBlocks(lzwEncode(frame, PALETTE_BITS)),
    );
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

const chunk = (type: string, data: Buffer): Buffer => {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
};

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

// An 8-bit indexed PNG: every row filter 0 (none)
export function encodePng(frame: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SCAN_MEDIA_WIDTH, 0);
  header.writeUInt32BE(SCAN_MEDIA_HEIGHT, 4);
  header.set([8, 3, 0, 0, 0], 8);
  const palette = Buffer.alloc(3 * SCAN_PALETTE.length);
  SCAN_PALETTE.forEach((rgb, i) => palette.set(rgb, i * 3));
  const raw = Buffer.alloc((SCAN_MEDIA_WIDTH + 1) * SCAN_MEDIA_HEIGHT);
  for (let y = 0; y < SCAN_MEDIA_HEIGHT; y++) {
    raw.set(
      frame.subarray(y * SCAN_MEDIA_WIDTH, (y + 1) * SCAN_MEDIA_WIDTH),
      y * (SCAN_MEDIA_WIDTH + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', header),
    chunk('PLTE', palette),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const scanAnimation = (): Buffer =>
  encodeGif(
    Array.from({ length: SCAN_FRAMES }, (_, i) => renderFrame(i)),
    SCAN_FRAME_DELAY_CS,
  );
export const scanStill = (): Buffer => encodePng(renderFrame(0, { still: true }));

if (import.meta.main) {
  const dir = path.join(import.meta.dirname, '..', 'packages', 'shared', 'assets');
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of [
    ['scan-radar.gif', scanAnimation()],
    ['scan-still.png', scanStill()],
  ] as const) {
    writeFileSync(path.join(dir, name), bytes);
    console.log(`${name}: ${String(bytes.length)} bytes`);
  }
}
