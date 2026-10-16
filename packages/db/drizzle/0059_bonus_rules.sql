-- Hand-written (#13): the statements below are arranged by hand. drizzle-kit emits the ledger's
-- CHECK and FK at the end; they must come after the backfill of the existing starter packs.
-- Guards first: nothing in the code has written bonus_rules, so a row there was inserted by hand
-- and is not guessed into a version; and every bonus the ledger holds is a starter pack (the only
-- bonus writer before #13 was grantLinkBonus), so a bonus without a broker account is not either.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bonus_rules") THEN
    RAISE EXCEPTION 'migration 0059: bonus_rules is not empty; its rows have no version and are not guessed into one (docs/bonus-rules.md -> Deploy)';
  END IF;
  IF EXISTS (SELECT 1 FROM "token_ledger" WHERE "kind" = 'bonus' AND "broker_account_id" IS NULL) THEN
    RAISE EXCEPTION 'migration 0059: a bonus row names no broker account; only starter packs are backfilled to link_bonus v1';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_check";--> statement-breakpoint
DROP INDEX "bonus_rules_code_idx";--> statement-breakpoint
ALTER TABLE "bonus_rules" ALTER COLUMN "is_active" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "bonus_rules" ADD COLUMN "version" integer NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bonus_rules_code_version_key" ON "bonus_rules" USING btree ("code","version");--> statement-breakpoint
CREATE UNIQUE INDEX "bonus_rules_active_code_idx" ON "bonus_rules" USING btree ("code") WHERE "bonus_rules"."is_active";--> statement-breakpoint
ALTER TABLE "bonus_rules" ADD CONSTRAINT "bonus_rules_id_kind_key" UNIQUE("id","kind");--> statement-breakpoint
ALTER TABLE "bonus_rules" ADD CONSTRAINT "bonus_rules_version_check" CHECK ("bonus_rules"."version" >= 1);--> statement-breakpoint
ALTER TABLE "bonus_rules" ADD CONSTRAINT "bonus_rules_kind_check" CHECK ("bonus_rules"."kind" in ('link_bonus', 'referral_reward', 'deposit_bonus'));--> statement-breakpoint
-- Hand-written (#13): a rule is never edited, it is superseded by a new version. Only is_active,
-- valid_from, valid_to and updated_at may change; a no-op assignment of the others passes.
CREATE FUNCTION raise_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;--> statement-breakpoint
CREATE TRIGGER bonus_rules_immutable
BEFORE UPDATE ON "bonus_rules"
FOR EACH ROW
WHEN ((old.id, old.code, old.version, old.kind, old.priority, old.params, old.created_at)
  IS DISTINCT FROM (new.id, new.code, new.version, new.kind, new.priority, new.params, new.created_at))
EXECUTE FUNCTION raise_immutable();--> statement-breakpoint
CREATE TRIGGER bonus_rules_no_delete
BEFORE DELETE ON "bonus_rules"
FOR EACH ROW EXECUTE FUNCTION raise_immutable();--> statement-breakpoint
CREATE TRIGGER bonus_rules_no_truncate
BEFORE TRUNCATE ON "bonus_rules"
FOR EACH STATEMENT EXECUTE FUNCTION raise_immutable();--> statement-breakpoint
-- Hand-written (#13): the versions the hard-coded amounts become (owner, 2026-10-08). No
-- deposit_bonus version: the owner creates one with the CLI (docs/bonus-rules.md).
INSERT INTO "bonus_rules" ("code", "version", "kind", "is_active", "params") VALUES
  ('link_bonus', 1, 'link_bonus', true, '{"tokens": "100"}'::jsonb),
  ('referral_reward', 1, 'referral_reward', true, '{"tokens": "50"}'::jsonb);--> statement-breakpoint
ALTER TABLE "token_ledger" ADD COLUMN "bonus_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD COLUMN "bonus_rule_kind" text;--> statement-breakpoint
-- Hand-written (#13): the one sanctioned bypass of token_ledger_append_only (Architecture Rules,
-- Rule 3). The starter packs credited before 0059 were 100 tokens under the hard-coded constant
-- that link_bonus v1 now holds; they are bound to it so the CHECK below can require a rule on every
-- bonus. The migrator runs every pending migration in one transaction, so a failure anywhere
-- leaves the trigger enabled and nothing written; the trigger is enabled again before the
-- transaction ends either way.
ALTER TABLE "token_ledger" DISABLE TRIGGER "token_ledger_append_only";--> statement-breakpoint
UPDATE "token_ledger" SET "bonus_rule_id" = "bonus_rules"."id", "bonus_rule_kind" = 'link_bonus'
  FROM "bonus_rules"
 WHERE "bonus_rules"."code" = 'link_bonus' AND "bonus_rules"."version" = 1
   AND "token_ledger"."kind" = 'bonus' AND "token_ledger"."broker_account_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "token_ledger" ENABLE TRIGGER "token_ledger_append_only";--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_bonus_rule_fk" FOREIGN KEY ("bonus_rule_id","bonus_rule_kind") REFERENCES "public"."bonus_rules"("id","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_bonus_rule_check" CHECK (case
            when "token_ledger"."kind" = 'bonus'
              then "token_ledger"."bonus_rule_id" is not null and "token_ledger"."bonus_rule_kind" is not null
                and case
                  when "token_ledger"."broker_account_id" is not null
                    then "token_ledger"."bonus_rule_kind" = 'link_bonus'
                  when "token_ledger"."deposit_event_id" is not null
                    then "token_ledger"."bonus_rule_kind" = 'deposit_bonus'
                  else false
                end
            else "token_ledger"."bonus_rule_id" is null and "token_ledger"."bonus_rule_kind" is null
          end);--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_check" CHECK ("audit_log"."action" in ('staff_created', 'staff_disabled', 'staff_password_reset', 'staff_login_failed', 'staff_login_locked', 'staff_login_password_ok', 'staff_login_telegram_failed', 'staff_login_telegram_confirmed', 'staff_login_denied', 'staff_login_code_failed', 'staff_login_completed', 'staff_sessions_viewed', 'staff_session_revoked', 'staff_logout', 'trading_stopped', 'trading_resumed', 'bot_text_saved', 'bot_text_reset', 'overview_viewed', 'users_viewed', 'user_viewed', 'intents_viewed', 'intent_viewed', 'trading_sessions_viewed', 'tokens_viewed', 'audit_log_viewed', 'staff_password_changed', 'staff_password_change_failed', 'bot_texts_viewed', 'bot_text_viewed', 'bot_text_previewed', 'bot_profile_published', 'deposits_viewed', 'broker_accounts_viewed', 'token_adjusted', 'staff_login_link_issued', 'staff_login_link_refused', 'staff_login_link_completed', 'trading_mode_changed', 'stars_purchased', 'stars_payment_held', 'stars_refunded', 'stars_refund_requested', 'service_accounts_viewed', 'broker_account_service_set', 'broker_account_service_cleared', 'bonus_rule_version_created', 'bonus_rule_activated', 'bonus_rule_deactivated'));
