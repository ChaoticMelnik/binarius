import { afterEach, describe, expect, it } from 'vitest';
import {
  BOT_TEXT_CATALOG,
  decimalStringSchema,
  defaultBotTextSource,
  MAX_SESSION_TRADES,
  type BotTextKey,
  type SessionSummary,
} from '@binarius/shared';
import {
  renderSessionCard,
  SESSION_CARD_HEIGHT,
  SESSION_CARD_WIDTH,
  sessionCardModel,
  sessionCardSvg,
} from './session-card';
import { setBotTextSource } from './texts';

const d = (value: string) => decimalStringSchema.parse(value);
const trade = (profit: string, openPrice = 1.1, closePrice = 1.2) => ({
  profit: d(profit),
  openPrice,
  closePrice,
});
const MIXED: SessionSummary = {
  result: d('-0.15000000'),
  trades: [
    trade('0.85000000', 1.1, 1.3),
    trade('-1.00000000', 1.3, 1.2),
    trade('0.00000000', 1.2, 1.2),
  ],
};
const LOSSES: SessionSummary = {
  result: d('-3.00000000'),
  trades: [trade('-1'), trade('-1'), trade('-1')],
};

const ENTRY = '#4C8DFF';
const WIN = '#22C55E';
const LOSS = '#EF4444';
const TIE = '#9CA3AF';
const circlesOf = (svg: string, fill: string) =>
  svg.match(new RegExp(`<circle [^>]*fill="${fill}"`, 'g'))?.length ?? 0;
const pointsOf = (svg: string): [number, number][] =>
  (/<polyline points="([^"]*)"/.exec(svg)?.[1] ?? '')
    .split(' ')
    .map((pair) => pair.split(',').map(Number) as [number, number]);
