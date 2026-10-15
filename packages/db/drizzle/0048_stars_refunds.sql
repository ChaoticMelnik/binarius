CREATE TABLE "star_refund_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"star_payment_id" uuid NOT NULL,
	"requested_by_telegram_user_id" bigint NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "star_refund_requests_requested_by_check" CHECK ("star_refund_requests"."requested_by_telegram_user_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "token_ledger" DROP CONSTRAINT "token_ledger_kind_check";--> statement-breakpoint
ALTER TABLE "token_ledger" DROP CONSTRAINT "token_ledger_reference_check";--> statement-breakpoint
ALTER TABLE "token_ledger" DROP CONSTRAINT "token_ledger_delta_shape_check";--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_check";--> statement-breakpoint
ALTER TABLE "star_payments" ADD COLUMN "payer_telegram_user_id" bigint;--> statement-breakpoint
-- Hand-written (#118): the payer of a payment recorded before 0048 is the actor of its one
-- stars_purchased / stars_payment_held audit row, which creditStarPayment wrote in the insert's
-- transaction. A row without one fails SET NOT NULL below and so the migration: never a NULL payer.
UPDATE "star_payments" SET "payer_telegram_user_id" = "audit_log"."actor_id"::bigint
  FROM "audit_log"
 WHERE "audit_log"."entity_type" = 'star_payment' AND "audit_log"."entity_id" = "star_payments"."id"
   AND "audit_log"."actor_type" = 'user'
   AND "audit_log"."action" IN ('stars_purchased', 'stars_payment_held');--> statement-breakpoint
ALTER TABLE "star_payments" ALTER COLUMN "payer_telegram_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "star_refund_requests" ADD CONSTRAINT "star_refund_requests_payment_fk" FOREIGN KEY ("star_payment_id") REFERENCES "public"."star_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "star_refund_requests_payment_key" ON "star_refund_requests" USING btree ("star_payment_id");--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_kind_check" CHECK ("token_ledger"."kind" in ('purchase', 'bonus', 'reserve', 'release', 'settle', 'adjustment', 'refund'));--> statement-breakpoint
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
            when "token_ledger"."kind" = 'refund'
              then "token_ledger"."star_payment_id" is not null and "token_ledger"."intent_id" is null
                and "token_ledger"."deposit_event_id" is null and "token_ledger"."broker_account_id" is null
                and "token_ledger"."ref_id" is null
            else "token_ledger"."intent_id" is null and "token_ledger"."deposit_event_id" is null and "token_ledger"."broker_account_id" is null
              and "token_ledger"."star_payment_id" is null
          end);--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_delta_shape_check" CHECK (case "token_ledger"."kind"
            when 'reserve' then "token_ledger"."reserved_delta" > 0 and "token_ledger"."balance_delta" = 0
            when 'release' then "token_ledger"."reserved_delta" < 0 and "token_ledger"."balance_delta" = 0
            when 'settle' then "token_ledger"."reserved_delta" < 0
            when 'purchase' then "token_ledger"."balance_delta" > 0 and "token_ledger"."reserved_delta" = 0
            when 'bonus' then "token_ledger"."balance_delta" > 0 and "token_ledger"."reserved_delta" = 0
            when 'refund' then "token_ledger"."balance_delta" < 0 and "token_ledger"."reserved_delta" = 0
            else true
          end);--> statement-breakpoint
ALTER TABLE "star_payments" ADD CONSTRAINT "star_payments_payer_check" CHECK ("star_payments"."payer_telegram_user_id" > 0);--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_check" CHECK ("audit_log"."action" in ('staff_created', 'staff_disabled', 'staff_password_reset', 'staff_login_failed', 'staff_login_locked', 'staff_login_password_ok', 'staff_login_telegram_failed', 'staff_login_telegram_confirmed', 'staff_login_denied', 'staff_login_code_failed', 'staff_login_completed', 'staff_sessions_viewed', 'staff_session_revoked', 'staff_logout', 'trading_stopped', 'trading_resumed', 'bot_text_saved', 'bot_text_reset', 'overview_viewed', 'users_viewed', 'user_viewed', 'intents_viewed', 'intent_viewed', 'trading_sessions_viewed', 'tokens_viewed', 'audit_log_viewed', 'staff_password_changed', 'staff_password_change_failed', 'bot_texts_viewed', 'bot_text_viewed', 'bot_text_previewed', 'bot_profile_published', 'deposits_viewed', 'broker_accounts_viewed', 'token_adjusted', 'staff_login_link_issued', 'staff_login_link_refused', 'staff_login_link_completed', 'trading_mode_changed', 'stars_purchased', 'stars_payment_held', 'stars_refunded', 'stars_refund_requested'));