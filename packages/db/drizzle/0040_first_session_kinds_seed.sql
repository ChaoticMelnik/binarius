-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model data.
-- #202: the first-session chain plans only for accounts connected from this moment on (owner,
-- 2026-10-10: no reminders for accounts connected before the engine's deploy). now() is the
-- database clock at migration time, the same clock token_ledger.created_at is written by, and
-- one statement gives the three steps one cutoff (docs/mailing.md -> Cutoff).
INSERT INTO "notification_kinds" ("kind", "plans_from") VALUES
  ('first_session_1h', now()),
  ('first_session_24h', now()),
  ('first_session_72h', now());
