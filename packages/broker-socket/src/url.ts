import type { UrlEnvRules } from '@binarius/shared';

export const BROKER_WS_URL_RULES: UrlEnvRules = {
  protocols: ['https:', 'wss:'],
  allowIpv6Literal: false,
};
