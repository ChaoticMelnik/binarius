-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model data.
-- #144: the one row of the global trading switch, open on a new database (owner's decision
-- 2026-10-07, docs/kill-switch.md -> Deploy). Without this row every reader takes trading as closed.
INSERT INTO "trading_switch" ("trading_enabled", "source", "reason") VALUES (true, 'migration', NULL);
