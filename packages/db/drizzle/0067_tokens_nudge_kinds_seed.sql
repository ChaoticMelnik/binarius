-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model data.
-- #123: the low-token nudges are switched on at this moment. Their fact is the planning moment
-- itself, so plans_from only switches the kind on: a user already past several thresholds gets
-- one push, for the highest (docs/mailing.md -> The low-token nudge). Without the row the kind
-- plans nothing (docs/mailing.md -> Cutoff).
INSERT INTO "notification_kinds" ("kind", "plans_from") VALUES
  ('tokens_half', now()),
  ('tokens_low', now()),
  ('tokens_out', now());
