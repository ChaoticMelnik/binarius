import * as z from 'zod';
import { decimalStringSchema } from './money';

// The broker side of POST /trading/access (#137): the last balance snapshot the backend holds
// for one broker account, with its ages. docs/broker-balance.md describes where it comes from.

// A snapshot is fresh while its newest observation (REST or a socket balance event) is at most
// this old. The background refresh runs at least this often (apps/backend/src/timing.ts).
export const BROKER_BALANCE_SLA_SEC = 60;
export const BROKER_BALANCE_SLA_MS = BROKER_BALANCE_SLA_SEC * 1000;

// Upper estimate of POST /trading/access: one bounded broker GET plus database latency. It lives
// here because the bot sizes its request timeout above it (#24) and the backend's own budget for
// that GET sits below it.
export const TRADING_ACCESS_BUDGET_MS = 4_000;

// Why `broker` is null. Each has one source: the account lookup, the user's status, a token that
// needs an exchange first, or the broker call itself (docs/trading-access.md → Broker balance).
export const BrokerBalanceUnavailableReason = {
  NoAccount: 'no_account',
  AmbiguousAccount: 'ambiguous_account',
  AccountPending: 'account_pending',
  AccountRevoked: 'account_revoked',
  UserBlocked: 'user_blocked',
  Refreshing: 'refreshing',
  BrokerUnavailable: 'broker_unavailable',
} as const;
export type BrokerBalanceUnavailableReason =
  (typeof BrokerBalanceUnavailableReason)[keyof typeof BrokerBalanceUnavailableReason];
export const brokerBalanceUnavailableReasonSchema = z.enum(BrokerBalanceUnavailableReason);

const ageSecSchema = z.int().nonnegative();

const modeBalanceSchema = z.object({
  available: decimalStringSchema,
  held: decimalStringSchema,
  total: decimalStringSchema,
});

export const isBalanceFresh = (restSnapshotAgeSec: number, balanceEventAgeSec: number | null) =>
  Math.min(restSnapshotAgeSec, balanceEventAgeSec ?? Infinity) <= BROKER_BALANCE_SLA_SEC;

// Amounts are DecimalString as stored (numeric(20,8): '10000.00000000'); formatting is the
// bot's. `fresh` is computed by the backend, the refine only lets a parser refuse a body whose
// flag disagrees with its ages.
export const brokerBalanceViewSchema = z
  .object({
    real: modeBalanceSchema,
    demo: modeBalanceSchema,
    minTradeAmount: decimalStringSchema,
    level: z.object({ code: z.string(), rank: z.number().nonnegative() }),
    restSnapshotAgeSec: ageSecSchema,
    balanceEventAgeSec: ageSecSchema.nullable(),
    fresh: z.boolean(),
  })
  .refine(
    ({ restSnapshotAgeSec, balanceEventAgeSec, fresh }) =>
      !ageSecSchema.safeParse(restSnapshotAgeSec).success ||
      !ageSecSchema.nullable().safeParse(balanceEventAgeSec).success ||
      fresh === isBalanceFresh(restSnapshotAgeSec, balanceEventAgeSec),
    { error: 'fresh must agree with the ages' },
  );
export type BrokerBalanceView = z.infer<typeof brokerBalanceViewSchema>;
