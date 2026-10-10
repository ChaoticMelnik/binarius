CREATE TABLE "staff_login_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "staff_login_links_status_check" CHECK ("staff_login_links"."status" in ('issued', 'used', 'superseded', 'revoked')),
	CONSTRAINT "staff_login_links_expires_after_created_check" CHECK ("staff_login_links"."expires_at" > "staff_login_links"."created_at"),
	CONSTRAINT "staff_login_links_used_pair_check" CHECK (("staff_login_links"."status" = 'used') = ("staff_login_links"."used_at" is not null)),
	CONSTRAINT "staff_login_links_used_after_created_check" CHECK ("staff_login_links"."used_at" is null or "staff_login_links"."used_at" >= "staff_login_links"."created_at")
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_check";--> statement-breakpoint
ALTER TABLE "staff_login_links" ADD CONSTRAINT "staff_login_links_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_login_links_token_hash_idx" ON "staff_login_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_login_links_live_idx" ON "staff_login_links" USING btree ("staff_id") WHERE "staff_login_links"."status" = 'issued';--> statement-breakpoint
CREATE INDEX "staff_login_links_staff_created_idx" ON "staff_login_links" USING btree ("staff_id","created_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_check" CHECK ("audit_log"."action" in ('staff_created', 'staff_disabled', 'staff_password_reset', 'staff_login_failed', 'staff_login_locked', 'staff_login_password_ok', 'staff_login_telegram_failed', 'staff_login_telegram_confirmed', 'staff_login_denied', 'staff_login_code_failed', 'staff_login_completed', 'staff_sessions_viewed', 'staff_session_revoked', 'staff_logout', 'trading_stopped', 'trading_resumed', 'bot_text_saved', 'bot_text_reset', 'overview_viewed', 'users_viewed', 'user_viewed', 'intents_viewed', 'intent_viewed', 'trading_sessions_viewed', 'tokens_viewed', 'audit_log_viewed', 'staff_password_changed', 'staff_password_change_failed', 'bot_texts_viewed', 'bot_text_viewed', 'bot_text_previewed', 'bot_profile_published', 'deposits_viewed', 'broker_accounts_viewed', 'token_adjusted', 'staff_login_link_issued', 'staff_login_link_refused', 'staff_login_link_completed'));