CREATE TABLE "broker_session_leases" (
	"broker_account_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "broker_session_leases_expiry_check" CHECK ("broker_session_leases"."expires_at" > "broker_session_leases"."acquired_at")
);
--> statement-breakpoint
ALTER TABLE "broker_session_leases" ADD CONSTRAINT "broker_session_leases_account_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE restrict ON UPDATE no action;