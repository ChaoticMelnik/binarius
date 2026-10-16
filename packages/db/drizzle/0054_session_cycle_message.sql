ALTER TABLE "trading_sessions" ADD COLUMN "cycle_message_id" integer;--> statement-breakpoint
ALTER TABLE "trading_sessions" ADD COLUMN "cycle_message_from" integer;--> statement-breakpoint
ALTER TABLE "trading_sessions" ADD CONSTRAINT "trading_sessions_cycle_message_pair_check" CHECK (("trading_sessions"."cycle_message_id" is null) = ("trading_sessions"."cycle_message_from" is null));--> statement-breakpoint
ALTER TABLE "trading_sessions" ADD CONSTRAINT "trading_sessions_cycle_message_id_check" CHECK ("trading_sessions"."cycle_message_id" > 0);--> statement-breakpoint
ALTER TABLE "trading_sessions" ADD CONSTRAINT "trading_sessions_cycle_message_from_check" CHECK ("trading_sessions"."cycle_message_from" >= 0);