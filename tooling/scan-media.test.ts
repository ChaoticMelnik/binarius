import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  encodePng,
  lzwEncode,
  PNG_SIGNATURE,
  renderFrame,
  SCAN_FRAME_DELAY_CS,
  SCAN_FRAMES,
  SCAN_MEDIA_HEIGHT,
  SCAN_MEDIA_WIDTH,
  scanAnimation,
  scanStill,
} from './scan-media';

// The generator of the wait's media (#859). The tests hold the files' structure, not the bytes
// committed in packages/shared/assets: the owner may replace those without a code change. The LZW
// decoder below is the GIF89a spec's (appendix F), written apart from the encoder; macOS ImageIO
// (`sips -s format png`) decoded the first frame to the same pixels when the generator was written.

interface GifFrame {
  delayCs: number;
  disposal: number;
  width: number;
  height: number;
  minCodeSize: number;
  data: Buffer;
}

function parseGif(bytes: Buffer) {
  const header = bytes.toString('latin1', 0, 6);
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const packed = bytes[10] ?? 0;
  let offset = 13 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
  const extensions: string[] = [];
  let loop: number | undefined;
  const frames: GifFrame[] = [];
  let control = { delayCs: 0, disposal: 0 };
  const readBlocks = () => {
    const parts: Buffer[] = [];
    for (let size = bytes[offset] ?? 0; size !== 0; size = bytes[offset] ?? 0) {
      parts.push(bytes.subarray(offset + 1, offset + 1 + size));
      offset += size + 1;
    }
    offset += 1;
    return Buffer.concat(parts);
  };
  while (offset < bytes.length) {
    const introducer = bytes[offset];
    if (introducer === 0x3b) return { header, width, height, extensions, loop, frames, end: true };
    if (introducer === 0x21) {
      const label = bytes[offset + 1];
      offset += 2;
      const data = readBlocks();
      if (label === 0xff) {
        extensions.push(data.toString('latin1', 0, 11));
        if (data.toString('latin1', 0, 11) === 'NETSCAPE2.0') loop = data.readUInt16LE(12);
      } else if (label === 0xf9) {
        control = { delayCs: data.readUInt16LE(1), disposal: ((data[0] ?? 0) >> 2) & 7 };
      }
      continue;
    }
    if (introducer !== 0x2c) throw new Error(`unknown block 0x${String(introducer)}`);
    const frameWidth = bytes.readUInt16LE(offset + 5);
    const frameHeight = bytes.readUInt16LE(offset + 7);
    const minCodeSize = bytes[offset + 10] ?? 0;
    offset += 11;
    frames.push({
      ...control,
      width: frameWidth,
      height: frameHeight,
      minCodeSize,
      data: readBlocks(),
    });
  }
  return { header, width, height, extensions, loop, frames, end: false };
}

function lzwDecode(data: Buffer, minCodeSize: number, length: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = new Uint8Array(length);
  // an entry is its prefix code and its last pixel; its first pixel is kept for the KwKwK case
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const stack = new Uint8Array(4096);
  let written = 0;
  let size = clear + 2;
  let codeSize = minCodeSize + 1;
  let previous = -1;
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
  }
  let bit = 0;
  while (bit + codeSize <= data.length * 8) {
    let code = 0;
    for (let i = 0; i < codeSize; i++, bit++) {
      code |= (((data[bit >> 3] ?? 0) >> (bit & 7)) & 1) << i;
    }
    if (code === clear) {
      size = clear + 2;
      codeSize = minCodeSize + 1;
      previous = -1;
      continue;
    }
    if (code === end) break;
    if (code > size || (code === size && previous < 0)) throw new Error(`bad code ${code}`);
    // KwKwK: the code being defined is previous + previous's first pixel
    const head = code === size ? (first[previous] ?? 0) : (first[code] ?? 0);
    if (previous >= 0 && size < 4096) {
      prefix[size] = previous;
      suffix[size] = head;
      first[size] = first[previous] ?? 0;
      size += 1;
    }
    let depth = 0;
    for (let c = code; c >= 0; c = prefix[c] ?? -1) stack[depth++] = suffix[c] ?? 0;
    while (depth > 0) out[written++] = stack[--depth] ?? 0;
    previous = code;
    if (size === 1 << codeSize && codeSize < 12) codeSize += 1;
  }
  if (written !== length) throw new Error(`decoded ${String(written)} of ${String(length)} pixels`);
  return out;
}

