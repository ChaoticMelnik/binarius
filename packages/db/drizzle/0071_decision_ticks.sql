CREATE TABLE "decision_ticks" (
	"decision_id" uuid PRIMARY KEY NOT NULL,
	"from_ms" bigint NOT NULL,
	"until_ms" bigint NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"count" integer NOT NULL,
	"ticks" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_ticks_from_ms_check" CHECK ("decision_ticks"."from_ms" > 0),
	CONSTRAINT "decision_ticks_window_check" CHECK ("decision_ticks"."until_ms" >= "decision_ticks"."from_ms"),
	CONSTRAINT "decision_ticks_status_check" CHECK ("decision_ticks"."status" in ('complete', 'truncated', 'unavailable')),
	CONSTRAINT "decision_ticks_detail_check" CHECK ("decision_ticks"."detail" in ('uncovered', 'hole', 'max_wait', 'quiet')),
	CONSTRAINT "decision_ticks_detail_pair_check" CHECK (("decision_ticks"."status" = 'complete') = ("decision_ticks"."detail" is null)),
	CONSTRAINT "decision_ticks_count_check" CHECK ("decision_ticks"."count" >= 0),
	CONSTRAINT "decision_ticks_count_pair_check" CHECK (("decision_ticks"."status" = 'unavailable') = ("decision_ticks"."count" = 0)),
	CONSTRAINT "decision_ticks_ticks_check" CHECK (case when jsonb_typeof("decision_ticks"."ticks") = 'array' then jsonb_array_length("decision_ticks"."ticks") = "decision_ticks"."count" else false end)
);
--> statement-breakpoint
ALTER TABLE "decision_ticks" ADD CONSTRAINT "decision_ticks_decision_id_signal_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."signal_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_decisions_shadow_recorded_idx" ON "signal_decisions" USING btree ("recorded_at") WHERE "signal_decisions"."context" = 'shadow';