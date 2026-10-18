import { describe, expect, it } from 'vitest';
import { CONTRAST_PAIRS, DARK_THEME, LIGHT_THEME, THEME_TOKEN_NAMES, themeCss } from './theme';

// WCAG 2.x relative luminance and contrast ratio
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

const THEMES = [
  ['dark', DARK_THEME],
  ['light', LIGHT_THEME],
] as const;

describe('the admin theme tokens (#459)', () => {
  it('T1 meets the contrast minimum of every declared pair in both themes', () => {
    // an empty list would pass the loop below
    expect(CONTRAST_PAIRS.length).toBeGreaterThanOrEqual(20);
    const failures = THEMES.flatMap(([name, theme]) =>
      CONTRAST_PAIRS.filter(({ fg, bg, min }) => contrast(theme[fg], theme[bg]) < min).map(
        ({ fg, bg, min }) =>
          `${name} ${fg} on ${bg}: ${contrast(theme[fg], theme[bg]).toFixed(2)} < ${min}`,
      ),
    );
    expect(failures).toEqual([]);
  });

  it('T2 declares the same tokens in both themes', () => {
    expect(Object.keys(DARK_THEME)).toEqual([...THEME_TOKEN_NAMES]);
    expect(Object.keys(LIGHT_THEME)).toEqual([...THEME_TOKEN_NAMES]);
  });

  it('T3 writes every colour as #rrggbb', () => {
    for (const [, theme] of THEMES) {
      for (const value of Object.values(theme)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('T4 builds the dark default, the system light and the switched light blocks, each with every token', () => {
    const css = themeCss();
    const blocks = [
      /^:root \{([\s\S]*?)\n\}/.exec(css)?.[1],
      /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{([\s\S]*?)\}/.exec(
        css,
      )?.[1],
      /:root\[data-theme="light"\] \{([\s\S]*?)\}/.exec(css)?.[1],
    ];
    const values = [DARK_THEME, LIGHT_THEME, LIGHT_THEME];
    blocks.forEach((block, index) => {
      expect(block).toBeDefined();
      for (const name of THEME_TOKEN_NAMES) {
        expect(block).toContain(`${name}: ${values[index]?.[name]};`);
      }
    });
  });
});
