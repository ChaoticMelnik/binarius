import { describe, expect, it } from 'vitest';
import { telegramHtml } from './telegram-html';
import {
  composeDurationMs,
  composeServiceEnvValue,
  composeServiceValue,
  telegramTextProblems,
} from './testing';

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
    labels:
      HOST: backend.example
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

describe('composeServiceEnvValue', () => {
  it("reads a variable of the named service's environment map", () => {
    expect(composeServiceEnvValue(yaml, 'backend', 'PORT')).toBe('"3000"');
  });

  it('ignores the name outside environment, under another service, or absent', () => {
    expect(composeServiceEnvValue(yaml, 'backend', 'HOST')).toBeUndefined();
    expect(composeServiceEnvValue(yaml, 'postgres', 'PORT')).toBeUndefined();
    expect(composeServiceEnvValue(yaml, 'backend', 'MISSING')).toBeUndefined();
  });
});

describe('composeDurationMs', () => {
  it('converts whole seconds and rejects anything else', () => {
    expect(composeDurationMs('40s')).toBe(40_000);
    expect(composeDurationMs('1m')).toBeUndefined();
    expect(composeDurationMs(undefined)).toBeUndefined();
  });
});

describe('telegramTextProblems', () => {
  it('passes a clean text', () => {
    expect(telegramTextProblems(telegramHtml`<b>a</b>\nb`)).toEqual([]);
  });

  it('reports what the validator finds', () => {
    expect(telegramTextProblems(telegramHtml`<p>${'x'}</p>`)).toContain(
      '<p> is not a Telegram tag',
    );
  });

  it('reports a text empty after entities parsing', () => {
    expect(telegramTextProblems(telegramHtml`<b></b>`)).toEqual(['empty after entities parsing']);
  });

  it('reports a text over the limit it is given', () => {
    expect(telegramTextProblems(telegramHtml`${'a'.repeat(5)}`, 4)).toEqual([
      '5 UTF-16 code units after entities parsing, the limit is 4',
    ]);
  });

  it('measures against the message limit by default', () => {
    expect(telegramTextProblems(telegramHtml`${'a'.repeat(4096)}`)).toEqual([]);
    expect(telegramTextProblems(telegramHtml`${'a'.repeat(4097)}`)).toEqual([
      '4097 UTF-16 code units after entities parsing, the limit is 4096',
    ]);
  });

  it('reports a line starting or ending with a space, by its number', () => {
    expect(telegramTextProblems(telegramHtml`a\n b\nc `)).toEqual([
      'line 2 starts or ends with a space',
      'line 3 starts or ends with a space',
    ]);
  });
});
