-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model data.
-- #358: twelve placeholders of the bot texts catalog took the names of the variables registry
-- (docs/bot-texts.md -> Variables); a saved override still holding an old name is rewritten to the
-- new one, so it keeps showing the same text. version, updated_at and updated_by_staff_id stay: the
-- text means what it meant, and a form still open with the old name is refused by the validator.
-- A row the longer name would push past bot_text_overrides_source_length_check is left as it was;
-- the readers then show the default and name the reason (bot-text list, the admin section).
UPDATE "bot_text_overrides" SET "source" = replace("source", '{count}', '{tokens}') WHERE "key" = 'statusTokens' AND char_length(replace("source", '{count}', '{tokens}')) <= 16384;--> statement-breakpoint
UPDATE "bot_text_overrides" SET "source" = replace("source", '{count}', '{reservedTokens}') WHERE "key" = 'statusReserved' AND char_length(replace("source", '{count}', '{reservedTokens}')) <= 16384;--> statement-breakpoint
UPDATE "bot_text_overrides" SET "source" = replace("source", '{tokens}', '{bonusTokens}') WHERE "key" = 'cardBonusGranted' AND char_length(replace("source", '{tokens}', '{bonusTokens}')) <= 16384;--> statement-breakpoint
UPDATE "bot_text_overrides" SET "source" = replace("source", '{current}', '{level}') WHERE "key" = 'settings' AND char_length(replace("source", '{current}', '{level}')) <= 16384;--> statement-breakpoint
UPDATE "bot_text_overrides" SET "source" = replace("source", '{amount}', '{stake}') WHERE "key" = 'settingsStake' AND char_length(replace("source", '{amount}', '{stake}')) <= 16384;--> statement-breakpoint
UPDATE "bot_text_overrides" SET "source" = replace("source", '{amount}', '{stake}') WHERE "key" = 'stakeSaved' AND char_length(replace("source", '{amount}', '{stake}')) <= 16384;--> statement-breakpoint
UPDATE "bot_text_overrides" SET "source" = replace("source", '{amount}', '{minStake}') WHERE "key" = 'stakePickerMinimum' AND char_length(replace("source", '{amount}', '{minStake}')) <= 16384;--> statement-breakpoint
UPDATE "bot_text_overrides" SET "source" = replace("source", '{amount}', '{minStake}') WHERE "key" = 'stakeBelowMinimum' AND char_length(replace("source", '{amount}', '{minStake}')) <= 16384;--> statement-breakpoint
UPDATE "bot_text_overrides" SET "source" = replace("source", '{amount}', '{demoAvailable}') WHERE "key" = 'stakePickerAvailable' AND char_length(replace("source", '{amount}', '{demoAvailable}')) <= 16384;--> statement-breakpoint
UPDATE "bot_text_overrides" SET "source" = replace("source", '{amount}', '{demoAvailable}') WHERE "key" = 'stakeAboveAvailableAmount' AND char_length(replace("source", '{amount}', '{demoAvailable}')) <= 16384;--> statement-breakpoint
UPDATE "bot_text_overrides" SET "source" = replace("source", '{amount}', '{stake}') WHERE "key" = 'launchStake' AND char_length(replace("source", '{amount}', '{stake}')) <= 16384;--> statement-breakpoint
UPDATE "bot_text_overrides" SET "source" = replace("source", '{amount}', '{stake}') WHERE "key" = 'stakeSavedLine' AND char_length(replace("source", '{amount}', '{stake}')) <= 16384;
