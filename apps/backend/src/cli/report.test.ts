import { describe, expect, it } from 'vitest';
import { parseSince, resolveWindow } from './report';

// The window parser both report CLIs share (#502, docs/trade-log.md → The report).
describe('parseSince (#502)', () => {
  it('W1 takes an ISO instant as given and Nh / Nd as a span, and names the flag on a refusal', () => {
    expect(parseSince('2026-10-20T00:00:00.123Z', '--since')).toEqual({
      at: new Date('2026-10-20T00:00:00.123Z'),
    });
    expect(parseSince('24h', '--since')).toEqual({ hours: 24 });
    expect(parseSince('7d', '--since')).toEqual({ days: 7 });
    expect(parseSince('9999d', '--since')).toEqual({ days: 9999 });
    for (const raw of ['0h', '10000d', '2026-10-20T00:00:00.1234Z', '2026-10-20T00:00:00', '7w']) {
      expect(() => parseSince(raw, '--from-flag'), raw).toThrow(/^--from-flag: .*24h, 7d/);
    }
  });
});

describe('resolveWindow (#502)', () => {
  const end = new Date('2026-10-23T12:00:00.000Z');
  it('W2 counts a relative --since back from --until, else from the end it is given', () => {
    const until = new Date('2026-10-22T00:00:00.000Z');
    expect(resolveWindow({ since: { hours: 24 }, until }, end)).toEqual({
      since: new Date('2026-10-21T00:00:00.000Z'),
      until,
    });
    expect(resolveWindow({ since: { days: 2 }, until: undefined }, end)).toEqual({
      since: new Date('2026-10-21T12:00:00.000Z'),
      until: end,
    });
    const at = new Date('2026-10-01T00:00:00.000Z');
    expect(resolveWindow({ since: { at }, until: undefined }, end)).toEqual({
      since: at,
      until: end,
    });
  });
});
