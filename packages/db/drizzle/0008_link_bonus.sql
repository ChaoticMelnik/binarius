ALTER TABLE "token_ledger" DROP CONSTRAINT "token_ledger_reference_check";--> statement-breakpoint
ALTER TABLE "token_ledger" ADD COLUMN "broker_account_id" uuid;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_account_owner_fk" FOREIGN KEY ("broker_account_id","user_id") REFERENCES "public"."broker_accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "token_ledger_link_bonus_user_idx" ON "token_ledger" USING btree ("user_id") WHERE "token_ledger"."kind" = 'bonus' and "token_ledger"."broker_account_id" is not null;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_reference_check" CHECK (case
            when "token_ledger"."kind" in ('reserve', 'release', 'settle')
              then "token_ledger"."intent_id" is not null and "token_ledger"."deposit_event_id" is null
                and "token_ledger"."broker_account_id" is null and "token_ledger"."ref_id" is null
            when "token_ledger"."kind" = 'purchase'
              then "token_ledger"."deposit_event_id" is not null and "token_ledger"."intent_id" is null
                and "token_ledger"."broker_account_id" is null and "token_ledger"."ref_id" is null
            when "token_ledger"."kind" = 'bonus'
              then "token_ledger"."intent_id" is null and "token_ledger"."ref_id" is null
                and not ("token_ledger"."deposit_event_id" is not null and "token_ledger"."broker_account_id" is not null)
            else "token_ledger"."intent_id" is null and "token_ledger"."deposit_event_id" is null and "token_ledger"."broker_account_id" is null
          end);