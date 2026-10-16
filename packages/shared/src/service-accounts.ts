import * as z from 'zod';

// Service accounts (#391, docs/service-accounts.md): broker accounts an admin marked to carry the
// price stream (#404). Fewer working ones than this and every active staff member is alerted in
// the staff bot. A constant by the owner's decision (2026-10-09, Q3), not a setting.
export const SERVICE_ACCOUNTS_MIN = 3;

// Why a marked account is not working, in the token service's order of checks: the user first,
// then the account's own state, then the token's age.
export const ServiceAccountNotWorkingReason = {
  UserBlocked: 'user_blocked',
  Pending: 'pending',
  Revoked: 'revoked',
  TokenExpired: 'token_expired',
} as const;
export type ServiceAccountNotWorkingReason =
  (typeof ServiceAccountNotWorkingReason)[keyof typeof ServiceAccountNotWorkingReason];
export const serviceAccountNotWorkingReasonSchema = z.enum(ServiceAccountNotWorkingReason);
