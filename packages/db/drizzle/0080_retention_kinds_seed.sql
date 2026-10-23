-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model data.
-- #124: the retention kinds plan only for facts from this moment on (docs/mailing.md -> Cutoff;
-- manager 2026-10-23, answer 2 (a)), as the chain of #202: no wave of pushes over the whole base at
-- the deploy, and the first weekly summary on the first Monday after it. Without the row a kind
-- plans nothing. now() is the database clock at migration time.
INSERT INTO "notification_kinds" ("kind", "plans_from") VALUES
  ('inactive_3d', now()),
  ('session_idle_24h', now()),
  ('weekly_summary', now()),
  ('tokens_out_2d', now());
