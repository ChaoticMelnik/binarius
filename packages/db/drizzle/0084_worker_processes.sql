CREATE TABLE "worker_processes" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "worker_processes_expiry_check" CHECK ("worker_processes"."expires_at" > "worker_processes"."heartbeat_at")
);
