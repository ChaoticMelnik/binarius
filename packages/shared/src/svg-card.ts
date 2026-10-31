// The SVG pieces of the cards drawn with Inter (#318, #594, #881): the bot's session card and
// promo, the backend's daily summary card. Pure strings, so the backend and the bot draw with one
// palette and one text helper; each side renders with its own resvg and the fonts in
// packages/shared/fonts.

export const CARD_COLOR = {
  background: '#0E1117',
  grid: '#262D3A',
  text: '#F2F4F8',
  muted: '#8B95A7',
  line: '#C9D1DE',
  entry: '#4C8DFF',
  win: '#22C55E',
  loss: '#EF4444',
  tie: '#9CA3AF',
} as const;

// Catalog overrides (#299) can carry `<`, `&` or quotes: every text is escaped into the SVG.
export const escapeXml = (text: string): string =>
  text.replace(/[<>&"']/g, (char) => `&#${String(char.charCodeAt(0))};`);

// The renderer measures nothing for us: a text shrinks to fit its slot by an upper estimate of
// Inter's advance (bold capitals ≈ 0.68 em), so a long override or symbol never overflows.
export const fitSize = (text: string, width: number, max: number, bold: boolean): number =>
  Math.max(8, Math.min(max, Math.floor(width / (Math.max(text.length, 1) * (bold ? 0.68 : 0.62)))));

export const round = (value: number): string => String(Math.round(value * 100) / 100);

export interface SvgTextOptions {
  x: number;
  y: number;
  width: number;
  size: number;
  bold?: boolean;
  fill: string;
  anchor?: 'start' | 'middle' | 'end';
}

export const svgText = (
  value: string,
  { x, y, width, size, bold = false, fill, anchor }: SvgTextOptions,
): string =>
  `<text x="${round(x)}" y="${round(y)}" font-size="${String(fitSize(value, width, size, bold))}"${
    bold ? ' font-weight="700"' : ''
  } fill="${fill}"${anchor === undefined ? '' : ` text-anchor="${anchor}"`}>${escapeXml(value)}</text>`;
