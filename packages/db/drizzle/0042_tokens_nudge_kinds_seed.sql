-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model data.
-- #123: the low-token nudge's kinds. Their fact is the planning moment, not a past event, so
-- plans_from only switches them on: a user already past a threshold when this runs gets one push,
-- for the highest threshold reached (owner, 2026-10-10; docs/mailing.md -> The low-token nudge).
INSERT INTO "notification_kinds" ("kind", "plans_from") VALUES
  ('tokens_half', now()),
  ('tokens_low', now()),
  ('tokens_out', now());
