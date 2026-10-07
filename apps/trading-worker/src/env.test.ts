import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  BACKEND_URL: 'http://backend:3000',
  INTERNAL_API_TOKEN: 'internal-token-for-tests-0123456789',
  BROKER_API_BASE_URL: 'https://api.binodex.app',
};

describe('parseEnv', () => {
  it('applies defaults for the optional variables', () => {
    expect(parseEnv(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      redisUrl: valid.REDIS_URL,
      logLevel: 'info',
      intentMaxAgeMs: 60_000,
      submitAckTimeoutMs: 10_000,
      workerConcurrency: 5,
      backendUrl: valid.BACKEND_URL,
      internalApiToken: valid.INTERNAL_API_TOKEN,
      brokerApiBaseUrl: valid.BROKER_API_BASE_URL,
      brokerWsUrl: undefined,
    });
  });

  it.each(['https://broker-ws.binodex.app', 'wss://broker-ws.binodex.app/socket'])(
    'reads BROKER_WS_URL=%s',
    (value) => {
      expect(parseEnv({ ...valid, BROKER_WS_URL: value }).brokerWsUrl).toBe(value);
    },
  );

  it('accepts explicit values', () => {
    const env = parseEnv({
      ...valid,
      LOG_LEVEL: 'debug',
      INTENT_MAX_AGE_MS: '30000',
      SUBMIT_ACK_TIMEOUT_MS: '5000',
      WORKER_CONCURRENCY: '1',
    });
    expect(env).toMatchObject({
      logLevel: 'debug',
      intentMaxAgeMs: 30_000,
      submitAckTimeoutMs: 5_000,
      workerConcurrency: 1,
    });
  });

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'BACKEND_URL',
    'INTERNAL_API_TOKEN',
    'BROKER_API_BASE_URL',
  ])('rejects missing %s', (name) => {
    expect(() => parseEnv({ ...valid, [name]: undefined })).toThrow(`Missing required env ${name}`);
  });

  it.each(['BACKEND_URL', 'INTERNAL_API_TOKEN', 'BROKER_API_BASE_URL'])(
    'rejects an empty %s',
    (name) => {
      expect(() => parseEnv({ ...valid, [name]: '' })).toThrow(name);
    },
  );

  it.each([
    ['BACKEND_URL', 'ftp://backend:3000'],
    ['BACKEND_URL', 'http://[::1]:3000'],
    ['BROKER_API_BASE_URL', 'http://api.binodex.app'],
    ['BROKER_WS_URL', ''],
    ['BROKER_WS_URL', 'http://broker-ws.binodex.app'],
    ['BROKER_WS_URL', 'ws://broker-ws.binodex.app'],
    ['BROKER_WS_URL', 'wss://[::1]:443'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => parseEnv({ ...valid, [name]: value })).toThrow(name);
  });

  it.each([
    ['INTENT_MAX_AGE_MS', '999', 'Env INTENT_MAX_AGE_MS must be between 1000 and 600000'],
    ['INTENT_MAX_AGE_MS', '600001', 'Env INTENT_MAX_AGE_MS must be between 1000 and 600000'],
    ['SUBMIT_ACK_TIMEOUT_MS', '499', 'Env SUBMIT_ACK_TIMEOUT_MS must be between 500 and 30000'],
    ['SUBMIT_ACK_TIMEOUT_MS', '30001', 'Env SUBMIT_ACK_TIMEOUT_MS must be between 500 and 30000'],
    ['WORKER_CONCURRENCY', '0', 'Env WORKER_CONCURRENCY must be between 1 and 100'],
    ['WORKER_CONCURRENCY', 'x', 'Env WORKER_CONCURRENCY must be an integer'],
    ['LOG_LEVEL', 'loud', 'Env LOG_LEVEL must be one of: fatal error warn info debug trace silent'],
  ])('rejects %s=%s', (name, value, message) => {
    expect(() => parseEnv({ ...valid, [name]: value })).toThrow(message);
  });
});
