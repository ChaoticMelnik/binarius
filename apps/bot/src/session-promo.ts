import {
  formatPrice,
  formatSignedUsd,
  pairLabel,
  TradeAction,
  type SessionShare,
  type TradingSessionView,
} from '@binarius/shared';
import { COLOR, escapeXml, fitSize, round, toneOf, type SessionCardTone } from './session-card';
import { sessionAssetLabel, sessionPromoLabels, sessionPromoWhen } from './texts';

// The promo card shared by «📤 Поделиться» (#538, docs/bot-session.md → Sharing the card): a
// portrait card of its own, drawn when the share is pressed, not the owner's #318 card. Its data
// are the #318 card's: the settled trades' entry and exit prices place the line, the amount is the
// backend's sum (the view's), formatted and never added up here.

export interface SessionPromoPoint {
  open: number;
  close: number;
  tone: SessionCardTone;
}

export interface SessionPromoModel {
  asset: string;
  direction: TradeAction | null;
  directionLabel: string;
  resultLabel: string;
  result: string;
  resultTone: SessionCardTone;
  points: SessionPromoPoint[];
  entryPrice: string | null;
  exitPrice: string | null;
  brand: string;
  call: string;
  when: string;
}

// the badge's direction: the majority of the settled trades, the last trade's on a tie; none
// without a trade
export function promoDirection(actions: readonly TradeAction[]): TradeAction | null {
  const ups = actions.filter((action) => action === TradeAction.Up).length;
  const downs = actions.length - ups;
  if (ups !== downs) return ups > downs ? TradeAction.Up : TradeAction.Down;
  return actions.at(-1) ?? null;
}

export function sessionPromoModel(
  share: Pick<SessionShare, 'trades' | 'pair'>,
  view: Pick<TradingSessionView, 'trades' | 'endedAt' | 'startedAt'>,
  assetId: number,
): SessionPromoModel {
  const labels = sessionPromoLabels();
  const direction = promoDirection(share.trades.map((trade) => trade.action));
  const first = share.trades.at(0);
  const last = share.trades.at(-1);
  // a done session always has ended_at (trading_sessions_ended_at_pair_check); the type does not
  const endedAt = view.endedAt ?? view.startedAt;
  // the price labels need the pair's digits, which only the catalog has (Rule 20)
  const price = (value: number | undefined): string | null =>
    share.pair === null || value === undefined ? null : formatPrice(value, share.pair.digits);
  return {
    asset: sessionAssetLabel(share.pair === null ? null : pairLabel(share.pair), assetId),
    direction,
    directionLabel:
      direction === null ? '' : direction === TradeAction.Up ? labels.up : labels.down,
    resultLabel: labels.result,
    result: formatSignedUsd(view.trades.profit),
    resultTone: toneOf(view.trades.profit),
    points: share.trades.map(({ openPrice, closePrice, profit }) => ({
      open: openPrice,
      close: closePrice,
      tone: toneOf(profit),
    })),
    entryPrice: price(first?.openPrice),
    exitPrice: price(last?.closePrice),
    brand: labels.brand,
    call: labels.call,
    when: sessionPromoWhen(Math.floor(Date.parse(endedAt) / 1000)),
  };
}

export const SESSION_PROMO_WIDTH = 1080;
export const SESSION_PROMO_HEIGHT = 1350;

const PAD = 64;
const INNER = SESSION_PROMO_WIDTH - 2 * PAD;
const CHART_TOP = 470;
const CHART_BOTTOM = 880;
const MARKER_RADIUS = 9;
const BRAND_FILL = '#3B5BDB';
const BADGE_TOP = 70;
const BADGE_HEIGHT = 68;
const BADGE_TEXT_SIZE = 32;
const BADGE_ARROW = 26;
const BADGE_GAP = 14;
const BADGE_SIDE = 28;
// an upper estimate of bold Inter's advance, as fitSize's
const BOLD_ADVANCE = 0.68;
// the badge never gets narrower than its default label, nor wider than half the card
const BADGE_MIN_TEXT = Math.ceil('ВВЕРХ'.length * BADGE_TEXT_SIZE * BOLD_ADVANCE);
const BADGE_MAX_TEXT = INNER / 2 - 2 * BADGE_SIDE - BADGE_ARROW - BADGE_GAP;

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
  `<text x="${round(x)}" y="${round(y)}" font-size="${String(fitSize(value, width, size, bold))}"${
    bold ? ' font-weight="700"' : ''
  } fill="${fill}"${anchor === undefined ? '' : ` text-anchor="${anchor}"`}>${escapeXml(value)}</text>`;

const circle = (x: number, y: number, fill: string) =>
  `<circle cx="${round(x)}" cy="${round(y)}" r="${String(MARKER_RADIUS)}" fill="${fill}" stroke="${COLOR.background}" stroke-width="2"/>`;

