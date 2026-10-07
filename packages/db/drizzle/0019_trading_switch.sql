CREATE TABLE "trading_switch" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"trading_enabled" boolean NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_switch_singleton_check" CHECK ("trading_switch"."id"),
	CONSTRAINT "trading_switch_source_check" CHECK ("trading_switch"."source" in ('migration', 'operator')),
	CONSTRAINT "trading_switch_stop_reason_check" CHECK ("trading_switch"."trading_enabled" or "trading_switch"."reason" is not null),
	CONSTRAINT "trading_switch_reason_length_check" CHECK (char_length("trading_switch"."reason") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "trading_sessions" DROP CONSTRAINT "trading_sessions_stop_reason_check";--> statement-breakpoint
ALTER TABLE "trade_intents" DROP CONSTRAINT "trade_intents_last_error_check";--> statement-breakpoint
ALTER TABLE "outbox_events" DROP CONSTRAINT "outbox_events_last_error_check";--> statement-breakpoint
-- #144: real_trading_disabled leaves the reason list, so rows that carry it move to trading_paused
-- before the new CHECKs are added (no status changes, so the transition guard does not fire)
UPDATE "trade_intents" SET "last_error" = 'trading_paused' WHERE "last_error" = 'real_trading_disabled';--> statement-breakpoint
UPDATE "outbox_events" SET "last_error" = 'trading_paused' WHERE "last_error" = 'real_trading_disabled';--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_check";--> statement-breakpoint
ALTER TABLE "trading_sessions" ADD CONSTRAINT "trading_sessions_stop_reason_check" CHECK ("trading_sessions"."stop_reason" in ('completed', 'manual_review', 'rejected_twice', 'timeout', 'stake_stop', 'account_unavailable', 'pair_unavailable', 'balance_unavailable', 'invalid_settings', 'user_stopped', 'kill_switch'));--> statement-breakpoint
ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_last_error_check" CHECK ("trade_intents"."last_error" in ('expired', 'executor_not_configured', 'executor_timeout', 'executor_error', 'broker_rejected', 'publish_failed', 'stale_submitting', 'invalid_job', 'processing_failed', 'trading_paused', 'trade_mismatch', 'manual_rejected', 'reconciliation_not_found', 'reconciliation_ambiguous', 'broker_unavailable'));--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_last_error_check" CHECK ("outbox_events"."last_error" in ('expired', 'executor_not_configured', 'executor_timeout', 'executor_error', 'broker_rejected', 'publish_failed', 'stale_submitting', 'invalid_job', 'processing_failed', 'trading_paused', 'trade_mismatch', 'manual_rejected', 'reconciliation_not_found', 'reconciliation_ambiguous', 'broker_unavailable'));--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_check" CHECK ("audit_log"."action" in ('staff_created', 'staff_disabled', 'staff_password_reset', 'staff_login_failed', 'staff_login_locked', 'staff_login_password_ok', 'staff_login_telegram_failed', 'staff_login_telegram_confirmed', 'staff_login_denied', 'staff_login_code_failed', 'staff_login_completed', 'staff_sessions_viewed', 'staff_session_revoked', 'staff_logout', 'trading_stopped', 'trading_resumed'));