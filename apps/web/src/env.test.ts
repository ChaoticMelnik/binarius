import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const valid = {
  BACKEND_URL: 'http://backend:3000',
  ADMIN_WEB_TOKEN: 'admin-web-token-for-tests',
  ADMIN_PUBLIC_URL: 'http://127.0.0.1:3001',
};

describe('parseEnv', () => {
  it('applies the defaults for the optional variables', () => {
    expect(parseEnv(valid)).toEqual({
      port: 3000,
      logLevel: 'info',
      backendUrl: valid.BACKEND_URL,
      adminWebToken: valid.ADMIN_WEB_TOKEN,
      publicOrigin: 'http://127.0.0.1:3001',
      secureCookies: false,
    });
  });

  it('accepts explicit optional variables', () => {
    const env = parseEnv({ ...valid, PORT: '8080', LOG_LEVEL: 'debug' });
    expect([env.port, env.logLevel]).toEqual([8080, 'debug']);
  });

  it.each(['BACKEND_URL', 'ADMIN_WEB_TOKEN', 'ADMIN_PUBLIC_URL'] as const)(
    'requires %s',
    (name) => {
      const without: Record<string, string> = { ...valid };
      delete without[name];
      expect(() => parseEnv(without)).toThrow(`Missing required env ${name}`);
    },
  );

  // Secure is not a preference: a cookie marked Secure is dropped over http, so the flag has
  // to follow the scheme the pages are actually served on
  it.each([
    ['https://admin.example', true],
    ['http://127.0.0.1:3001', false],
    ['http://localhost:3001', false],
  ])('marks the cookie Secure for %s: %s', (ADMIN_PUBLIC_URL, secure) => {
    expect(parseEnv({ ...valid, ADMIN_PUBLIC_URL }).secureCookies).toBe(secure);
  });

  it('normalises the public origin the way a browser does', () => {
    expect(parseEnv({ ...valid, ADMIN_PUBLIC_URL: 'https://Admin.Example/' }).publicOrigin).toBe(
      'https://admin.example',
    );
    expect(parseEnv({ ...valid, ADMIN_PUBLIC_URL: 'https://admin.example:443/' }).publicOrigin).toBe(
      'https://admin.example',
    );
  });

  // a value that is not an origin was meant to be something else, and silently dropping the
  // part that does not fit would compare the Origin header against a value nobody configured
  it.each([
    'https://admin.example/path',
    'https://admin.example/?a=1',
    'http://admin.example',
    'ftp://admin.example',
    'not-a-url',
  ])('refuses ADMIN_PUBLIC_URL=%s', (ADMIN_PUBLIC_URL) => {
    expect(() => parseEnv({ ...valid, ADMIN_PUBLIC_URL })).toThrow('Env ADMIN_PUBLIC_URL');
  });

  it.each(['short', 'has whitespace '])('refuses a weak ADMIN_WEB_TOKEN (%j)', (ADMIN_WEB_TOKEN) => {
    expect(() => parseEnv({ ...valid, ADMIN_WEB_TOKEN })).toThrow('Env ADMIN_WEB_TOKEN');
  });

  it.each(['postgres://backend/db', 'backend:3000'])('refuses BACKEND_URL=%s', (BACKEND_URL) => {
    expect(() => parseEnv({ ...valid, BACKEND_URL })).toThrow('Env BACKEND_URL');
  });
});
