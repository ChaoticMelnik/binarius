import { describe, expect, it } from 'vitest';
import { composeDurationMs, composeServiceValue } from './testing';

const yaml = `services:
  postgres:
    image: postgres:18-alpine
    healthcheck:
      stop_grace_period: 99s
  backend:
    <<: *app
    stop_grace_period: 20s
    environment:
      PORT: "3000"
  trading-worker:
    stop_grace_period: 40s
`;

describe('composeServiceValue', () => {
  it('reads a direct child of the named service only', () => {
    expect(composeServiceValue(yaml, 'backend', 'stop_grace_period')).toBe('20s');
    expect(composeServiceValue(yaml, 'trading-worker', 'stop_grace_period')).toBe('40s');
  });

  it('ignores the same key nested under another key or on a neighbouring service', () => {
    expect(composeServiceValue(yaml, 'postgres', 'stop_grace_period')).toBeUndefined();
    expect(composeServiceValue(yaml, 'bot', 'stop_grace_period')).toBeUndefined();
  });
});

describe('composeDurationMs', () => {
  it('converts whole seconds and rejects anything else', () => {
    expect(composeDurationMs('40s')).toBe(40_000);
    expect(composeDurationMs('1m')).toBeUndefined();
    expect(composeDurationMs(undefined)).toBeUndefined();
  });
});
