import { describe, expect, it } from 'vitest';
import {
  CASHIER_PAGE_PATH,
  SESSION_STOP_PATTERN,
  cashierUrlOf,
  demoAnalysisCallbackData,
  sessionStopCallbackData,
} from './bot-navigation';

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

describe('the session stop button (#536)', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('carries the id, and `:w` under the waiting message, within 64 bytes', () => {
    expect(sessionStopCallbackData(id)).toBe(`session:stop:${id}`);
    expect(sessionStopCallbackData(id, { waiting: true })).toBe(`session:stop:${id}:w`);
    expect(new TextEncoder().encode(sessionStopCallbackData(id))).toHaveLength(49);
    expect(new TextEncoder().encode(sessionStopCallbackData(id, { waiting: true }))).toHaveLength(
      51,
    );
  });

  it('matches both forms and says which', () => {
    expect(SESSION_STOP_PATTERN.exec(sessionStopCallbackData(id))?.slice(1)).toEqual([
      id,
      undefined,
    ]);
    expect(
      SESSION_STOP_PATTERN.exec(sessionStopCallbackData(id, { waiting: true }))?.slice(1),
    ).toEqual([id, 'w']);
  });

  it.each([`session:${id}`, `session:stop:${id}:x`, `session:stop:${id}:`, 'session:stop:nope'])(
    'does not match %s',
    (data) => {
      expect(SESSION_STOP_PATTERN.test(data)).toBe(false);
    },
  );
});
