import { describe, expect, it } from 'vitest';
import { DAILY_SUMMARY_HOUR, DAILY_SUMMARY_TIME_ZONE } from './mailing';

// #881: the SQL reads both constants as they are, so a bad value would only fail in the database
describe('the daily summary moment', () => {
  it('is a whole hour of the day', () => {
    expect(Number.isInteger(DAILY_SUMMARY_HOUR)).toBe(true);
    expect(DAILY_SUMMARY_HOUR).toBeGreaterThanOrEqual(0);
    expect(DAILY_SUMMARY_HOUR).toBeLessThanOrEqual(23);
  });

  it('is in a time zone the runtime knows', () => {
    expect(
      () => new Intl.DateTimeFormat('en', { timeZone: DAILY_SUMMARY_TIME_ZONE }),
    ).not.toThrow();
  });
});
