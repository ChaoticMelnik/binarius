ALTER TABLE "notification_jobs" DROP CONSTRAINT "notification_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "notification_kinds" DROP CONSTRAINT "notification_kinds_kind_check";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_analysis_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_analysis_asset_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_analysis_duration_sec" integer;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_last_analysis_check" CHECK (("users"."last_analysis_at" is null and "users"."last_analysis_asset_id" is null
        and "users"."last_analysis_duration_sec" is null)
        or ("users"."last_analysis_at" is not null and "users"."last_analysis_asset_id" is not null
          and "users"."last_analysis_duration_sec" is not null and "users"."last_analysis_asset_id" > 0
          and "users"."last_analysis_duration_sec" > 0));--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_kind_check" CHECK ("notification_jobs"."kind" in ('first_session_1h', 'first_session_24h', 'first_session_72h', 'analysis_unused'));--> statement-breakpoint
ALTER TABLE "notification_kinds" ADD CONSTRAINT "notification_kinds_kind_check" CHECK ("notification_kinds"."kind" in ('first_session_1h', 'first_session_24h', 'first_session_72h', 'analysis_unused'));