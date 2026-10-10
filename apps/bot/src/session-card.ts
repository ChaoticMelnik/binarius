import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { formatSignedUsd, type DecimalString, type SessionSummary } from '@binarius/shared';
import {
  sessionAssetLabel,
  sessionCardFooter,
  sessionCardLabels,
  sessionCardTradeLabel,
} from './texts';

// The finished session's card (#318, docs/bot-session.md → The summary card): one PNG of the
// session's trades on a line through their entry and exit prices. The amounts are the backend's
// (the claim's DecimalStrings, summed in SQL); the bot formats them and never adds them up. The
// prices only place the line: the chart is illustrative, the numbers are authoritative.

export type SessionCardTone = 'win' | 'loss' | 'tie';

export interface SessionCardTrade {
  label: string;
  profit: string;
  tone: SessionCardTone;
  openPrice: number;
  closePrice: number;
}

export interface SessionCardModel {
  asset: string;
  title: string;
  resultLabel: string;
  result: string;
  resultTone: SessionCardTone;
  trades: SessionCardTrade[];
  legend: { entry: string; win: string; loss: string; tie: string };
  footer: string;
}

// by the exact decimal, as the view counts won/lost/tied: a profit of 0.001 is a win even though
// it prints as $0.00
const toneOf = (amount: DecimalString): SessionCardTone =>
  !/[1-9]/.test(amount) ? 'tie' : amount.startsWith('-') ? 'loss' : 'win';

export function sessionCardModel(
  summary: SessionSummary,
  symbol: string | null,
  assetId: number,
): SessionCardModel {
  const labels = sessionCardLabels();
  const trades = summary.trades.map(
    ({ profit, openPrice, closePrice }, index): SessionCardTrade => ({
      label: sessionCardTradeLabel(index + 1),
      profit: formatSignedUsd(profit),
      tone: toneOf(profit),
      openPrice,
      closePrice,
    }),
  );
  const count = (tone: SessionCardTone) => trades.filter((trade) => trade.tone === tone).length;
  return {
    asset: sessionAssetLabel(symbol, assetId),
    title: labels.title,
    resultLabel: labels.result,
    result: formatSignedUsd(summary.result),
    resultTone: toneOf(summary.result),
    trades,
    legend: {
      entry: labels.legendEntry,
      win: labels.legendWin,
      loss: labels.legendLoss,
      tie: labels.legendTie,
    },
    footer: sessionCardFooter(trades.length, {
      won: count('win'),
      lost: count('loss'),
      tied: count('tie'),
    }),
  };
}

export const SESSION_CARD_WIDTH = 1200;
export const SESSION_CARD_HEIGHT = 675;

const PAD = 48;
const INNER = SESSION_CARD_WIDTH - 2 * PAD;
const COLUMNS_TOP = 150;
const COLUMNS_BOTTOM = 565;
const CHART_TOP = 250;
const CHART_BOTTOM = 540;
const MARKER_RADIUS = 8;

