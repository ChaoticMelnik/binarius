CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_expires_after_created_check" CHECK ("oauth_states"."expires_at" > "oauth_states"."created_at"),
	CONSTRAINT "oauth_states_used_after_created_check" CHECK ("oauth_states"."used_at" is null or "oauth_states"."used_at" >= "oauth_states"."created_at")
);
--> statement-breakpoint
ALTER TABLE "broker_accounts" ADD COLUMN "refresh_token_hash" text;--> statement-breakpoint
ALTER TABLE "broker_accounts" ADD COLUMN "token_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broker_accounts" ADD COLUMN "auth_revoked_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_states_state_hash_idx" ON "oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "broker_accounts" ADD CONSTRAINT "broker_accounts_auth_revoked_reason_check" CHECK ("broker_accounts"."auth_revoked_reason" in ('refresh_invalid_grant', 'refresh_outcome_unknown', 'refresh_expired', 'storage_inconsistent'));