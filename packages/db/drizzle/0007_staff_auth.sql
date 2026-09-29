CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login" text NOT NULL,
	"password_hash" text NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"display_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"failed_password_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_login_check" CHECK ("staff"."login" ~ '^[A-Za-z0-9._-]{3,64}$'),
	CONSTRAINT "staff_password_hash_check" CHECK (left("staff"."password_hash", 8) = '$scrypt$'),
	CONSTRAINT "staff_status_check" CHECK ("staff"."status" in ('active', 'disabled')),
	CONSTRAINT "staff_failed_attempts_check" CHECK ("staff"."failed_password_attempts" >= 0),
	CONSTRAINT "staff_telegram_user_id_check" CHECK ("staff"."telegram_user_id" > 0)
);
--> statement-breakpoint
CREATE TABLE "staff_login_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"code_hash" text,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"ip" text NOT NULL,
	"user_agent" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"prompt_sent_at" timestamp with time zone,
	"code_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_login_challenges_status_check" CHECK ("staff_login_challenges"."status" in ('pending', 'confirmed', 'completed', 'denied', 'expired', 'exhausted', 'failed')),
	CONSTRAINT "staff_login_challenges_code_attempts_check" CHECK ("staff_login_challenges"."code_attempts" >= 0),
	CONSTRAINT "staff_login_challenges_expires_after_created_check" CHECK ("staff_login_challenges"."expires_at" > "staff_login_challenges"."created_at"),
	CONSTRAINT "staff_login_challenges_confirmed_pair_check" CHECK (("staff_login_challenges"."confirmed_at" is null) = ("staff_login_challenges"."code_hash" is null)),
	CONSTRAINT "staff_login_challenges_confirmed_after_created_check" CHECK ("staff_login_challenges"."confirmed_at" is null or "staff_login_challenges"."confirmed_at" >= "staff_login_challenges"."created_at"),
	CONSTRAINT "staff_login_challenges_code_status_check" CHECK (case
            when "staff_login_challenges"."status" = 'pending' then "staff_login_challenges"."code_hash" is null
            when "staff_login_challenges"."status" in ('confirmed', 'completed', 'exhausted') then "staff_login_challenges"."code_hash" is not null
            else true
          end),
	CONSTRAINT "staff_login_challenges_prompt_sent_check" CHECK ("staff_login_challenges"."prompt_sent_at" is null or "staff_login_challenges"."prompt_sent_at" >= "staff_login_challenges"."created_at"),
	CONSTRAINT "staff_login_challenges_code_sent_check" CHECK ("staff_login_challenges"."code_sent_at" is null or ("staff_login_challenges"."code_hash" is not null and "staff_login_challenges"."code_sent_at" >= "staff_login_challenges"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip" text NOT NULL,
	"user_agent" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_staff_id" uuid,
	CONSTRAINT "staff_sessions_expires_after_created_check" CHECK ("staff_sessions"."expires_at" > "staff_sessions"."created_at"),
	CONSTRAINT "staff_sessions_last_seen_after_created_check" CHECK ("staff_sessions"."last_seen_at" >= "staff_sessions"."created_at"),
	CONSTRAINT "staff_sessions_revoked_after_created_check" CHECK ("staff_sessions"."revoked_at" is null or "staff_sessions"."revoked_at" >= "staff_sessions"."created_at"),
	CONSTRAINT "staff_sessions_revoked_by_pair_check" CHECK ("staff_sessions"."revoked_by_staff_id" is null or "staff_sessions"."revoked_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "staff_login_challenges" ADD CONSTRAINT "staff_login_challenges_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_revoked_by_staff_id_staff_id_fk" FOREIGN KEY ("revoked_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_login_lower_idx" ON "staff" USING btree (lower("login"));--> statement-breakpoint
CREATE UNIQUE INDEX "staff_telegram_user_id_idx" ON "staff" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE INDEX "staff_login_challenges_staff_id_idx" ON "staff_login_challenges" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "staff_login_challenges_expires_at_idx" ON "staff_login_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_login_challenges_open_idx" ON "staff_login_challenges" USING btree ("staff_id") WHERE "staff_login_challenges"."status" in ('pending', 'confirmed');--> statement-breakpoint
CREATE UNIQUE INDEX "staff_sessions_token_hash_idx" ON "staff_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "staff_sessions_staff_id_idx" ON "staff_sessions" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "staff_sessions_expires_at_idx" ON "staff_sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_check" CHECK ("audit_log"."action" in ('staff_created', 'staff_disabled', 'staff_password_reset', 'staff_login_failed', 'staff_login_locked', 'staff_login_password_ok', 'staff_login_telegram_failed', 'staff_login_telegram_confirmed', 'staff_login_denied', 'staff_login_code_failed', 'staff_login_completed', 'staff_sessions_viewed', 'staff_session_revoked', 'staff_logout'));