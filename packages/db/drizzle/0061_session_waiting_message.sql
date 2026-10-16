ALTER TABLE "trading_sessions" ADD COLUMN "waiting_message_id" integer;--> statement-breakpoint
ALTER TABLE "trading_sessions" ADD COLUMN "waiting_after_message" integer;--> statement-breakpoint
ALTER TABLE "trading_sessions" ADD CONSTRAINT "trading_sessions_waiting_message_id_check" CHECK ("trading_sessions"."waiting_message_id" > 0);--> statement-breakpoint
ALTER TABLE "trading_sessions" ADD CONSTRAINT "trading_sessions_waiting_after_message_check" CHECK ("trading_sessions"."waiting_after_message" >= 0);--> statement-breakpoint
ALTER TABLE "trading_sessions" ADD CONSTRAINT "trading_sessions_waiting_pair_check" CHECK ("trading_sessions"."waiting_message_id" is null or "trading_sessions"."waiting_after_message" is not null);