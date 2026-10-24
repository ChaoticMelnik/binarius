-- #634: edited by hand - drizzle-kit 0.31.11 cannot name the old primary key, so it left the DROP
-- commented out and put the new key before the column it needs. The existing rows become 'ru'
-- through the column default.
ALTER TABLE "bot_text_overrides" ADD COLUMN "language" text DEFAULT 'ru' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_text_overrides" DROP CONSTRAINT "bot_text_overrides_pkey";--> statement-breakpoint
ALTER TABLE "bot_text_overrides" ADD CONSTRAINT "bot_text_overrides_pkey" PRIMARY KEY("language","key");--> statement-breakpoint
ALTER TABLE "bot_text_overrides" ADD CONSTRAINT "bot_text_overrides_language_check" CHECK ("bot_text_overrides"."language" in ('ru', 'en'));
