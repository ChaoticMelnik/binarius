import { describe, expect, it } from 'vitest';
import { BotLanguage } from './bot-language';
import { createBotTexts, defaultBotTextSource } from './bot-texts';
import { enBotTextSource } from './bot-texts-en';
import { createScanTexts, type ScanList } from './scan-summary';
import { plainTextOf } from './telegram-html';

const ru = createScanTexts({ ...createBotTexts(defaultBotTextSource), language: BotLanguage.Ru });
const en = createScanTexts({ ...createBotTexts(enBotTextSource), language: BotLanguage.En });

const SYMBOLS: Record<number, string> = { 1: 'EUR/USD', 2: 'GBP/USD', 3: 'USD/JPY', 4: 'EUR/JPY' };
const symbolOf = (assetId: number) => SYMBOLS[assetId];

const list = (patch: Partial<ScanList['summary']> = {}, scanned = 115): ScanList => ({
  scanned,
  summary: {
    streaming: true,
    scanning: 4,
    closeness: [
      { assetId: 2, pct: 82 },
      { assetId: 1, pct: 71 },
      { assetId: 3, pct: 60 },
    ],
    ...patch,
  },
});
const lines = (scan: ScanList, texts = ru) =>
  texts.scanSummaryLines(scan, symbolOf).map((line) => plainTextOf(line));

describe('the scanner lines of the list wait (#859)', () => {
  it('C1: four lines on a full summary, every figure from the list', () => {
    expect(lines(list())).toEqual([
      '🛰 Сканирую рынок · 115 пар · 6\u00a0900 проверок в минуту',
      'Сейчас: EUR/JPY',
      '✅ Котировки  ✅ Движение цены  ⏳ Отбор сигнала',
      'Ближе всего к сигналу: GBP/USD 82 % · EUR/USD 71 % · USD/JPY 60 %',
    ]);
  });

  it('C2: the pair the scanner is on is left out when it is not in the catalog, or there is none', () => {
    expect(lines(list({ scanning: 99 }))[1]).toBe(
      '✅ Котировки  ✅ Движение цены  ⏳ Отбор сигнала',
    );
    expect(lines(list({ scanning: null }))).toHaveLength(3);
  });

  it('C3: at most three of the closest, those without a symbol skipped', () => {
    const scan = list({
      closeness: [
        { assetId: 4, pct: 90 },
        { assetId: 99, pct: 85 },
        { assetId: 2, pct: 82 },
        { assetId: 1, pct: 71 },
        { assetId: 3, pct: 60 },
      ],
    });
    expect(lines(scan).at(-1)).toBe(
      'Ближе всего к сигналу: EUR/JPY 90 % · GBP/USD 82 % · EUR/USD 71 %',
    );
  });

  it('C4: no closest line without a pair below the threshold', () => {
    expect(lines(list({ closeness: [] }))).toHaveLength(3);
    expect(lines(list({ closeness: [{ assetId: 99, pct: 50 }] }))).toHaveLength(3);
  });

  it('C5: the stages are state: quotes while streaming, movement while a pair is scanned', () => {
    expect(lines(list({ streaming: false }))).toContain(
      '⏳ Котировки  ✅ Движение цены  ⏳ Отбор сигнала',
    );
    expect(lines(list({ scanning: null, closeness: [] }, 0))).toEqual([
      '🛰 Сканирую рынок · 0 пар · 0 проверок в минуту',
      '✅ Котировки  ⏳ Движение цены  ⏳ Отбор сигнала',
    ]);
  });

  it("C8: the pair's word follows the language's plural rule; English has its own lines", () => {
    const first = (scanned: number, texts = ru) => lines(list({}, scanned), texts)[0];
    expect(first(1)).toBe('🛰 Сканирую рынок · 1 пара · 60 проверок в минуту');
    expect(first(3)).toBe('🛰 Сканирую рынок · 3 пары · 180 проверок в минуту');
    expect(first(121)).toBe('🛰 Сканирую рынок · 121 пара · 7\u00a0260 проверок в минуту');
    expect(first(1, en)).toBe('🛰 Scanning the market · 1 pair · 60 checks a minute');
    expect(lines(list(), en)).toEqual([
      '🛰 Scanning the market · 115 pairs · 6\u00a0900 checks a minute',
      'Now: EUR/JPY',
      '✅ Quotes  ✅ Price movement  ⏳ Signal selection',
      'Closest to a signal: GBP/USD 82 % · EUR/USD 71 % · USD/JPY 60 %',
    ]);
  });
});

describe('the scanner lines of the wait for a pair (#859)', () => {
  const pair = { assetId: 1, symbol: 'EUR/USD' };

  it("C6: the pair's own closeness, or that it waits for a move", () => {
    expect(ru.pairScanLines(list(), pair).map((line) => plainTextOf(line))).toEqual([
      '🛰 Сканирую EUR/USD · движение 71 % от порога сигнала',
      '✅ Котировки  ✅ Движение цены  ⏳ Отбор сигнала',
    ]);
    expect(plainTextOf(ru.pairScanLines(list({ closeness: [] }), pair)[0]!)).toBe(
      '🛰 Сканирую EUR/USD · жду движение цены',
    );
  });

  it('C7: no lines without a list', () => {
    expect(ru.pairScanLines(undefined, pair)).toEqual([]);
  });
});
