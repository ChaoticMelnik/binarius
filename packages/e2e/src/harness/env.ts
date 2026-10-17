import type { User } from 'grammy/types';
import type { BinaryPairWire } from '@binarius/shared';

// The external services of the run: the integration project's Postgres and Redis (README → Test
// database). Every other value is the harness's own.
const baseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/e2e integration tests (see README → Test database)',
  );
}
if (redisUrl === undefined || redisUrl === '') {
  throw new Error('REDIS_URL is required for packages/e2e integration tests (see README)');
}

export const TEST_DATABASE_URL = baseUrl;
export const REDIS_URL = redisUrl;

// the bot's and the worker's bearer to the backend (Rule 13): one value, as in production
export const INTERNAL_API_TOKEN = 'e2e-internal-api-token';
// the public bot's token: the bot and the backend's push share it, as in production
export const BOT_TOKEN = '123456:e2e-public-bot-token';
// the installation's OAuth client at the mock broker, the same object on both sides
export const MOCK_OAUTH = { clientId: 'e2e-client', clientSecret: 'e2e-secret' } as const;
export const PARTNER_REF = 'e2eref';
export const REDIRECT_URI = 'https://binarius.example/auth/callback';
// the broker's postback URL secret (POSTBACK_URL_SECRET_PATTERN): the route and the run's
// deliveries share this one value
export const E2E_POSTBACK_SECRET = 'e2e-postback-secret-0123456789abcdef';

export const E2E_EMAIL = 'ada@example.test';
export const E2E_BROKER_USER_ID = 7001;
// the other two Telegram users of the repeat run (#106): B invites, C follows B's link
export const E2E_USER_B: User = { id: 4343, is_bot: false, first_name: 'Bob' };
export const E2E_USER_C: User = { id: 4444, is_bot: false, first_name: 'Cy' };

// The only pair of the run: 15 s is within its timeframes, unlike the mock's EUR/USD (60 s), so the
// bot offers it for the 15-second demo; a payout of 85 is above the session's floor of 80.
export const E2E_PAIR: BinaryPairWire = {
  id: 101,
  symbol: 'EUR/USD',
  is_otc: true,
  type: 'currency',
  digits: 5,
  payout: 85,
  max_payout: 90,
  min_timeframe: 5,
  max_timeframe: 3600,
  scheduled_until: 0,
};
