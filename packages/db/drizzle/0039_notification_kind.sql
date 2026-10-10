CREATE TABLE "notification_kinds" (
	"kind" text PRIMARY KEY NOT NULL,
	"plans_from" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_kinds_kind_check" CHECK ("notification_kinds"."kind" in ('first_session_1h', 'first_session_24h', 'first_session_72h'))
);
--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_kind_check" CHECK ("notification_jobs"."kind" in ('first_session_1h', 'first_session_24h', 'first_session_72h'));