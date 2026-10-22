-- #700: drizzle-kit emits the FK before its target's unique key, which Postgres refuses; the key is moved up by hand.
ALTER TABLE "trading_sessions" ADD COLUMN "open_notice_intent_id" uuid;--> statement-breakpoint
ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_id_session_key" UNIQUE("id","trading_session_id");--> statement-breakpoint
ALTER TABLE "trading_sessions" ADD CONSTRAINT "trading_sessions_open_notice_intent_fk" FOREIGN KEY ("open_notice_intent_id","id") REFERENCES "public"."trade_intents"("id","trading_session_id") ON DELETE restrict ON UPDATE no action;
