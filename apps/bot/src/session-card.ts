import { Resvg } from '@resvg/resvg-js';
import {
  CARD_COLOR,
  fitSize,
  formatSignedUsd,
  round,
  svgText,
  type DecimalString,
  type PairLabel,
  type SessionSummary,
} from '@binarius/shared';
import {
  sessionAssetLabel,
  sessionCardFooter,
  sessionCardLabels,
  sessionCardTradeLabel,
} from './texts';
import { sharedFile } from './package-root';

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

// by the exact decimal, as the view counts won/lost/tied: a profit of 0.001 is a win, printed
// +$0.001 (formatSignedUsd keeps every digit, #450)
export const toneOf = (amount: DecimalString): SessionCardTone =>
  !/[1-9]/.test(amount) ? 'tie' : amount.startsWith('-') ? 'loss' : 'win';

export function sessionCardModel(
  summary: SessionSummary,
  symbol: PairLabel | null,
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

const circle = (x: number, y: number, fill: string) =>
  `<circle cx="${round(x)}" cy="${round(y)}" r="${String(MARKER_RADIUS)}" fill="${fill}" stroke="${CARD_COLOR.background}" stroke-width="2"/>`;

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
    `<rect width="${String(SESSION_CARD_WIDTH)}" height="${String(SESSION_CARD_HEIGHT)}" fill="${CARD_COLOR.background}"/>`,
    svgText(model.asset, {
      x: PAD,
      y: 80,
      width: 700,
      size: 40,
      bold: true,
      fill: CARD_COLOR.text,
    }),
    svgText(model.title, { x: PAD, y: 118, width: 700, size: 22, fill: CARD_COLOR.muted }),
    svgText(model.resultLabel, {
      x: SESSION_CARD_WIDTH - PAD,
      y: 70,
      width: 340,
      size: 22,
      fill: CARD_COLOR.muted,
      anchor: 'end',
    }),
    svgText(model.result, {
      x: SESSION_CARD_WIDTH - PAD,
      y: 118,
      width: 340,
      size: 44,
      bold: true,
      fill: CARD_COLOR[model.resultTone],
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
        `<line x1="${round(left)}" y1="${String(COLUMNS_TOP)}" x2="${round(left)}" y2="${String(COLUMNS_BOTTOM)}" stroke="${CARD_COLOR.grid}" stroke-width="2" stroke-dasharray="6 6"/>`,
      );
    }
    parts.push(
      svgText(trade.label, {
        x: middle,
        y: 184,
        width: column - 12,
        size: 20,
        fill: CARD_COLOR.muted,
        anchor: 'middle',
      }),
      svgText(trade.profit, {
        x: middle,
        y: 216,
        width: column - 12,
        size: 24,
        bold: true,
        fill: CARD_COLOR[trade.tone],
        anchor: 'middle',
      }),
    );
    const entry = { x: left + column * 0.25, y: yOf(trade.openPrice) };
    const exit = { x: left + column * 0.75, y: yOf(trade.closePrice) };
    points.push(`${round(entry.x)},${round(entry.y)}`, `${round(exit.x)},${round(exit.y)}`);
    markers.push(
      circle(entry.x, entry.y, CARD_COLOR.entry),
      circle(exit.x, exit.y, CARD_COLOR[trade.tone]),
    );
  });
  parts.push(
    `<polyline points="${points.join(' ')}" fill="none" stroke="${CARD_COLOR.line}" stroke-width="3" stroke-linejoin="round"/>`,
    ...markers,
  );

  let x = PAD;
  for (const [label, fill] of [
    [model.legend.entry, CARD_COLOR.entry],
    [model.legend.win, CARD_COLOR.win],
    [model.legend.loss, CARD_COLOR.loss],
    [model.legend.tie, CARD_COLOR.tie],
  ] as const) {
    const size = fitSize(label, 200, 20, false);
    parts.push(
      circle(x + MARKER_RADIUS, 600, fill),
      svgText(label, {
        x: x + 2 * MARKER_RADIUS + 10,
        y: 607,
        width: 200,
        size,
        fill: CARD_COLOR.muted,
      }),
    );
    x += 2 * MARKER_RADIUS + 10 + Math.ceil(label.length * size * 0.62) + 32;
  }
  parts.push(
    svgText(model.footer, { x: PAD, y: 648, width: INNER, size: 22, fill: CARD_COLOR.text }),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(SESSION_CARD_WIDTH)}" height="${String(SESSION_CARD_HEIGHT)}" viewBox="0 0 ${String(SESSION_CARD_WIDTH)} ${String(SESSION_CARD_HEIGHT)}" font-family="Inter">${parts.join('')}</svg>`;
}

// The alpine image has no fonts, and resvg drops text it has no font for without a word: the
// card's own files, in packages/shared/fonts (#881: the backend's daily card reads them too), are the
// only fonts it may use (docs/bot-session.md → The summary card). Found from the package's root,
// which holds under tsx and in the bundle, and checked at import (package-root.ts).
export const SESSION_CARD_FONT_FILES: readonly string[] = [
  'Inter-Regular.ttf',
  'Inter-Bold.ttf',
].map((file) => sharedFile('fonts', file));

export const renderSessionCard = (
  svg: string,
  fontFiles: readonly string[] = SESSION_CARD_FONT_FILES,
): Buffer =>
  new Resvg(svg, {
    font: { fontFiles: [...fontFiles], loadSystemFonts: false, defaultFontFamily: 'Inter' },
  })
    .render()
    .asPng();
