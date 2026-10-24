import { afterEach, describe, expect, it } from 'vitest';
import {
  BOT_TEXT_CATALOG,
  BOT_TEXT_SOURCES_EN,
  BotLanguage,
  decimalStringSchema,
  formatPaymentDate,
  MAX_SESSION_SUMMARY_TRADES,
  TradeAction,
  type BotTextKey,
  type SessionShare,
  type SessionShareTrade,
  type TradingSessionView,
  BOT_TEXT_DEFAULT_SOURCES,
} from '@binarius/shared';
import { botTextSourcesWith } from '@binarius/shared/testing';
import { renderSessionCard } from './session-card';
import {
  promoDirection,
  SESSION_PROMO_HEIGHT,
  SESSION_PROMO_WIDTH,
  sessionPromoModel,
  sessionPromoSvg,
} from './session-promo';
import { runWithLanguage } from './language';
import { setBotTextSources } from './texts';

const { Up, Down } = TradeAction;
const d = (value: string) => decimalStringSchema.parse(value);
const trade = (
  action: TradeAction,
  profit: string,
  openPrice = 1.1,
  closePrice = 1.2,
): SessionShareTrade => ({ action, profit: d(profit), openPrice, closePrice });

const ENDED_AT = '2026-10-12T18:32:00.000Z';
const viewOf = (profit: string): Pick<TradingSessionView, 'trades' | 'endedAt' | 'startedAt'> => ({
  trades: { settled: 3, rejected: 0, won: 1, lost: 1, tied: 1, profit: d(profit) },
  startedAt: '2026-10-12T18:00:00.000Z',
  endedAt: ENDED_AT,
});
const PAIR = { symbol: 'AUD/CHF', isOtc: true, digits: 5 };
const MIXED: Pick<SessionShare, 'trades' | 'pair'> = {
  trades: [
    trade(Up, '0.85000000', 0.4979, 0.4981),
    trade(Down, '-1.00000000', 0.4981, 0.4985),
    trade(Up, '0.00000000', 0.4985, 0.49834),
  ],
  pair: PAIR,
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
const badgeOf = (svg: string) =>
  /<rect data-badge="(\w+)"[^>]*width="([\d.]+)"[^>]*fill="([^"]+)"/.exec(svg);

afterEach(() => {
  setBotTextSources(BOT_TEXT_DEFAULT_SOURCES);
});

describe('promoDirection', () => {
  it('P1 the majority, the last trade on a tie, none without a trade', () => {
    expect(promoDirection([Up, Down, Up])).toBe(Up);
    expect(promoDirection([Down, Up, Down])).toBe(Down);
    expect(promoDirection([Up, Up, Down])).toBe(Up);
    expect(promoDirection([Up, Down])).toBe(Down);
    expect(promoDirection([Down, Up])).toBe(Up);
    expect(promoDirection([Down])).toBe(Down);
    expect(promoDirection([])).toBeNull();
  });
});

describe('sessionPromoModel', () => {
  it("P2 the view's result and tone, the pair's label and digits, the end in Moscow time", () => {
    const model = sessionPromoModel(MIXED, viewOf('-0.15000000'), 42);
    expect(model).toMatchObject({
      asset: 'AUD/CHF',
      direction: Up,
      directionLabel: 'ВВЕРХ',
      resultLabel: 'Мой результат сессии',
      result: '-$0.15',
      resultTone: 'loss',
      entryPrice: '0.49790',
      exitPrice: '0.49834',
      brand: 'Binarius',
      call: 'Торгуй со мной в Binarius и получи бесплатные токены!',
      when: `${formatPaymentDate(Date.parse(ENDED_AT) / 1000)} МСК`,
    });
    expect(model.when).toBe('12.10.2026 21:32 МСК');
    expect(model.points.map((point) => point.tone)).toEqual(['win', 'loss', 'tie']);
    expect(sessionPromoModel(MIXED, viewOf('2.5'), 42)).toMatchObject({
      result: '+$2.50',
      resultTone: 'win',
    });
    expect(sessionPromoModel(MIXED, viewOf('0'), 42).resultTone).toBe('tie');
  });

  it('P2b without the pair: the asset by its id and no price labels', () => {
    const model = sessionPromoModel({ ...MIXED, pair: null }, viewOf('1'), 42);
    expect(model).toMatchObject({ asset: 'актив #42', entryPrice: null, exitPrice: null });
  });
});

describe('the promo card in English (#633)', () => {
  it('P-en1 the English badge, labels and the end time in MSK', () => {
    const model = runWithLanguage(BotLanguage.En, () =>
      sessionPromoModel(MIXED, viewOf('-0.15000000'), 42),
    );
    expect(model).toMatchObject({
      directionLabel: 'UP',
      resultLabel: BOT_TEXT_SOURCES_EN.sessionPromoResult,
      call: BOT_TEXT_SOURCES_EN.sessionPromoCall,
      when: '12.10.2026 21:32 MSK',
    });
    const svg = runWithLanguage(BotLanguage.En, () => sessionPromoSvg(model));
    for (const text of textsOf(svg)) expect(text).not.toMatch(/[А-Яа-яЁё]/u);
  });
});

