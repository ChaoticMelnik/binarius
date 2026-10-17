-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model data.
-- #576: the inviter's reward notification plans only for rewards from this moment on; rewards
-- granted before it stay visible in /invite only. Without the row the kind plans nothing
-- (docs/mailing.md -> Cutoff). now() is the database clock at migration time, the same clock the
-- reward's ledger row (grantReferralReward) is written by.
INSERT INTO "notification_kinds" ("kind", "plans_from") VALUES ('referral_rewarded', now());
