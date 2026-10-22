ALTER TABLE "notification_jobs" DROP CONSTRAINT "notification_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "notification_kinds" DROP CONSTRAINT "notification_kinds_kind_check";--> statement-breakpoint
ALTER TABLE "deposit_events" ADD COLUMN "mode_switch" text;--> statement-breakpoint
ALTER TABLE "deposit_events" ADD COLUMN "mode_switch_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "deposit_events_mode_switch_pending_idx" ON "deposit_events" USING btree ("created_at") WHERE "deposit_events"."user_id" is not null and "deposit_events"."mode_switch" is null;--> statement-breakpoint
ALTER TABLE "deposit_events" ADD CONSTRAINT "deposit_events_mode_switch_check" CHECK ("deposit_events"."mode_switch" in ('switched', 'already_real', 'user_blocked', 'account_inactive', 'demo_only', 'superseded', 'predates'));--> statement-breakpoint
ALTER TABLE "deposit_events" ADD CONSTRAINT "deposit_events_mode_switch_pair_check" CHECK (("deposit_events"."mode_switch" is null) = ("deposit_events"."mode_switch_at" is null));--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_kind_check" CHECK ("notification_jobs"."kind" in ('first_session_1h', 'first_session_24h', 'first_session_72h', 'analysis_unused', 'referral_rewarded', 'tokens_half', 'tokens_low', 'tokens_out', 'real_mode_by_deposit'));--> statement-breakpoint
ALTER TABLE "notification_kinds" ADD CONSTRAINT "notification_kinds_kind_check" CHECK ("notification_kinds"."kind" in ('first_session_1h', 'first_session_24h', 'first_session_72h', 'analysis_unused', 'referral_rewarded', 'tokens_half', 'tokens_low', 'tokens_out', 'real_mode_by_deposit'));--> statement-breakpoint
-- Hand-written (#686, docs/trading-mode.md -> The automatic switch after a deposit): drizzle-kit
-- does not model data. The switch to real follows deposits from this moment on: every row already
-- there, attributed or not, is closed as predates, so neither the pass nor a later activation that
-- attaches an old row switches anyone for a deposit made before the feature.
UPDATE "deposit_events" SET "mode_switch" = 'predates', "mode_switch_at" = now() WHERE "mode_switch" IS NULL;