const textsOf = (svg: string): string[] =>
  [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((match) => match[1] ?? '');

afterEach(() => {
  setBotTextSource(defaultBotTextSource);
});

describe('sessionCardModel', () => {
  it('C1 a mix with a tie: each trade by its sign, the result as the backend summed it', () => {
    const model = sessionCardModel(MIXED, 'EUR/USD OTC', 42);
    expect(model).toMatchObject({
      asset: 'EUR/USD OTC',
      title: 'СЕССИЯ ЗАВЕРШЕНА',
      resultLabel: 'ИТОГ',
      result: '-$0.15',
      resultTone: 'loss',
      footer: '3 сделки · 1 в плюс, 1 в минус, 1 в ноль',
      legend: { entry: 'Вход', win: 'Плюс', loss: 'Минус', tie: 'Ноль' },
    });
    expect(model.trades.map(({ label, profit, tone }) => [label, profit, tone])).toEqual([
      ['Сделка 1', '+$0.85', 'win'],
      ['Сделка 2', '-$1.00', 'loss'],
      ['Сделка 3', '$0.00', 'tie'],
    ]);
  });

  it('C2 only losses: the footer has no tie, every exit is a loss', () => {
    const model = sessionCardModel(LOSSES, 'EUR/USD OTC', 42);
    expect(model.footer).toBe('3 сделки · 0 в плюс, 3 в минус');
    expect(model.result).toBe('-$3.00');
    expect(model.trades.every((t) => t.tone === 'loss')).toBe(true);
  });

  it('C3 a profit that prints as $0.00 is still a win, as the view counts it', () => {
    const model = sessionCardModel(
      { result: d('0.001'), trades: [trade('0.001')] },
      'EUR/USD OTC',
      42,
    );
    expect(model.trades[0]).toMatchObject({ profit: '$0.00', tone: 'win' });
    expect(model.resultTone).toBe('win');
    expect(model.footer).toBe('1 сделка · 1 в плюс, 0 в минус');
  });

  it('C4 names the asset by its id when the catalog could not say', () => {
    expect(sessionCardModel(MIXED, null, 42).asset).toBe(
      BOT_TEXT_CATALOG.intentAssetFallback.source.replace('{assetId}', '42'),
    );
  });
});

describe('sessionCardSvg', () => {
  it('C5 the mixed card: a column, a line through entry and exit, and markers per trade', () => {
    const svg = sessionCardSvg(sessionCardModel(MIXED, 'EUR/USD OTC', 42));
    expect(svg).toContain(`width="${String(SESSION_CARD_WIDTH)}"`);
    expect(svg).toContain(`height="${String(SESSION_CARD_HEIGHT)}"`);
    expect(textsOf(svg)).toEqual([
      'EUR/USD OTC',
      'СЕССИЯ ЗАВЕРШЕНА',
      'ИТОГ',
      '-$0.15',
      'Сделка 1',
      '+$0.85',
      'Сделка 2',
      '-$1.00',
      'Сделка 3',
      '$0.00',
      'Вход',
      'Плюс',
      'Минус',
      'Ноль',
      '3 сделки · 1 в плюс, 1 в минус, 1 в ноль',
    ]);
    // three entries and the legend's one; one exit of each outcome and its legend dot
    expect(circlesOf(svg, ENTRY)).toBe(4);
    expect(circlesOf(svg, WIN)).toBe(2);
    expect(circlesOf(svg, LOSS)).toBe(2);
    expect(circlesOf(svg, TIE)).toBe(2);
    const points = pointsOf(svg);
    expect(points).toHaveLength(6);
    // x moves right through every entry and exit; the highest price is the highest point
    expect(points.map(([x]) => x)).toEqual([...points.map(([x]) => x)].sort((a, b) => a - b));
    const ys = points.map(([, y]) => y);
    expect(Math.min(...ys)).toBe(ys[1]);
    expect(Math.max(...ys)).toBe(ys[0]);
  });

  it('C6 only losses: every exit marker is red, none green or grey but the legend', () => {
    const svg = sessionCardSvg(sessionCardModel(LOSSES, 'EUR/USD OTC', 42));
    expect(circlesOf(svg, LOSS)).toBe(4);
    expect(circlesOf(svg, WIN)).toBe(1);
    expect(circlesOf(svg, TIE)).toBe(1);
  });

  it(`C7 ${String(MAX_SESSION_TRADES)} trades: as many columns`, () => {
    const many: SessionSummary = {
      result: d('0'),
      trades: Array.from({ length: MAX_SESSION_TRADES }, (_, i) => trade('0', i, i + 0.5)),
    };
    const svg = sessionCardSvg(sessionCardModel(many, 'EUR/USD OTC', 42));
    expect(textsOf(svg)).toContain(`Сделка ${String(MAX_SESSION_TRADES)}`);
    expect(svg.match(/<line /g)).toHaveLength(MAX_SESSION_TRADES - 1);
    expect(pointsOf(svg)).toHaveLength(2 * MAX_SESSION_TRADES);
  });

  it('C8 equal prices put the line in the middle, every coordinate finite', () => {
    const flat: SessionSummary = {
      result: d('0'),
      trades: [trade('0', 1.5, 1.5), trade('0', 1.5, 1.5)],
    };
    const svg = sessionCardSvg(sessionCardModel(flat, 'EUR/USD OTC', 42));
    const ys = new Set(pointsOf(svg).map(([, y]) => y));
    expect([...ys]).toEqual([(250 + 540) / 2]);
    expect(svg).not.toMatch(/NaN|Infinity/);
  });

  it('C9 an override and a symbol with markup are escaped, not drawn as SVG', () => {
    const overrides: Partial<Record<BotTextKey, string>> = {
      sessionCardTitle: '<b>&amp</b>',
      sessionCardLegendWin: '"x"',
    };
    setBotTextSource({ sourceOf: (key) => overrides[key] ?? BOT_TEXT_CATALOG[key].source });
    const svg = sessionCardSvg(sessionCardModel(MIXED, `A<svg onload="x">&'`, 42));
    expect(svg).not.toContain('<b>');
    expect(svg).not.toContain('<svg onload');
    expect(svg).toContain('&#60;b&#62;&#38;amp&#60;/b&#62;');
    expect(svg).toContain('A&#60;svg onload=&#34;x&#34;&#62;&#38;&#39;');
    expect(svg).toContain('&#34;x&#34;');
  });
});

const IHDR = (png: Buffer) => ({
  signature: png.subarray(0, 8).toString('hex'),
  chunk: png.subarray(12, 16).toString('ascii'),
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
});

describe('renderSessionCard', () => {
  it('R1 draws a PNG of the card size under 1 MB', () => {
    const png = renderSessionCard(sessionCardSvg(sessionCardModel(MIXED, 'EUR/USD OTC', 42)));
    expect(IHDR(png)).toEqual({
      signature: '89504e470d0a1a0a',
      chunk: 'IHDR',
      width: SESSION_CARD_WIDTH,
      height: SESSION_CARD_HEIGHT,
    });
    expect(png.length).toBeLessThan(1024 * 1024);
  });

  // resvg drops text it has no font for without an error: without the card's own fonts the same
  // SVG renders with no text, so equal bytes would mean the fonts are not used
  it('R2 draws the text with the bundled fonts: without them the image differs and is smaller', () => {
    const svg = sessionCardSvg(sessionCardModel(MIXED, 'EUR/USD OTC', 42));
    const withFonts = renderSessionCard(svg);
    const withoutFonts = renderSessionCard(svg, []);
    expect(withoutFonts.equals(withFonts)).toBe(false);
    expect(withoutFonts.length).toBeLessThan(withFonts.length);
  });
});
