import {
  HTTPS_ONLY_RULES,
  parseBoundedIntegerEnv,
  parseInternalTokenEnv,
  parseLogLevelEnv,
  parseDepositWidgetOriginsEnv,
  parseOriginEnv,
  parseUrlEnv,
  readEnv,
  type EnvSource,
  type LogLevel,
  type UrlEnvRules,
} from '@binarius/shared';

// the backend is reached over the compose network; https is allowed so a split deployment can
// put the two behind separate hosts
const BACKEND_URL_RULES: UrlEnvRules = { protocols: ['http:', 'https:'], allowIpv6Literal: false };

export interface Env {
  port: number;
  logLevel: LogLevel;
  backendUrl: string;
  adminWebToken: string;
  /** the origin these pages are served from, normalised: a POST's `Origin` header must equal it,
   *  and the broker must redirect back to it */
  publicOrigin: string;
  /** the broker's authorize page, the one place GET /oauth/login navigates to */
  brokerAuthorizeUrl: string;
  /** whether the session cookie may be marked Secure; false is not a preference but a fact
   *  about how the pages are served, and marking a cookie Secure over http would drop it */
  secureCookies: boolean;
  /** the origins the cashier widget may be served from (#111): the page's frame-src, and the
   *  check of the backend's answer — the backend reads the same variable with the same parser */
  depositWidgetOrigins: string[];
}

export function parseEnv(source: EnvSource): Env {
  const publicOrigin = parseOriginEnv(readEnv(source, 'WEB_PUBLIC_URL'), 'WEB_PUBLIC_URL');
  const brokerAuthorizeUrl = parseUrlEnv(
    readEnv(source, 'BROKER_OAUTH_AUTHORIZE_URL'),
    'BROKER_OAUTH_AUTHORIZE_URL',
    HTTPS_ONLY_RULES,
  );
  return {
    port: parseBoundedIntegerEnv(readEnv(source, 'PORT', '3000'), 'PORT', 1, 65535),
    logLevel: parseLogLevelEnv(readEnv(source, 'LOG_LEVEL', 'info'), 'LOG_LEVEL'),
    backendUrl: parseUrlEnv(readEnv(source, 'BACKEND_URL'), 'BACKEND_URL', BACKEND_URL_RULES),
    adminWebToken: parseInternalTokenEnv(readEnv(source, 'ADMIN_WEB_TOKEN'), 'ADMIN_WEB_TOKEN'),
    publicOrigin,
    brokerAuthorizeUrl,
    secureCookies: publicOrigin.startsWith('https:'),
    depositWidgetOrigins: parseDepositWidgetOriginsEnv(source, new URL(brokerAuthorizeUrl).origin),
  };
}
