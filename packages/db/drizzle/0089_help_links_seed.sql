-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model data.
-- #879: the help push plans only for connects from this moment on (docs/mailing.md -> Cutoff), as
-- the chain of #202: no wave of pushes over the whole base at the deploy. Without the row the kind
-- plans nothing. now() is the database clock at migration time.
INSERT INTO "notification_kinds" ("kind", "plans_from") VALUES ('help_links', now());
