import * as z from 'zod';
import {
  telegramUserIdSchema,
  TradeIntentStatus,
  tradeIntentStatusSchema,
  tradeIntentViewSchema,
  tradeModeSchema,
} from './trading';
import {
  tradingSessionSettingsSchema,
  tradingSessionStatusSchema,
  tradingSessionStopReasonSchema,
} from './trading-session';

// Data shapes of the admin trading pages. This module never imports ./admin: that one builds its
// envelopes from these at load time, and a cycle between the two would leave one of them
// half-initialized under `export *` in the root index.

// Not a TradeIntentStatus: the filter for "every status that is not terminal".
export const ADMIN_INTENTS_ACTIVE_FILTER = 'active';

export const adminIntentStatusFilterSchema = z.union([
  tradeIntentStatusSchema,
  z.literal(ADMIN_INTENTS_ACTIVE_FILTER),
]);
export type AdminIntentStatusFilter = z.infer<typeof adminIntentStatusFilterSchema>;

// The bot's view of an intent, key for key, plus what only staff navigate by. Strict, unlike the
// bot's: a key the backend grew is a contract violation on web, not a silently stripped field.
export const adminTradeIntentViewSchema = z.strictObject({
  ...tradeIntentViewSchema.shape,
  userId: z.uuid(),
  tradingSessionId: z.uuid().nullable(),
  // when the reconciliation pass last took the intent (its lease, #89); null = never
  reconcileClaimedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type AdminTradeIntentView = z.infer<typeof adminTradeIntentViewSchema>;

// --- The user card's trading section, the overview breakdown, the sessions page (#330) ---------

export const ADMIN_USER_RECENT_INTENTS = 20;

const count = z.int().nonnegative();
const isoDateTime = z.iso.datetime({ offset: true });

function counts<K extends string>(keys: readonly K[]) {
  return z.strictObject(
    Object.fromEntries(keys.map((key) => [key, count])) as Record<K, typeof count>,
  );
}

// Every status, zeros included: a status missing from the answer is a contract violation.
export const adminIntentsByStatusSchema = counts(Object.values(TradeIntentStatus));
export type AdminIntentsByStatus = z.infer<typeof adminIntentsByStatusSchema>;

export const adminUserIntentsSectionSchema = z.strictObject({
  recent: z.array(adminTradeIntentViewSchema).max(ADMIN_USER_RECENT_INTENTS),
  total: count,
  active: count,
});
export type AdminUserIntentsSection = z.infer<typeof adminUserIntentsSectionSchema>;

// `settings` is the parsed v1 value or null: the raw jsonb never reaches the wire.
export const adminTradingSessionViewSchema = z.strictObject({
  id: z.uuid(),
  brokerAccountId: z.uuid(),
  brokerUserId: z.string(),
  userId: z.uuid(),
  telegramUserId: telegramUserIdSchema,
  mode: tradeModeSchema,
  status: tradingSessionStatusSchema,
  stopReason: tradingSessionStopReasonSchema.nullable(),
  settings: tradingSessionSettingsSchema.nullable(),
  startedAt: isoDateTime,
  endedAt: isoDateTime.nullable(),
  lastDecisionAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type AdminTradingSessionView = z.infer<typeof adminTradingSessionViewSchema>;