// The badge's width follows its label (an override up to its limit), from the default label's up
// to half the card; the arrow is a path, since resvg drops a glyph Inter lacks without a word.
function badge(direction: TradeAction, label: string): { svg: string; width: number } {
  const textWidth = Math.min(
    BADGE_MAX_TEXT,
    Math.max(BADGE_MIN_TEXT, Math.ceil(label.length * BADGE_TEXT_SIZE * BOLD_ADVANCE)),
  );
  const width = 2 * BADGE_SIDE + BADGE_ARROW + BADGE_GAP + textWidth;
  const left = SESSION_PROMO_WIDTH - PAD - width;
  const middle = BADGE_TOP + BADGE_HEIGHT / 2;
  const arrowLeft = left + BADGE_SIDE;
  const half = BADGE_ARROW / 2;
  const arrow =
    direction === TradeAction.Up
      ? `M${round(arrowLeft)} ${round(middle + half * 0.8)} L${round(arrowLeft + half)} ${round(middle - half * 0.8)} L${round(arrowLeft + BADGE_ARROW)} ${round(middle + half * 0.8)} Z`
      : `M${round(arrowLeft)} ${round(middle - half * 0.8)} L${round(arrowLeft + half)} ${round(middle + half * 0.8)} L${round(arrowLeft + BADGE_ARROW)} ${round(middle - half * 0.8)} Z`;
  const fill = direction === TradeAction.Up ? COLOR.win : COLOR.loss;
  return {
    width,
    svg: [
      `<rect data-badge="${direction}" x="${round(left)}" y="${String(BADGE_TOP)}" width="${round(width)}" height="${String(BADGE_HEIGHT)}" rx="${String(BADGE_HEIGHT / 2)}" fill="${fill}"/>`,
      `<path d="${arrow}" fill="${COLOR.text}"/>`,
      text(label, {
        x: arrowLeft + BADGE_ARROW + BADGE_GAP,
        y: middle + BADGE_TEXT_SIZE * 0.36,
        width: textWidth,
        size: BADGE_TEXT_SIZE,
        bold: true,
        fill: COLOR.text,
      }),
    ].join(''),
  };
}

export function sessionPromoSvg(model: SessionPromoModel): string {
  const parts: string[] = [
    `<rect width="${String(SESSION_PROMO_WIDTH)}" height="${String(SESSION_PROMO_HEIGHT)}" fill="${COLOR.background}"/>`,
  ];
  const shown = model.direction === null ? null : badge(model.direction, model.directionLabel);
  if (shown !== null) parts.push(shown.svg);
  parts.push(
    text(model.asset, {
      x: PAD,
      y: 124,
      width: INNER - (shown === null ? 0 : shown.width + 24),
      size: 56,
      bold: true,
      fill: COLOR.text,
    }),
    text(model.resultLabel, { x: PAD, y: 250, width: INNER, size: 38, fill: COLOR.muted }),
    text(model.result, {
      x: PAD,
      y: 370,
      width: INNER,
      size: 120,
      bold: true,
      fill: COLOR[model.resultTone],
    }),
  );

  const prices = model.points.flatMap((point) => [point.open, point.close]);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const span = high - low;
  // all prices equal: the line sits in the middle
  const yOf = (value: number): number =>
    span === 0
      ? (CHART_TOP + CHART_BOTTOM) / 2
      : CHART_BOTTOM - ((value - low) / span) * (CHART_BOTTOM - CHART_TOP);
  const step = prices.length > 1 ? INNER / (prices.length - 1) : 0;
  const xOf = (index: number): number => (prices.length > 1 ? PAD + index * step : PAD + INNER / 2);
  const line: string[] = [];
  const markers: string[] = [];
  model.points.forEach((point, index) => {
    const entry = { x: xOf(2 * index), y: yOf(point.open) };
    const exit = { x: xOf(2 * index + 1), y: yOf(point.close) };
    line.push(`${round(entry.x)},${round(entry.y)}`, `${round(exit.x)},${round(exit.y)}`);
    markers.push(circle(entry.x, entry.y, COLOR.entry), circle(exit.x, exit.y, COLOR[point.tone]));
  });
  if (line.length > 0) {
    parts.push(
      `<line x1="${String(PAD)}" y1="${String(CHART_BOTTOM + 70)}" x2="${String(SESSION_PROMO_WIDTH - PAD)}" y2="${String(CHART_BOTTOM + 70)}" stroke="${COLOR.grid}" stroke-width="2"/>`,
      `<polyline points="${line.join(' ')}" fill="none" stroke="${COLOR.line}" stroke-width="4" stroke-linejoin="round"/>`,
      ...markers,
    );
    const first = model.points[0];
    const last = model.points.at(-1);
    if (model.entryPrice !== null && first !== undefined) {
      parts.push(
        text(model.entryPrice, {
          x: xOf(0),
          // under the first point: the line leaves it upwards as often as not
          y: yOf(first.open) + 48,
          width: INNER / 3,
          size: 30,
          fill: COLOR.muted,
          anchor: 'start',
        }),
      );
    }
    if (model.exitPrice !== null && last !== undefined) {
      parts.push(
        text(model.exitPrice, {
          x: xOf(prices.length - 1),
          y: yOf(last.close) - 26,
          width: INNER / 3,
          size: 30,
          fill: COLOR.text,
          anchor: 'end',
        }),
      );
    }
  }

  const mark = { x: PAD + 44, y: 1050 };
  parts.push(
    `<circle cx="${String(mark.x)}" cy="${String(mark.y)}" r="44" fill="${BRAND_FILL}"/>`,
    text(Array.from(model.brand)[0] ?? '', {
      x: mark.x,
      y: mark.y + 17,
      width: 60,
      size: 48,
      bold: true,
      fill: COLOR.text,
      anchor: 'middle',
    }),
    text(model.brand, {
      x: PAD + 112,
      y: mark.y + 18,
      width: INNER - 112,
      size: 52,
      bold: true,
      fill: COLOR.text,
    }),
    text(model.call, { x: PAD, y: 1180, width: INNER, size: 38, fill: COLOR.text }),
    text(model.when, { x: PAD, y: 1270, width: INNER, size: 30, fill: COLOR.muted }),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(SESSION_PROMO_WIDTH)}" height="${String(SESSION_PROMO_HEIGHT)}" viewBox="0 0 ${String(SESSION_PROMO_WIDTH)} ${String(SESSION_PROMO_HEIGHT)}" font-family="Inter">${parts.join('')}</svg>`;
}