describe('the scan animation (#859)', () => {
  const bytes = scanAnimation();
  const gif = parseGif(bytes);

  it('G1: a GIF89a of the media size, to its trailer', () => {
    expect(gif.header).toBe('GIF89a');
    expect([gif.width, gif.height]).toEqual([SCAN_MEDIA_WIDTH, SCAN_MEDIA_HEIGHT]);
    expect(gif.end).toBe(true);
  });

  it('G2: it loops forever (NETSCAPE2.0, count 0)', () => {
    expect(gif.extensions).toContain('NETSCAPE2.0');
    expect(gif.loop).toBe(0);
  });

  it('G3: every frame is full size, leaves itself in place and waits the frame delay', () => {
    expect(gif.frames).toHaveLength(SCAN_FRAMES);
    for (const frame of gif.frames) {
      expect(frame).toMatchObject({
        delayCs: SCAN_FRAME_DELAY_CS,
        disposal: 1,
        width: SCAN_MEDIA_WIDTH,
        height: SCAN_MEDIA_HEIGHT,
      });
    }
  });

  it('G4: the first and a later frame decode to the rendered pixels; the sweep moves', () => {
    const pixels = SCAN_MEDIA_WIDTH * SCAN_MEDIA_HEIGHT;
    for (const i of [0, SCAN_FRAMES / 2]) {
      const frame = gif.frames[i];
      if (frame === undefined) throw new Error('no frame');
      const decoded = lzwDecode(frame.data, frame.minCodeSize, pixels);
      expect(Buffer.from(decoded).equals(Buffer.from(renderFrame(i)))).toBe(true);
    }
    expect(Buffer.from(renderFrame(1)).equals(Buffer.from(renderFrame(0)))).toBe(false);
  });

  it('G5: the generator is deterministic', () => {
    expect(scanAnimation().equals(bytes)).toBe(true);
    expect(scanStill().equals(scanStill())).toBe(true);
  });

  it('G7: LZW past a full table (4 096 codes) clears and decodes back', () => {
    const noise = Uint8Array.from({ length: 50_000 }, (_, i) => (i * 7919 + (i >> 5)) % 13);
    expect(Buffer.from(lzwDecode(lzwEncode(noise, 5), 5, noise.length)).equals(noise)).toBe(true);
  });
});

describe('the scan still (#859)', () => {
  const png = scanStill();

  it('G6: a PNG whose chunks carry their CRC and whose rows inflate to the still frame', () => {
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    const chunks: { type: string; data: Buffer }[] = [];
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      const type = png.toString('latin1', offset + 4, offset + 8);
      const data = png.subarray(offset + 8, offset + 8 + length);
      expect(png.readUInt32BE(offset + 8 + length)).toBe(
        crc32(png.subarray(offset + 4, offset + 8 + length)),
      );
      chunks.push({ type, data });
      offset += 12 + length;
    }
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
    const header = chunks[0]!.data;
    expect([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9]]).toEqual([
      SCAN_MEDIA_WIDTH,
      SCAN_MEDIA_HEIGHT,
      8,
      3,
    ]);
    const raw = inflateSync(chunks[2]!.data);
    expect(raw.length).toBe((SCAN_MEDIA_WIDTH + 1) * SCAN_MEDIA_HEIGHT);
    const still = renderFrame(0, { still: true });
    const rows = Array.from({ length: SCAN_MEDIA_HEIGHT }, (_, y) =>
      raw.subarray(y * (SCAN_MEDIA_WIDTH + 1), (y + 1) * (SCAN_MEDIA_WIDTH + 1)),
    );
    expect(rows.every((row) => row[0] === 0)).toBe(true);
    expect(Buffer.concat(rows.map((row) => row.subarray(1))).equals(Buffer.from(still))).toBe(true);
    expect(encodePng(still).equals(png)).toBe(true);
  });
});
