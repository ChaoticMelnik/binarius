CREATE SEQUENCE "public"."bot_text_override_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9007199254740991 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "bot_text_overrides" (
	"key" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"version" bigint DEFAULT nextval('bot_text_override_version_seq') NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_staff_id" uuid,
	CONSTRAINT "bot_text_overrides_key_check" CHECK ("bot_text_overrides"."key" ~ '^[a-z][a-zA-Z0-9]{0,63}$'),
	CONSTRAINT "bot_text_overrides_source_length_check" CHECK (char_length("bot_text_overrides"."source") between 1 and 16384)
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_check";--> statement-breakpoint
ALTER TABLE "bot_text_overrides" ADD CONSTRAINT "bot_text_overrides_updated_by_staff_id_staff_id_fk" FOREIGN KEY ("updated_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_check" CHECK ("audit_log"."action" in ('staff_created', 'staff_disabled', 'staff_password_reset', 'staff_login_failed', 'staff_login_locked', 'staff_login_password_ok', 'staff_login_telegram_failed', 'staff_login_telegram_confirmed', 'staff_login_denied', 'staff_login_code_failed', 'staff_login_completed', 'staff_sessions_viewed', 'staff_session_revoked', 'staff_logout', 'trading_stopped', 'trading_resumed', 'bot_text_saved', 'bot_text_reset'));