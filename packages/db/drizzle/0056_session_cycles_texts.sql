-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model data.
-- #552: a session's length is in cycles, so four session texts took {cycles} for {trades}
-- (docs/bot-texts.md -> Renamed placeholders); a saved override still holding {trades} is
-- rewritten. The two launch screens also take «перед каждой сделкой проверит» for «перед каждой
-- проверит», as their defaults did: «каждой» has no noun after «циклов». Both replacements are
-- one UPDATE, so a row gets both or neither. version, updated_at and updated_by_staff_id stay, as
-- in 0030. A row the longer text would push past bot_text_overrides_source_length_check is left as
-- it was; the readers then show the default and name the reason (bot-text list, the admin section).
UPDATE "bot_text_overrides" SET "source" = replace("source", '{trades}', '{cycles}') WHERE "key" = 'sessionStartButton' AND char_length(replace("source", '{trades}', '{cycles}')) <= 16384;--> statement-breakpoint
UPDATE "bot_text_overrides" SET "source" = replace("source", '{trades}', '{cycles}') WHERE "key" = 'intentSessionOffer' AND char_length(replace("source", '{trades}', '{cycles}')) <= 16384;--> statement-breakpoint
UPDATE "bot_text_overrides" SET "source" = replace(replace("source", '{trades}', '{cycles}'), 'перед каждой проверит', 'перед каждой сделкой проверит') WHERE "key" = 'launchCycle' AND char_length(replace(replace("source", '{trades}', '{cycles}'), 'перед каждой проверит', 'перед каждой сделкой проверит')) <= 16384;--> statement-breakpoint
UPDATE "bot_text_overrides" SET "source" = replace(replace("source", '{trades}', '{cycles}'), 'перед каждой проверит', 'перед каждой сделкой проверит') WHERE "key" = 'launchCycleReal' AND char_length(replace(replace("source", '{trades}', '{cycles}'), 'перед каждой проверит', 'перед каждой сделкой проверит')) <= 16384;
