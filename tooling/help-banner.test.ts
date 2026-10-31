import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HELP_BANNER_HEIGHT,
  HELP_BANNER_PNG,
  HELP_BANNER_SVG,
  HELP_BANNER_WIDTH,
  renderHelpBanner,
} from './help-banner';

// The help push's banner (#879): the committed PNG is the committed SVG's rendering, so an edit of
// one without the other fails here.
const svg = readFileSync(HELP_BANNER_SVG, 'utf8');
const png = readFileSync(HELP_BANNER_PNG);

describe('the help push banner (#879)', () => {
  it('HB1 is a 1280 × 640 PNG', () => {
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.toString('latin1', 12, 16)).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
      HELP_BANNER_WIDTH,
      HELP_BANNER_HEIGHT,
    ]);
  });

  it('HB2 is the SVG source rendered, byte for byte', () => {
    expect(renderHelpBanner(svg).equals(png)).toBe(true);
  });

  it('HB3 the source has no words: one file for both languages, no fonts to load', () => {
    expect(svg).not.toMatch(/<text\b/);
    expect(svg).toContain(
      `viewBox="0 0 ${String(HELP_BANNER_WIDTH)} ${String(HELP_BANNER_HEIGHT)}"`,
    );
  });
});
