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

  // #656: the row card reads each cell's label from its data-label; #657: every table of the
  // admin is the component, so the stop-gap rule of #459 is gone
  it('S7 keeps the row-card label and has no rule for a table outside the component', () => {
    expect(ADMIN_CSS).toMatch(/\.table td::before\s*\{[^}]*content:\s*attr\(data-label\)/);
    expect(ADMIN_CSS).not.toMatch(/main table/);
  });

  // #817: in a 375 px card a long service-account badge wraps and the audit payload has no cap
  it('S8 wraps a badge and uncaps the payload cell in the row card', () => {
    expect(ADMIN_CSS).toMatch(/\.table \.badge\s*\{[^}]*white-space:\s*normal/);
    expect(ADMIN_CSS).toMatch(/\.table td\.payload\s*\{[^}]*max-width:\s*none/);
  });

  // #657: the field a refusal names is outlined, a form being sent dims its buttons, and the
  // textarea keeps the shared 16 px floor (#662) instead of a font-size of its own
  it('S9 styles the form states and leaves the textarea on the 16 px floor', () => {
    expect(ADMIN_CSS).toMatch(
      /\[aria-invalid='true'\]\s*\{[^}]*border-color:\s*var\(--color-danger\)/,
    );
    expect(ADMIN_CSS).toMatch(/form\[aria-busy='true'\] button[^{]*\{[^}]*opacity/);
    expect(ADMIN_CSS).toMatch(/,\s*textarea\s*\{[^}]*font-size:\s*max\(16px/);
    // a rule for textarea alone follows a closing brace or a comment, not a comma
    expect(ADMIN_CSS).toMatch(/[}/]\s*textarea\s*\{/);
    expect(ADMIN_CSS).not.toMatch(/[}/]\s*textarea\s*\{[^}]*font-size/);
  });
});
