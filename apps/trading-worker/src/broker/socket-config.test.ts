import { describe, expect, it } from 'vitest';
import {
  BROKER_SOCKET_AUTH_TIMEOUT_MS,
  BROKER_SOCKET_CONNECT_TIMEOUT_MS,
  BROKER_SOCKET_RECONNECT_DELAY_MAX_MS,
  BROKER_SOCKET_RECONNECT_DELAY_MS,
  BROKER_SOCKET_RECONNECT_JITTER,
  DEFAULT_BROKER_SOCKET_TIMING,
  resolveBrokerSocketTiming,
} from './socket-config';

// The defaults are checked at import: socket-config.ts throws when they are out of order, so a
// violation takes this file down before the first test runs. The first case restates the chain
// for the reader; the override cases are the ones that can fail.
describe('broker socket timing', () => {
  it('keeps the defaults in order', () => {
    expect(BROKER_SOCKET_RECONNECT_DELAY_MS).toBeLessThanOrEqual(
      BROKER_SOCKET_RECONNECT_DELAY_MAX_MS,
    );
    expect(BROKER_SOCKET_AUTH_TIMEOUT_MS).toBeLessThanOrEqual(BROKER_SOCKET_CONNECT_TIMEOUT_MS);
    expect(BROKER_SOCKET_RECONNECT_JITTER).toBeGreaterThanOrEqual(0);
    expect(BROKER_SOCKET_RECONNECT_JITTER).toBeLessThanOrEqual(1);
  });

  it('fills an override from the defaults and accepts each link at equality', () => {
    expect(resolveBrokerSocketTiming()).toEqual(DEFAULT_BROKER_SOCKET_TIMING);
    expect(
      resolveBrokerSocketTiming({
        connectTimeoutMs: 200,
        authTimeoutMs: 200,
        reconnectDelayMs: 40,
        reconnectDelayMaxMs: 40,
        jitter: 1,
      }),
    ).toEqual({
      connectTimeoutMs: 200,
      authTimeoutMs: 200,
      reconnectDelayMs: 40,
      reconnectDelayMaxMs: 40,
      jitter: 1,
    });
    expect(resolveBrokerSocketTiming({ jitter: 0 }).jitter).toBe(0);
  });

  it.each([
    ['a first wait above the longest', { reconnectDelayMs: 50, reconnectDelayMaxMs: 40 }],
    ['an auth timeout above the connect timeout', { authTimeoutMs: 300, connectTimeoutMs: 200 }],
    ['a negative jitter', { jitter: -0.1 }],
    ['a jitter above 1', { jitter: 1.1 }],
    ['NaN', { authTimeoutMs: Number.NaN }],
    ['a zero auth timeout', { authTimeoutMs: 0 }],
    ['a negative first wait', { reconnectDelayMs: -1 }],
    ['an infinite connect timeout', { connectTimeoutMs: Number.POSITIVE_INFINITY }],
    ['a NaN jitter', { jitter: Number.NaN }],
    ['a fractional delay', { reconnectDelayMs: 1.5 }],
  ])('refuses %s', (_name, override) => {
    expect(() => resolveBrokerSocketTiming(override)).toThrow(RangeError);
  });
});
