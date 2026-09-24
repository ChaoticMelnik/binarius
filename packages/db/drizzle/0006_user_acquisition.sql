ALTER TABLE "users" ADD COLUMN "acquisition_source" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "acquired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_acquisition_source_check" CHECK ("users"."acquisition_source" is null or "users"."acquisition_source" ~ '^[A-Za-z0-9_-]{1,64}$');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_acquisition_pair_check" CHECK (("users"."acquisition_source" is null) = ("users"."acquired_at" is null));