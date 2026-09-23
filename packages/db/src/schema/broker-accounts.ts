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
import { AuthRevokedReason } from '@binarius/shared';
import { bytea, createdAt, id, inList, updatedAt } from './columns';
import { users } from './users';

// A freshly linked account starts pending: the OAuth callback proves someone authorized at the
// broker, not that the Telegram user who started the login is that someone. Confirming in the
// bot is what makes it usable.
export const BrokerAccountStatus = {
  Pending: 'pending',
  Active: 'active',
  Revoked: 'revoked',
} as const;
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
    // sha256 of the stored refresh token: the rotation path compares it with the decrypted
    // ciphertext, so a storage desync is caught before a stale token reaches the broker
    refreshTokenHash: text('refresh_token_hash'),
    tokenRotatedAt: timestamp('token_rotated_at', { withTimezone: true }),
    // why OAuth revoked this account; NULL while it is usable. Distinct from trading_halted,
    // which reconciliation (ARCH-04) owns and this flow never writes.
    authRevokedReason: text('auth_revoked_reason').$type<AuthRevokedReason>(),
    status: text('status')
      .$type<BrokerAccountStatus>()
      .notNull()
      // the restrictive value: an insert that forgets the column produces an account that
      // cannot act, rather than one that silently bypassed the confirmation
      .default(BrokerAccountStatus.Pending),
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
    inList('broker_accounts_auth_revoked_reason_check', t.authRevokedReason, AuthRevokedReason),
  ],
);
