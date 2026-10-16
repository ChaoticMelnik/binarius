-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model data.
-- #484: the analysis reminder plans only for analyses from this moment on. The fact
-- (users.last_analysis_at) is written only by a backend with this migration, so the cutoff is
-- formal; without the row the kind plans nothing (docs/mailing.md -> Cutoff). now() is the
-- database clock at migration time, the same clock setLastAnalysis writes by.
INSERT INTO "notification_kinds" ("kind", "plans_from") VALUES ('analysis_unused', now());
