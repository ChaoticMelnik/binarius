-- #141: hand-written lines. The guard: the new NOT NULL columns have no defaults and two columns
-- are dropped, so rows written by hand (no writer existed before #141) stop the migration loudly
-- instead of being guessed at. The unique on broker_accounts is moved ahead of the FK that
-- targets it (drizzle-kit emits it after).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "deposit_events") THEN
    RAISE EXCEPTION 'deposit_events must be empty before 0044_postbacks (#141): rows written by hand (the #341 check inserts postback_id ''pb-local%%'') - delete them, see docs/postbacks.md -> Migration';
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE "postback_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"postback_id" text,
	"event" text,
	"outcome" text NOT NULL,
	"reject_reason" text,
	"deposit_event_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "postback_deliveries_source_check" CHECK ("postback_deliveries"."source" in ('binodex')),
	CONSTRAINT "postback_deliveries_event_check" CHECK ("postback_deliveries"."event" in ('deposit', 'ftd')),
	CONSTRAINT "postback_deliveries_outcome_check" CHECK ("postback_deliveries"."outcome" in ('recorded', 'repeated', 'rejected')),
	CONSTRAINT "postback_deliveries_reject_reason_check" CHECK ("postback_deliveries"."reject_reason" in ('missing_postback_id', 'unknown_event', 'missing_payment_id', 'missing_trader_id', 'invalid_amount')),
	CONSTRAINT "postback_deliveries_outcome_shape_check" CHECK (case
        when "postback_deliveries"."outcome" = 'rejected'
          then "postback_deliveries"."deposit_event_id" is null and "postback_deliveries"."reject_reason" is not null
        else "postback_deliveries"."deposit_event_id" is not null and "postback_deliveries"."reject_reason" is null
          and "postback_deliveries"."postback_id" is not null and "postback_deliveries"."event" is not null
      end)
);
--> statement-breakpoint
ALTER TABLE "deposit_events" DROP CONSTRAINT "deposit_events_amount_check";--> statement-breakpoint
DROP INDEX "deposit_events_postback_id_idx";--> statement-breakpoint
DROP INDEX "deposit_events_payment_id_idx";--> statement-breakpoint
ALTER TABLE "deposit_events" ALTER COLUMN "payment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deposit_events" ALTER COLUMN "amount" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deposit_events" ADD COLUMN "source" text NOT NULL;--> statement-breakpoint
ALTER TABLE "deposit_events" ADD COLUMN "broker_user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "postback_deliveries" ADD CONSTRAINT "postback_deliveries_deposit_event_id_deposit_events_id_fk" FOREIGN KEY ("deposit_event_id") REFERENCES "public"."deposit_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "postback_deliveries_source_postback_idx" ON "postback_deliveries" USING btree ("source","postback_id") WHERE "postback_deliveries"."outcome" <> 'rejected';--> statement-breakpoint
CREATE INDEX "postback_deliveries_deposit_event_id_idx" ON "postback_deliveries" USING btree ("deposit_event_id");--> statement-breakpoint
CREATE INDEX "postback_deliveries_created_at_idx" ON "postback_deliveries" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "broker_accounts" ADD CONSTRAINT "broker_accounts_id_broker_user_id_key" UNIQUE("id","broker_user_id");--> statement-breakpoint
ALTER TABLE "deposit_events" ADD CONSTRAINT "deposit_events_account_trader_fk" FOREIGN KEY ("broker_account_id","broker_user_id") REFERENCES "public"."broker_accounts"("id","broker_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_events_source_payment_idx" ON "deposit_events" USING btree ("source","payment_id");--> statement-breakpoint
CREATE INDEX "deposit_events_broker_user_id_idx" ON "deposit_events" USING btree ("broker_user_id");--> statement-breakpoint
ALTER TABLE "deposit_events" DROP COLUMN "postback_id";--> statement-breakpoint
ALTER TABLE "deposit_events" DROP COLUMN "payload";--> statement-breakpoint
ALTER TABLE "deposit_events" ADD CONSTRAINT "deposit_events_source_check" CHECK ("deposit_events"."source" in ('binodex'));--> statement-breakpoint
ALTER TABLE "deposit_events" ADD CONSTRAINT "deposit_events_amount_check" CHECK ("deposit_events"."amount" > 0 and "deposit_events"."amount" <> 'NaN'::numeric);