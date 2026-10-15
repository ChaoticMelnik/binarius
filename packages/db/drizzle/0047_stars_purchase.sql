CREATE TABLE "star_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"telegram_payment_charge_id" text NOT NULL,
	"provider_payment_charge_id" text,
	"package_code" text NOT NULL,
	"currency" text NOT NULL,
	"total_amount" integer NOT NULL,
	"tokens" bigint,
	"status" text NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "star_payments_id_user_key" UNIQUE("id","user_id"),
	CONSTRAINT "star_payments_charge_id_check" CHECK (char_length("star_payments"."telegram_payment_charge_id") between 1 and 255),
	CONSTRAINT "star_payments_total_amount_check" CHECK ("star_payments"."total_amount" > 0),
	CONSTRAINT "star_payments_tokens_check" CHECK ("star_payments"."tokens" is null or "star_payments"."tokens" > 0),
	CONSTRAINT "star_payments_status_check" CHECK ("star_payments"."status" in ('paid', 'held', 'refunded')),
	CONSTRAINT "star_payments_paid_check" CHECK ("star_payments"."status" <> 'paid' or ("star_payments"."tokens" is not null and "star_payments"."currency" = 'XTR')),
	CONSTRAINT "star_payments_refund_pair_check" CHECK (("star_payments"."status" = 'refunded') = ("star_payments"."refunded_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "token_ledger" DROP CONSTRAINT "token_ledger_reference_check";--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_check";--> statement-breakpoint
ALTER TABLE "token_ledger" ADD COLUMN "star_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "star_payments" ADD CONSTRAINT "star_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "star_payments_charge_key" ON "star_payments" USING btree ("telegram_payment_charge_id");--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_star_payment_owner_fk" FOREIGN KEY ("star_payment_id","user_id") REFERENCES "public"."star_payments"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "token_ledger_star_payment_idx" ON "token_ledger" USING btree ("star_payment_id","kind") WHERE "token_ledger"."star_payment_id" is not null;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_reference_check" CHECK (case
            when "token_ledger"."kind" in ('reserve', 'release', 'settle')
              then "token_ledger"."intent_id" is not null and "token_ledger"."deposit_event_id" is null
                and "token_ledger"."broker_account_id" is null and "token_ledger"."ref_id" is null
                and "token_ledger"."star_payment_id" is null
            when "token_ledger"."kind" = 'purchase'
              then "token_ledger"."intent_id" is null and "token_ledger"."broker_account_id" is null and "token_ledger"."ref_id" is null
                and ("token_ledger"."deposit_event_id" is not null) <> ("token_ledger"."star_payment_id" is not null)
            when "token_ledger"."kind" = 'bonus'
              then "token_ledger"."intent_id" is null and "token_ledger"."ref_id" is null and "token_ledger"."star_payment_id" is null
                and not ("token_ledger"."deposit_event_id" is not null and "token_ledger"."broker_account_id" is not null)
            else "token_ledger"."intent_id" is null and "token_ledger"."deposit_event_id" is null and "token_ledger"."broker_account_id" is null
              and "token_ledger"."star_payment_id" is null
          end);--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_check" CHECK ("audit_log"."action" in ('staff_created', 'staff_disabled', 'staff_password_reset', 'staff_login_failed', 'staff_login_locked', 'staff_login_password_ok', 'staff_login_telegram_failed', 'staff_login_telegram_confirmed', 'staff_login_denied', 'staff_login_code_failed', 'staff_login_completed', 'staff_sessions_viewed', 'staff_session_revoked', 'staff_logout', 'trading_stopped', 'trading_resumed', 'bot_text_saved', 'bot_text_reset', 'overview_viewed', 'users_viewed', 'user_viewed', 'intents_viewed', 'intent_viewed', 'trading_sessions_viewed', 'tokens_viewed', 'audit_log_viewed', 'staff_password_changed', 'staff_password_change_failed', 'bot_texts_viewed', 'bot_text_viewed', 'bot_text_previewed', 'bot_profile_published', 'deposits_viewed', 'broker_accounts_viewed', 'token_adjusted', 'staff_login_link_issued', 'staff_login_link_refused', 'staff_login_link_completed', 'trading_mode_changed', 'stars_purchased', 'stars_payment_held'));