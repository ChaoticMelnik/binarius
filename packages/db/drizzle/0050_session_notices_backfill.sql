-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model data.
-- #464: the session notices start from the deploy (docs/bot-session.md -> Trade messages). Every
-- existing session's cursor is set to its settled trades - a settled intent with its broker
-- trade, the cursor's own count - so nothing already settled is sent, and every stopped session
-- gets its summary mark, so no summary goes out for a session that ended before the deploy and
-- its card (#318) is not held back by the mark. An active session gets its later trades and its
-- summary.
UPDATE "trading_sessions" SET "notified_trades" = (
  SELECT count(*) FROM "trade_intents"
    JOIN "broker_trades" ON "broker_trades"."intent_id" = "trade_intents"."id"
   WHERE "trade_intents"."trading_session_id" = "trading_sessions"."id"
     AND "trade_intents"."status" = 'settled'
);--> statement-breakpoint
UPDATE "trading_sessions" SET "final_notice_sent_at" = now() WHERE "status" = 'stopped';
