import { describe, expect, it } from 'vitest';
import { CASHIER_PAGE_PATH, cashierUrlOf, demoAnalysisCallbackData } from './bot-navigation';

describe('cashierUrlOf (#27)', () => {
  it('puts the cashier page under an https origin', () => {
    expect(cashierUrlOf('https://web.example')).toBe('https://web.example/cashier');
    expect(CASHIER_PAGE_PATH).toBe('/cashier');
  });

  it.each(['http://127.0.0.1:3001', 'http://localhost:3001'])('gives no URL on %s', (origin) => {
    expect(cashierUrlOf(origin)).toBeUndefined();
  });
});

describe('demoAnalysisCallbackData (#484)', () => {
  it('draws the analysis of a pair and duration within the 64 bytes', () => {
    expect(demoAnalysisCallbackData(101, 15)).toBe('demo:an:101:15');
    const longest = demoAnalysisCallbackData(2147483647, 15);
    expect(longest).toBe('demo:an:2147483647:15');
    expect(new TextEncoder().encode(longest).length).toBe(21);
  });
});