describe('sessionPromoSvg', () => {
  it('P3 the line through every entry and exit, markers by outcome, the badge and the texts', () => {
    const svg = sessionPromoSvg(sessionPromoModel(MIXED, viewOf('-0.15000000'), 42));
    expect(pointsOf(svg)).toHaveLength(2 * MIXED.trades.length);
    expect(circlesOf(svg, ENTRY)).toBe(3);
    expect(circlesOf(svg, WIN)).toBe(1);
    expect(circlesOf(svg, LOSS)).toBe(1);
    expect(circlesOf(svg, TIE)).toBe(1);
    expect(badgeOf(svg)?.[1]).toBe(Up);
    expect(badgeOf(svg)?.[3]).toBe(WIN);
    expect(textsOf(svg)).toEqual(
      expect.arrayContaining([
        'AUD/CHF',
        'ВВЕРХ',
        'Мой результат сессии',
        '-$0.15',
        '0.49790',
        '0.49834',
        'Binarius',
        'Торгуй со мной в Binarius и получи бесплатные токены!',
        '12.10.2026 21:32 МСК',
      ]),
    );
    const down = sessionPromoSvg(
      sessionPromoModel({ ...MIXED, trades: [trade(Down, '1')] }, viewOf('1'), 42),
    );
    expect(badgeOf(down)?.[1]).toBe(Down);
    expect(badgeOf(down)?.[3]).toBe(LOSS);
    expect(textsOf(down)).toContain('ВНИЗ');
    const none = sessionPromoSvg({
      ...sessionPromoModel(MIXED, viewOf('1'), 42),
      direction: null,
    });
    expect(badgeOf(none)).toBeNull();
  });

  it('P3b the badge widens with a longer override, never narrower than the default', () => {
    const width = () =>
      Number(badgeOf(sessionPromoSvg(sessionPromoModel(MIXED, viewOf('1'), 42)))?.[2]);
    const base = width();
    const overrides: Partial<Record<BotTextKey, string>> = { sessionPromoUp: 'ВВЕРХ ВВЕРХ!' };
    setBotTextSources(
      botTextSourcesWith(BotLanguage.Ru, {
        sourceOf: (key) => overrides[key] ?? BOT_TEXT_CATALOG[key].source,
      }),
    );
    expect(width()).toBeGreaterThan(base);
    overrides.sessionPromoUp = 'В';
    expect(width()).toBe(base);
  });

  // #633: the English words are shorter than the Russian default the badge is sized on
  it('P3d an English badge keeps the width of the Russian default, up and down alike', () => {
    const widthOf = (trades: SessionShareTrade[]) =>
      Number(
        badgeOf(sessionPromoSvg(sessionPromoModel({ ...MIXED, trades }, viewOf('1'), 42)))?.[2],
      );
    const base = widthOf(MIXED.trades);
    runWithLanguage(BotLanguage.En, () => {
      expect(widthOf(MIXED.trades)).toBe(base);
      expect(widthOf([trade(Down, '1')])).toBe(base);
    });
  });

  it('P3c an override with markup is escaped, not drawn as SVG', () => {
    const overrides: Partial<Record<BotTextKey, string>> = {
      sessionPromoCall: '<b>&amp</b>',
      sessionPromoBrand: '"x"',
    };
    setBotTextSources(
      botTextSourcesWith(BotLanguage.Ru, {
        sourceOf: (key) => overrides[key] ?? BOT_TEXT_CATALOG[key].source,
      }),
    );
    const svg = sessionPromoSvg(sessionPromoModel(MIXED, viewOf('1'), 42));
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&#60;b&#62;&#38;amp&#60;/b&#62;');
    expect(svg).toContain('&#34;x&#34;');
  });

  it(`P4 ${String(MAX_SESSION_SUMMARY_TRADES)} trades: every point, every coordinate finite`, () => {
    const many = Array.from({ length: MAX_SESSION_SUMMARY_TRADES }, (_, i) =>
      trade(i % 2 === 0 ? Up : Down, '0', i, i + 0.5),
    );
    const svg = sessionPromoSvg(sessionPromoModel({ ...MIXED, trades: many }, viewOf('0'), 42));
    expect(pointsOf(svg)).toHaveLength(2 * MAX_SESSION_SUMMARY_TRADES);
    expect(svg).not.toMatch(/NaN|Infinity/);
  });

  it('P5 equal prices put the line in the middle', () => {
    const flat = [trade(Up, '0', 1.5, 1.5), trade(Up, '0', 1.5, 1.5)];
    const svg = sessionPromoSvg(sessionPromoModel({ ...MIXED, trades: flat }, viewOf('0'), 42));
    expect([...new Set(pointsOf(svg).map(([, y]) => y))]).toEqual([(470 + 880) / 2]);
    expect(svg).not.toMatch(/NaN|Infinity/);
  });
});

const IHDR = (png: Buffer) => ({
  signature: png.subarray(0, 8).toString('hex'),
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
});

describe('rendering the promo card', () => {
  it('R1 a PNG of the card size under 1 MB', () => {
    const png = renderSessionCard(sessionPromoSvg(sessionPromoModel(MIXED, viewOf('1'), 42)));
    expect(IHDR(png)).toEqual({
      signature: '89504e470d0a1a0a',
      width: SESSION_PROMO_WIDTH,
      height: SESSION_PROMO_HEIGHT,
    });
    expect(png.length).toBeLessThan(1024 * 1024);
  });

  it('R2 the text is drawn with the bundled fonts: without them the image differs and is smaller', () => {
    const svg = sessionPromoSvg(sessionPromoModel(MIXED, viewOf('1'), 42));
    const withFonts = renderSessionCard(svg);
    const withoutFonts = renderSessionCard(svg, []);
    expect(withoutFonts.equals(withFonts)).toBe(false);
    expect(withoutFonts.length).toBeLessThan(withFonts.length);
  });
});
