import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, createdAt, id, inList, updatedAt } from './columns';
import { users } from './users';

export const BrokerAccountStatus = { Active: 'active', Revoked: 'revoked' } as const;
export type BrokerAccountStatus = (typeof BrokerAccountStatus)[keyof typeof BrokerAccountStatus];

// tokens are AES-256-GCM ciphertexts (see ../crypto.ts); token_key_id names the key for rotation
export const brokerAccounts = pgTable(
  'broker_accounts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    brokerUserId: text('broker_user_id').notNull(),
    email: text('email'),
    isPartnerClient: boolean('is_partner_client').notNull().default(false),
    accessTokenEnc: bytea('access_token_enc').notNull(),
    refreshTokenEnc: bytea('refresh_token_enc').notNull(),
    tokenKeyId: text('token_key_id').notNull(),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }).notNull(),
    status: text('status')
      .$type<BrokerAccountStatus>()
      .notNull()
      .default(BrokerAccountStatus.Active),
    // ARCH-04: an ambiguous reconciliation match halts new intents for the account
    tradingHalted: boolean('trading_halted').notNull().default(false),
    haltedReason: text('halted_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('broker_accounts_broker_user_id_idx').on(t.brokerUserId),
    // target of the composite ownership FKs (trade_intents)
    unique('broker_accounts_id_user_id_key').on(t.id, t.userId),
    index('broker_accounts_user_id_idx').on(t.userId),
    inList('broker_accounts_status_check', t.status, BrokerAccountStatus),
  ],
);
