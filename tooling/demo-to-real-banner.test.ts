import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEMO_TO_REAL_BANNER_HEIGHT,
  DEMO_TO_REAL_BANNER_PNG,
  DEMO_TO_REAL_BANNER_SVG,
  DEMO_TO_REAL_BANNER_WIDTH,
  renderDemoToRealBanner,
} from './demo-to-real-banner';

// The demo-to-real chain's banner (#880): the committed PNG is the committed SVG's rendering, so an
// edit of one without the other fails here.
const svg = readFileSync(DEMO_TO_REAL_BANNER_SVG, 'utf8');
const png = readFileSync(DEMO_TO_REAL_BANNER_PNG);

describe('the demo-to-real chain banner (#880)', () => {
  it('DB1 is a 1280 × 640 PNG', () => {
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.toString('latin1', 12, 16)).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 640]);
    expect([DEMO_TO_REAL_BANNER_WIDTH, DEMO_TO_REAL_BANNER_HEIGHT]).toEqual([1280, 640]);
  });

  it('DB2 is the SVG source rendered, byte for byte', () => {
    expect(renderDemoToRealBanner(svg).equals(png)).toBe(true);
  });

  it('DB3 the source has no words: one file for both languages, no fonts to load', () => {
    expect(svg).not.toMatch(/<text\b/);
    expect(svg).toContain('viewBox="0 0 1280 640"');
  });
});
