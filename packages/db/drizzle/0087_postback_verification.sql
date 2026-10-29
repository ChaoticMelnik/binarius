ALTER TABLE "deposit_events" ADD COLUMN "verification" text;--> statement-breakpoint
ALTER TABLE "postback_deliveries" ADD COLUMN "secret_key_id" text;--> statement-breakpoint
ALTER TABLE "deposit_events" ADD CONSTRAINT "deposit_events_verification_check" CHECK ("deposit_events"."verification" in ('url_secret'));--> statement-breakpoint
ALTER TABLE "postback_deliveries" ADD CONSTRAINT "postback_deliveries_secret_key_id_check" CHECK ("postback_deliveries"."secret_key_id" ~ '^[0-9a-f]{8}$');--> statement-breakpoint
-- Hand-written (#142, docs/postbacks.md -> Authenticity): drizzle-kit does not model data. Until
-- here the only writer of deposit_events was recordPostback behind the URL secret (0044 started
-- from an empty table), so every row already there is authentic by the same mechanism.
UPDATE "deposit_events" SET "verification" = 'url_secret' WHERE "verification" IS NULL;
