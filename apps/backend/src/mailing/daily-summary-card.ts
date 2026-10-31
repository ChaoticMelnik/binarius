import { renderAsync } from '@resvg/resvg-js';
import {
  CARD_COLOR,
  formatDay,
  formatSignedUsd,
  svgText,
  type BotPlainTexts,
  type DailySummaryPayload,
  type DailySummarySide,
} from '@binarius/shared';
import { sharedFile } from '../package-root';

// The daily summary card (#881, docs/mailing.md → The daily summary): one PNG of the previous
// Moscow day's totals, demo and real side by side. Every figure is the payload's, which the planner
// summed in SQL; the labels are the catalog's at the build (overrides, Rule 30), the numbers and
// the `%` and `$` are the code's, as on the session card.

export type DailyCardTone = 'win' | 'loss' | 'tie';

export interface DailyCardSide {
  heading: string;
  rows: (readonly [label: string, value: string])[];
  resultLabel: string;
  result: string;
  resultTone: DailyCardTone;
}

export interface DailyCardModel {
  title: string;
  date: string;
  demo: DailyCardSide;
  real: DailyCardSide;
}

// by the exact decimal, as the session card's tone
const toneOf = (amount: string): DailyCardTone =>
  !/[1-9]/.test(amount) ? 'tie' : amount.startsWith('-') ? 'loss' : 'win';

// the won trades and their whole share of the settled ones; no share of zero trades
const wonOf = ({ won, settled }: DailySummarySide): string =>
  settled === 0 ? String(won) : `${String(won)} · ${String(Math.round((won * 100) / settled))} %`;

const sideOf = (heading: string, side: DailySummarySide, plain: BotPlainTexts): DailyCardSide => ({
  heading,
  rows: [
    [plain.dailyCardSessions, String(side.sessions)],
    [plain.dailyCardTrades, String(side.settled)],
    [plain.dailyCardWon, wonOf(side)],
  ],
  resultLabel: plain.dailyCardResult,
  result: formatSignedUsd(side.profit),
  resultTone: toneOf(side.profit),
});

export const dailyCardModel = (
  payload: DailySummaryPayload,
  plain: BotPlainTexts,
): DailyCardModel => ({
  title: plain.dailyCardTitle,
  date: formatDay(payload.day),
  demo: sideOf(plain.dailyCardDemo, payload.demo, plain),
  real: sideOf(plain.dailyCardReal, payload.real, plain),
});

export const DAILY_CARD_WIDTH = 1200;
export const DAILY_CARD_HEIGHT = 675;

const PAD = 56;
const GAP = 64;
const COLUMN = (DAILY_CARD_WIDTH - 2 * PAD - GAP) / 2;
const ROW_TOP = 290;
const ROW_STEP = 76;
const RESULT_Y = 580;

function column(side: DailyCardSide, left: number): string[] {
  const right = left + COLUMN;
  const parts = [
    svgText(side.heading, {
      x: left,
      y: 222,
      width: COLUMN,
      size: 30,
      bold: true,
      fill: CARD_COLOR.muted,
    }),
  ];
  side.rows.forEach(([label, value], index) => {
    const y = ROW_TOP + index * ROW_STEP;
    parts.push(
      svgText(label, { x: left, y, width: COLUMN / 2, size: 30, fill: CARD_COLOR.muted }),
      svgText(value, {
        x: right,
        y,
        width: COLUMN / 2,
        size: 34,
        bold: true,
        fill: CARD_COLOR.text,
        anchor: 'end',
      }),
    );
  });
  parts.push(
    `<line x1="${String(left)}" y1="${String(RESULT_Y - 62)}" x2="${String(right)}" y2="${String(RESULT_Y - 62)}" stroke="${CARD_COLOR.grid}" stroke-width="2"/>`,
    svgText(side.resultLabel, {
      x: left,
      y: RESULT_Y,
      width: COLUMN / 3,
      size: 30,
      fill: CARD_COLOR.muted,
    }),
    svgText(side.result, {
      x: right,
      y: RESULT_Y,
      width: (COLUMN * 2) / 3,
      size: 44,
      bold: true,
      fill: CARD_COLOR[side.resultTone],
      anchor: 'end',
    }),
  );
  return parts;
}

export function dailyCardSvg(model: DailyCardModel): string {
  const parts = [
    `<rect width="${String(DAILY_CARD_WIDTH)}" height="${String(DAILY_CARD_HEIGHT)}" fill="${CARD_COLOR.background}"/>`,
    svgText(model.title, {
      x: PAD,
      y: 104,
      width: 640,
      size: 48,
      bold: true,
      fill: CARD_COLOR.text,
    }),
    svgText(model.date, {
      x: DAILY_CARD_WIDTH - PAD,
      y: 104,
      width: 360,
      size: 36,
      fill: CARD_COLOR.muted,
      anchor: 'end',
    }),
    `<line x1="${String(PAD)}" y1="150" x2="${String(DAILY_CARD_WIDTH - PAD)}" y2="150" stroke="${CARD_COLOR.grid}" stroke-width="2"/>`,
    `<line x1="${String(DAILY_CARD_WIDTH / 2)}" y1="186" x2="${String(DAILY_CARD_WIDTH / 2)}" y2="${String(RESULT_Y + 20)}" stroke="${CARD_COLOR.grid}" stroke-width="2" stroke-dasharray="6 6"/>`,
    ...column(model.demo, PAD),
    ...column(model.real, PAD + COLUMN + GAP),
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(DAILY_CARD_WIDTH)}" height="${String(DAILY_CARD_HEIGHT)}" viewBox="0 0 ${String(DAILY_CARD_WIDTH)} ${String(DAILY_CARD_HEIGHT)}" font-family="Inter">${parts.join('')}</svg>`;
}

// The alpine image has no fonts, and resvg drops text it has no font for without a word: the
// cards' files in packages/shared/fonts are the only fonts it may use (docs/bot-session.md → The
// renderer). Checked for read access at import (package-root.ts).
export const DAILY_CARD_FONT_FILES: readonly string[] = ['Inter-Regular.ttf', 'Inter-Bold.ttf'].map(
  (file) => sharedFile('fonts', file),
);

// renderAsync draws on libuv's pool, so the backend's event loop is free during the ~45 ms of a
// card (#875 p. 4); the synchronous Resvg.render() would hold it.
export const renderDailyCard = async (
  svg: string,
  fontFiles: readonly string[] = DAILY_CARD_FONT_FILES,
): Promise<Buffer> =>
  (
    await renderAsync(svg, {
      font: { fontFiles: [...fontFiles], loadSystemFonts: false, defaultFontFamily: 'Inter' },
    })
  ).asPng();
