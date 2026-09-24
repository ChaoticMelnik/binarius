import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const base = {
  TELEGRAM_BOT_TOKEN: '123456:AA-bot-token',
  INTERNAL_API_TOKEN: 'internal-token-for-tests',
  BACKEND_URL: 'http://backend:3000',
};

describe('parseEnv', () => {
  it('returns every value, with the log level defaulted and no video', () => {
    expect(parseEnv({ ...base })).toEqual({
      telegramBotToken: '123456:AA-bot-token',
      internalApiToken: 'internal-token-for-tests',
      backendUrl: 'http://backend:3000',
      logLevel: 'info',
      welcomeVideoFileId: undefined,
    });
  });

  it.each(['TELEGRAM_BOT_TOKEN', 'INTERNAL_API_TOKEN', 'BACKEND_URL'])(
    'refuses a missing %s',
    (name) => {
      const source: Record<string, string> = { ...base };
      delete source[name];
      expect(() => parseEnv(source)).toThrow(`Missing required env ${name}`);
    },
  );

  it.each(['TELEGRAM_BOT_TOKEN', 'INTERNAL_API_TOKEN', 'BACKEND_URL'])(
    'refuses an empty %s',
    (name) => {
      expect(() => parseEnv({ ...base, [name]: '' })).toThrow(`Env ${name} must not be empty`);
    },
  );

  it.each([' 123456:AA', '123456:AA\n', '123 456:AA'])(
    'refuses whitespace in the token %j',
    (raw) => {
      expect(() => parseEnv({ ...base, TELEGRAM_BOT_TOKEN: raw })).toThrow(
        'Env TELEGRAM_BOT_TOKEN must not contain whitespace',
      );
    },
  );

  it('applies the shared internal-token rules', () => {
    expect(() => parseEnv({ ...base, INTERNAL_API_TOKEN: 'short' })).toThrow(
      'Env INTERNAL_API_TOKEN must be at least 16 characters',
    );
  });

  it.each([
    ['ftp://backend:3000', 'Env BACKEND_URL must use one of: http: https:'],
    ['not a url', 'Env BACKEND_URL is not a valid URL'],
    ['http://[::1]:3000', 'Env BACKEND_URL: IPv6 literal hosts are not supported, use a hostname'],
  ])('refuses BACKEND_URL=%s', (url, message) => {
    expect(() => parseEnv({ ...base, BACKEND_URL: url })).toThrow(message);
  });

  it('refuses an unknown log level and accepts a known one', () => {
    expect(() => parseEnv({ ...base, LOG_LEVEL: 'verbose' })).toThrow(
      'Env LOG_LEVEL must be one of',
    );
    expect(parseEnv({ ...base, LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
  });

  it('takes the welcome video when it is set and refuses an empty one', () => {
    expect(parseEnv({ ...base, WELCOME_VIDEO_FILE_ID: 'BAACAgIAAxkB' }).welcomeVideoFileId).toBe(
      'BAACAgIAAxkB',
    );
    expect(() => parseEnv({ ...base, WELCOME_VIDEO_FILE_ID: '' })).toThrow(
      'Env WELCOME_VIDEO_FILE_ID must not be empty',
    );
  });
});
