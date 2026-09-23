import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id } from './columns';

// One row per started login (#9). Only the hash of the state is stored: the value itself goes
// to the caller inside the authorize URL, and a database dump must not let anyone finish a
// login someone else started. Consumption is a CAS on used_at, so a state works exactly once.
export const oauthStates = pgTable(
  'oauth_states',
  {
    id: id(),
    stateHash: text('state_hash').notNull(),
    telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }).notNull(),
    // stored rather than re-read from configuration: the exchange must present the very URI
    // the authorize request used, even if the configuration changed meanwhile
    redirectUri: text('redirect_uri').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('oauth_states_state_hash_idx').on(t.stateHash),
    index('oauth_states_expires_at_idx').on(t.expiresAt),
    check('oauth_states_expires_after_created_check', sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      'oauth_states_used_after_created_check',
      sql`${t.usedAt} is null or ${t.usedAt} >= ${t.createdAt}`,
    ),
  ],
);
