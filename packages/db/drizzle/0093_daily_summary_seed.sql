-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model data.
-- #881: the daily summary plans only from the first DAILY_SUMMARY_HOUR in DAILY_SUMMARY_TIME_ZONE
-- after this moment (docs/mailing.md -> Cutoff): the anchor of an earlier day lies before it. Without
-- the row the kind plans nothing. now() is the database clock at migration time.
INSERT INTO "notification_kinds" ("kind", "plans_from") VALUES ('daily_summary', now());
