import * as z from 'zod';
import { tradeIntentStatusSchema, tradeIntentViewSchema } from './trading';

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
