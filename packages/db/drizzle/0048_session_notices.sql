ALTER TABLE "trading_sessions" ADD COLUMN "notified_trades" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_sessions" ADD COLUMN "final_notice_sent_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "trading_sessions_notice_pending_idx" ON "trading_sessions" USING btree ("created_at") WHERE "trading_sessions"."final_notice_sent_at" is null;--> statement-breakpoint
ALTER TABLE "trading_sessions" ADD CONSTRAINT "trading_sessions_notified_trades_check" CHECK ("trading_sessions"."notified_trades" >= 0);