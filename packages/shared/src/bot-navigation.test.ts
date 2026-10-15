import { describe, expect, it } from 'vitest';
import { CASHIER_PAGE_PATH, cashierUrlOf } from './bot-navigation';

describe('cashierUrlOf (#27)', () => {
  it('puts the cashier page under an https origin', () => {
    expect(cashierUrlOf('https://web.example')).toBe('https://web.example/cashier');
    expect(CASHIER_PAGE_PATH).toBe('/cashier');
  });

  it.each(['http://127.0.0.1:3001', 'http://localhost:3001'])('gives no URL on %s', (origin) => {
    expect(cashierUrlOf(origin)).toBeUndefined();
  });
});
