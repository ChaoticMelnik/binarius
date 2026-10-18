import { describe, expect, it } from 'vitest';
import { ADMIN_CSS, ADMIN_FONT_FILES, ADMIN_FONTS, MINI_APP_CSS, adminFont } from './static';
import { themeCss } from './theme';

describe('the admin stylesheet (#459)', () => {
  it('S1 starts with the theme tokens', () => {
    expect(ADMIN_CSS.startsWith(themeCss())).toBe(true);
  });

  it('S2 loads nothing from outside /admin/static/ and imports nothing', () => {
    const urls = [...ADMIN_CSS.matchAll(/url\(\s*['"]?([^'")]*)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(/^\/admin\/static\//);
    expect(ADMIN_CSS).not.toContain('@import');
  });

  // only 400/500/600 ship as files; anything heavier would be synthesised by the browser
  it('S3 asks for no weight the fonts do not have', () => {
    expect(ADMIN_CSS).not.toMatch(/font-weight:\s*(7|8|9|bold|bolder)/);
  });

  it('S4 declares one @font-face per shipped font file', () => {
    const sources = [...ADMIN_CSS.matchAll(/@font-face\s*\{[^}]*src:\s*url\(([^)]*)\)/g)].map(
      (m) => m[1],
    );
    expect(sources).toEqual(ADMIN_FONT_FILES.map((file) => `/admin/static/fonts/${file}`));
    for (const file of ADMIN_FONT_FILES) {
      expect(ADMIN_FONTS[file].subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
  });

  it('S5 keeps the Mini App stylesheet free of the admin tokens and fonts', () => {
    expect(MINI_APP_CSS).not.toContain('var(--');
    expect(MINI_APP_CSS).not.toContain('@font-face');
  });

  it('S6 finds a font only by its own file name', () => {
    expect(adminFont('Inter-Medium.woff2')).toBe(ADMIN_FONTS['Inter-Medium.woff2']);
    for (const name of ['nope.woff2', '../static.ts', 'constructor', '__proto__', 'toString']) {
      expect(adminFont(name)).toBeUndefined();
    }
  });
});
