-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model data.
-- #686: the real-mode notification plans only for switches from this moment on (docs/mailing.md
-- -> Cutoff); 0075 closed every earlier deposit as predates, so there is none before it anyway.
-- Without the row the kind plans nothing. now() is the database clock at migration time, the same
-- clock the switch's mode_switch_at is written by.
INSERT INTO "notification_kinds" ("kind", "plans_from") VALUES ('real_mode_by_deposit', now());
