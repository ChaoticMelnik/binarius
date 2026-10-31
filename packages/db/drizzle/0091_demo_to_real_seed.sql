-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model data.
-- #880: the demo-to-real chain plans only for users whose third demo session ends from this moment
-- on (docs/mailing.md -> Cutoff), as the chain of #202: no wave of pushes over the whole base at
-- the deploy. Without the rows the kinds plan nothing. now() is the database clock at migration
-- time, one moment for the three steps.
INSERT INTO "notification_kinds" ("kind", "plans_from") VALUES ('demo_to_real_1h', now()), ('demo_to_real_24h', now()), ('demo_to_real_72h', now());
