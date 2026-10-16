ALTER TABLE "token_ledger" DROP CONSTRAINT "token_ledger_reference_check";--> statement-breakpoint
ALTER TABLE "token_ledger" DROP CONSTRAINT "token_ledger_bonus_rule_check";--> statement-breakpoint
ALTER TABLE "token_ledger" ADD COLUMN "referral_id" uuid;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_id_inviter_key" UNIQUE("id","inviter_user_id");--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_referral_inviter_fk" FOREIGN KEY ("referral_id","user_id") REFERENCES "public"."referrals"("id","inviter_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "token_ledger_referral_idx" ON "token_ledger" USING btree ("referral_id") WHERE "token_ledger"."referral_id" is not null;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_reference_check" CHECK (case
            when "token_ledger"."kind" in ('reserve', 'release', 'settle')
              then "token_ledger"."intent_id" is not null and "token_ledger"."deposit_event_id" is null
                and "token_ledger"."broker_account_id" is null and "token_ledger"."ref_id" is null
                and "token_ledger"."star_payment_id" is null and "token_ledger"."referral_id" is null
            when "token_ledger"."kind" = 'purchase'
              then "token_ledger"."intent_id" is null and "token_ledger"."broker_account_id" is null and "token_ledger"."ref_id" is null
                and "token_ledger"."referral_id" is null
                and ("token_ledger"."deposit_event_id" is not null) <> ("token_ledger"."star_payment_id" is not null)
            when "token_ledger"."kind" = 'bonus'
              then "token_ledger"."intent_id" is null and "token_ledger"."ref_id" is null and "token_ledger"."star_payment_id" is null
                and num_nonnulls("token_ledger"."deposit_event_id", "token_ledger"."broker_account_id", "token_ledger"."referral_id") <= 1
            when "token_ledger"."kind" = 'refund'
              then "token_ledger"."star_payment_id" is not null and "token_ledger"."intent_id" is null
                and "token_ledger"."deposit_event_id" is null and "token_ledger"."broker_account_id" is null
                and "token_ledger"."ref_id" is null and "token_ledger"."referral_id" is null
            else "token_ledger"."intent_id" is null and "token_ledger"."deposit_event_id" is null and "token_ledger"."broker_account_id" is null
              and "token_ledger"."star_payment_id" is null and "token_ledger"."referral_id" is null
          end);--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_bonus_rule_check" CHECK (case
            when "token_ledger"."kind" = 'bonus'
              then "token_ledger"."bonus_rule_id" is not null and "token_ledger"."bonus_rule_kind" is not null
                and case
                  when "token_ledger"."broker_account_id" is not null
                    then "token_ledger"."bonus_rule_kind" = 'link_bonus'
                  when "token_ledger"."deposit_event_id" is not null
                    then "token_ledger"."bonus_rule_kind" = 'deposit_bonus'
                  when "token_ledger"."referral_id" is not null
                    then "token_ledger"."bonus_rule_kind" = 'referral_reward'
                  else false
                end
            else "token_ledger"."bonus_rule_id" is null and "token_ledger"."bonus_rule_kind" is null
          end);