import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const valid = {
  BACKEND_URL: 'http://backend:3000',
  ADMIN_WEB_TOKEN: 'admin-web-token-for-tests',
  WEB_PUBLIC_URL: 'http://127.0.0.1:3001',
  BROKER_OAUTH_AUTHORIZE_URL: 'https://binodex.app/oauth/authorize',
};

describe('parseEnv', () => {
  it('applies the defaults for the optional variables', () => {
    expect(parseEnv(valid)).toEqual({
      port: 3000,
      logLevel: 'info',
      backendUrl: valid.BACKEND_URL,
      adminWebToken: valid.ADMIN_WEB_TOKEN,
      publicOrigin: 'http://127.0.0.1:3001',
      brokerAuthorizeUrl: 'https://binodex.app/oauth/authorize',
      secureCookies: false,
    });
  });

  it('accepts explicit optional variables', () => {
    const env = parseEnv({ ...valid, PORT: '8080', LOG_LEVEL: 'debug' });
    expect([env.port, env.logLevel]).toEqual([8080, 'debug']);
  });

  it.each(['BACKEND_URL', 'ADMIN_WEB_TOKEN', 'WEB_PUBLIC_URL', 'BROKER_OAUTH_AUTHORIZE_URL'] as const)(
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
  ])('marks the cookie Secure for %s: %s', (WEB_PUBLIC_URL, secure) => {
    expect(parseEnv({ ...valid, WEB_PUBLIC_URL }).secureCookies).toBe(secure);
  });

  it('normalises the public origin the way a browser does', () => {
    expect(parseEnv({ ...valid, WEB_PUBLIC_URL: 'https://Admin.Example/' }).publicOrigin).toBe(
      'https://admin.example',
    );
    expect(parseEnv({ ...valid, WEB_PUBLIC_URL: 'https://admin.example:443/' }).publicOrigin).toBe(
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
  ])('refuses WEB_PUBLIC_URL=%s', (WEB_PUBLIC_URL) => {
    expect(() => parseEnv({ ...valid, WEB_PUBLIC_URL })).toThrow('Env WEB_PUBLIC_URL');
  });

  it.each(['short', 'has whitespace '])('refuses a weak ADMIN_WEB_TOKEN (%j)', (ADMIN_WEB_TOKEN) => {
    expect(() => parseEnv({ ...valid, ADMIN_WEB_TOKEN })).toThrow('Env ADMIN_WEB_TOKEN');
  });

  it.each(['postgres://backend/db', 'backend:3000'])('refuses BACKEND_URL=%s', (BACKEND_URL) => {
    expect(() => parseEnv({ ...valid, BACKEND_URL })).toThrow('Env BACKEND_URL');
  });

  // the login page navigates the Mini App there; http would hand the login to the path
  it.each([
    ['http://binodex.app/oauth/authorize', 'Env BROKER_OAUTH_AUTHORIZE_URL must use one of: https:'],
    ['not-a-url', 'Env BROKER_OAUTH_AUTHORIZE_URL'],
  ])('refuses BROKER_OAUTH_AUTHORIZE_URL=%s', (BROKER_OAUTH_AUTHORIZE_URL, message) => {
    expect(() => parseEnv({ ...valid, BROKER_OAUTH_AUTHORIZE_URL })).toThrow(message);
  });
});
