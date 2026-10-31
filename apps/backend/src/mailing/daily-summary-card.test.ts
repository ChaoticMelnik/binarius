import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BotLanguage,
  CARD_COLOR,
  type DailySummaryPayload,
  type DecimalString,
} from '@binarius/shared';
import { clientLabelsOf } from '../auth/texts';
import {
  DAILY_CARD_FONT_FILES,
  DAILY_CARD_HEIGHT,
  DAILY_CARD_WIDTH,
  dailyCardModel,
  dailyCardSvg,
  renderDailyCard,
} from './daily-summary-card';

const d = (value: string) => value as DecimalString;
const DAY: DailySummaryPayload = {
  day: '2024-03-12',
  demo: { sessions: 3, settled: 4, won: 2, lost: 1, tied: 1, profit: d('3.00000000') },
  real: { sessions: 1, settled: 2, won: 0, lost: 2, tied: 0, profit: d('-2.50000000') },
};
const RU = clientLabelsOf(BotLanguage.Ru);

// the PNG's width and height from its IHDR chunk
const sizeOf = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

describe('the daily summary card (#881)', () => {
  it('DC1 the model: the day, each mode’s rows, the share of won trades and the signed result', () => {
    expect(dailyCardModel(DAY, RU)).toEqual({
      title: 'ИТОГИ ДНЯ',
      date: '12.03.2024',
      demo: {
        heading: 'ДЕМО',
        rows: [
          ['Сессий', '3'],
          ['Сделок', '4'],
          ['В плюс', '2 · 50 %'],
        ],
        resultLabel: 'Результат',
        result: '+$3.00',
        resultTone: 'win',
      },
      real: {
        heading: 'РЕАЛ',
        rows: [
          ['Сессий', '1'],
          ['Сделок', '2'],
          ['В плюс', '0 · 0 %'],
        ],
        resultLabel: 'Результат',
        result: '-$2.50',
        resultTone: 'loss',
      },
    });
    // a mode without a trade: no share, and a zero result in the tie's colour
    const quiet = { sessions: 1, settled: 0, won: 0, lost: 0, tied: 0, profit: d('0') };
    expect(dailyCardModel({ ...DAY, real: quiet }, RU).real).toMatchObject({
      rows: [
        ['Сессий', '1'],
        ['Сделок', '0'],
        ['В плюс', '0'],
      ],
      result: '$0.00',
      resultTone: 'tie',
    });
  });

  it('DC2 the SVG: the texts in order, each result in the colour of its sign', () => {
    const svg = dailyCardSvg(dailyCardModel(DAY, RU));
    const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
    expect(texts).toEqual([
      'ИТОГИ ДНЯ',
      '12.03.2024',
      'ДЕМО',
      'Сессий',
      '3',
      'Сделок',
      '4',
      'В плюс',
      '2 · 50 %',
      'Результат',
      '+$3.00',
      'РЕАЛ',
      'Сессий',
      '1',
      'Сделок',
      '2',
      'В плюс',
      '0 · 0 %',
      'Результат',
      '-$2.50',
    ]);
    expect(svg).toContain(`fill="${CARD_COLOR.win}" text-anchor="end">+$3.00<`);
    expect(svg).toContain(`fill="${CARD_COLOR.loss}" text-anchor="end">-$2.50<`);
  });

  it('DC3 renders a 1200 × 675 PNG under 1 MB', async () => {
    const png = await renderDailyCard(dailyCardSvg(dailyCardModel(DAY, RU)));
    expect(sizeOf(png)).toEqual({ width: DAILY_CARD_WIDTH, height: DAILY_CARD_HEIGHT });
    expect(png.length).toBeLessThan(1_000_000);
    // the PR's preview (#881): DAILY_CARD_PREVIEW_DIR=<dir> writes both languages there
    const dir = process.env.DAILY_CARD_PREVIEW_DIR;
    if (dir !== undefined && dir !== '') {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'daily-card-ru.png'), png);
      const en = clientLabelsOf(BotLanguage.En);
      writeFileSync(
        path.join(dir, 'daily-card-en.png'),
        await renderDailyCard(dailyCardSvg(dailyCardModel(DAY, en))),
      );
    }
  });

  it('DC4 draws its text with its own fonts: without them the PNG has no glyphs', async () => {
    const svg = dailyCardSvg(dailyCardModel(DAY, RU));
    const withFonts = await renderDailyCard(svg);
    const without = await renderDailyCard(svg, []);
    expect(without.equals(withFonts)).toBe(false);
    expect(without.length).toBeLessThan(withFonts.length);
  });

  it('DC5 renders off the event loop: a 1 ms timer ticks while the card is drawn', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      // the fonts named, so the render's own cost is what the timer measures
      await renderDailyCard(dailyCardSvg(dailyCardModel(DAY, RU)), DAILY_CARD_FONT_FILES);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThanOrEqual(1);
  });
});
