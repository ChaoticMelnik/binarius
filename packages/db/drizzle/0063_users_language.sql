ALTER TABLE "users" ADD COLUMN "language" text DEFAULT 'ru' NOT NULL;--> statement-breakpoint
-- #508: an existing user gets the language a first /start gives today, from the language_code on
-- file: Russian for no tag or a Russian one, English for any other (botLanguageOf in
-- packages/shared/src/bot-language.ts; users-language-migration.db.test.ts compares the two on
-- one corpus). Before the CHECK, so the CHECK validates the written rows.
UPDATE "users" SET "language" = CASE WHEN "language_code" IS NULL OR "language_code" ~* '^ru(-|$)' THEN 'ru' ELSE 'en' END;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_language_check" CHECK ("users"."language" in ('ru', 'en'));