const COLOR = {
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
const escapeXml = (text: string): string =>
  text.replace(/[<>&"']/g, (char) => `&#${String(char.charCodeAt(0))};`);

// The renderer measures nothing for us: a text shrinks to fit its slot by an upper estimate of
// Inter's advance (bold capitals ≈ 0.68 em), so a long override or symbol never overflows.
const fitSize = (text: string, width: number, max: number, bold: boolean): number =>
  Math.max(8, Math.min(max, Math.floor(width / (Math.max(text.length, 1) * (bold ? 0.68 : 0.62)))));

interface TextOptions {
  x: number;
  y: number;
  width: number;
  size: number;
  bold?: boolean;
  fill: string;
  anchor?: 'start' | 'middle' | 'end';
}

const text = (value: string, { x, y, width, size, bold = false, fill, anchor }: TextOptions) =>
  `<text x="${String(x)}" y="${String(y)}" font-size="${String(fitSize(value, width, size, bold))}"${
    bold ? ' font-weight="700"' : ''
  } fill="${fill}"${anchor === undefined ? '' : ` text-anchor="${anchor}"`}>${escapeXml(value)}</text>`;

const round = (value: number): string => String(Math.round(value * 100) / 100);

const circle = (x: number, y: number, fill: string) =>
  `<circle cx="${round(x)}" cy="${round(y)}" r="${String(MARKER_RADIUS)}" fill="${fill}" stroke="${COLOR.background}" stroke-width="2"/>`;

export function sessionCardSvg(model: SessionCardModel): string {
  const count = model.trades.length;
  const column = INNER / count;
  const prices = model.trades.flatMap((trade) => [trade.openPrice, trade.closePrice]);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const span = high - low;
  // all prices equal: the line sits in the middle
  const yOf = (price: number): number =>
    span === 0
      ? (CHART_TOP + CHART_BOTTOM) / 2
      : CHART_BOTTOM - ((price - low) / span) * (CHART_BOTTOM - CHART_TOP);

  const parts: string[] = [
    `<rect width="${String(SESSION_CARD_WIDTH)}" height="${String(SESSION_CARD_HEIGHT)}" fill="${COLOR.background}"/>`,
    text(model.asset, { x: PAD, y: 80, width: 700, size: 40, bold: true, fill: COLOR.text }),
    text(model.title, { x: PAD, y: 118, width: 700, size: 22, fill: COLOR.muted }),
    text(model.resultLabel, {
      x: SESSION_CARD_WIDTH - PAD,
      y: 70,
      width: 340,
      size: 22,
      fill: COLOR.muted,
      anchor: 'end',
    }),
    text(model.result, {
      x: SESSION_CARD_WIDTH - PAD,
      y: 118,
      width: 340,
      size: 44,
      bold: true,
      fill: COLOR[model.resultTone],
      anchor: 'end',
    }),
  ];

  const points: string[] = [];
  const markers: string[] = [];
  model.trades.forEach((trade, index) => {
    const left = PAD + index * column;
    const middle = left + column / 2;
    if (index > 0) {
      parts.push(
        `<line x1="${round(left)}" y1="${String(COLUMNS_TOP)}" x2="${round(left)}" y2="${String(COLUMNS_BOTTOM)}" stroke="${COLOR.grid}" stroke-width="2" stroke-dasharray="6 6"/>`,
      );
    }
    parts.push(
      text(trade.label, {
        x: middle,
        y: 184,
        width: column - 12,
        size: 20,
        fill: COLOR.muted,
        anchor: 'middle',
      }),
      text(trade.profit, {
        x: middle,
        y: 216,
        width: column - 12,
        size: 24,
        bold: true,
        fill: COLOR[trade.tone],
        anchor: 'middle',
      }),
    );
    const entry = { x: left + column * 0.25, y: yOf(trade.openPrice) };
    const exit = { x: left + column * 0.75, y: yOf(trade.closePrice) };
    points.push(`${round(entry.x)},${round(entry.y)}`, `${round(exit.x)},${round(exit.y)}`);
    markers.push(circle(entry.x, entry.y, COLOR.entry), circle(exit.x, exit.y, COLOR[trade.tone]));
  });
  parts.push(
    `<polyline points="${points.join(' ')}" fill="none" stroke="${COLOR.line}" stroke-width="3" stroke-linejoin="round"/>`,
    ...markers,
  );

  let x = PAD;
  for (const [label, fill] of [
    [model.legend.entry, COLOR.entry],
    [model.legend.win, COLOR.win],
    [model.legend.loss, COLOR.loss],
    [model.legend.tie, COLOR.tie],
  ] as const) {
    const size = fitSize(label, 200, 20, false);
    parts.push(
      circle(x + MARKER_RADIUS, 600, fill),
      text(label, { x: x + 2 * MARKER_RADIUS + 10, y: 607, width: 200, size, fill: COLOR.muted }),
    );
    x += 2 * MARKER_RADIUS + 10 + Math.ceil(label.length * size * 0.62) + 32;
  }
  parts.push(text(model.footer, { x: PAD, y: 648, width: INNER, size: 22, fill: COLOR.text }));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(SESSION_CARD_WIDTH)}" height="${String(SESSION_CARD_HEIGHT)}" viewBox="0 0 ${String(SESSION_CARD_WIDTH)} ${String(SESSION_CARD_HEIGHT)}" font-family="Inter">${parts.join('')}</svg>`;
}

// The alpine image has no fonts, and resvg drops text it has no font for without a word: the
// card's own files are the only fonts it may use (docs/bot-session.md → The summary card).
export const SESSION_CARD_FONT_FILES: readonly string[] = [
  'Inter-Regular.ttf',
  'Inter-Bold.ttf',
].map((file) => fileURLToPath(new URL(`../fonts/${file}`, import.meta.url)));

export const renderSessionCard = (
  svg: string,
  fontFiles: readonly string[] = SESSION_CARD_FONT_FILES,
): Buffer =>
  new Resvg(svg, {
    font: { fontFiles: [...fontFiles], loadSystemFonts: false, defaultFontFamily: 'Inter' },
  })
    .render()
    .asPng();
