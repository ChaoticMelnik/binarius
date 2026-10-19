CREATE TABLE "signal_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context" text NOT NULL,
	"trading_session_id" uuid,
	"broker_account_id" uuid,
	"step" integer,
	"asset_id" integer NOT NULL,
	"interval" text,
	"version" text NOT NULL,
	"decided_at_ms" bigint NOT NULL,
	"taken_at_ms" bigint NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"action" text,
	"payout" numeric(8, 4),
	"digits" integer,
	"params" jsonb NOT NULL,
	"decision" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"series" jsonb NOT NULL,
	"last_tick" jsonb,
	"outcome" text NOT NULL,
	"detail" text,
	"result" jsonb,
	CONSTRAINT "signal_decisions_id_session_key" UNIQUE("id","trading_session_id"),
	CONSTRAINT "signal_decisions_context_check" CHECK ("signal_decisions"."context" in ('session', 'session_start', 'shadow')),
	CONSTRAINT "signal_decisions_session_pair_check" CHECK (("signal_decisions"."context" <> 'session' and "signal_decisions"."outcome" <> 'started') or "signal_decisions"."trading_session_id" is not null),
	CONSTRAINT "signal_decisions_account_pair_check" CHECK ("signal_decisions"."context" not in ('session', 'session_start') or "signal_decisions"."broker_account_id" is not null),
	CONSTRAINT "signal_decisions_step_check" CHECK ("signal_decisions"."step" > 0),
	CONSTRAINT "signal_decisions_step_pair_check" CHECK (("signal_decisions"."context" = 'session') = ("signal_decisions"."step" is not null)),
	CONSTRAINT "signal_decisions_asset_id_check" CHECK ("signal_decisions"."asset_id" > 0),
	CONSTRAINT "signal_decisions_interval_check" CHECK ("signal_decisions"."interval" in ('5s', '15s', '1m', '5m', '15m', '30m', '1h')),
	CONSTRAINT "signal_decisions_version_check" CHECK ("signal_decisions"."version" ~ '^[a-z0-9_-]{1,16}$'),
	CONSTRAINT "signal_decisions_decided_at_ms_check" CHECK ("signal_decisions"."decided_at_ms" > 0),
	CONSTRAINT "signal_decisions_taken_at_ms_check" CHECK ("signal_decisions"."taken_at_ms" > 0),
	CONSTRAINT "signal_decisions_kind_check" CHECK ("signal_decisions"."kind" in ('signal', 'no_signal')),
	CONSTRAINT "signal_decisions_action_check" CHECK ("signal_decisions"."action" in ('up', 'down')),
	CONSTRAINT "signal_decisions_action_pair_check" CHECK (("signal_decisions"."kind" = 'signal') = ("signal_decisions"."action" is not null)),
	CONSTRAINT "signal_decisions_payout_check" CHECK ("signal_decisions"."payout" >= 0 and "signal_decisions"."payout" <> 'NaN'::numeric),
	CONSTRAINT "signal_decisions_digits_check" CHECK ("signal_decisions"."digits" between 0 and 10),
	CONSTRAINT "signal_decisions_params_check" CHECK (jsonb_typeof("signal_decisions"."params") = 'object'),
	CONSTRAINT "signal_decisions_decision_check" CHECK (jsonb_typeof("signal_decisions"."decision") = 'object'),
	CONSTRAINT "signal_decisions_source_check" CHECK (jsonb_typeof("signal_decisions"."source") = 'object'),
	CONSTRAINT "signal_decisions_series_check" CHECK (jsonb_typeof("signal_decisions"."series") = 'array'),
	CONSTRAINT "signal_decisions_last_tick_check" CHECK (jsonb_typeof("signal_decisions"."last_tick") = 'object'),
	CONSTRAINT "signal_decisions_result_check" CHECK (jsonb_typeof("signal_decisions"."result") = 'object'),
	CONSTRAINT "signal_decisions_outcome_check" CHECK ("signal_decisions"."outcome" in ('intent', 'started', 'no_signal', 'paused', 'stake_stop', 'refused', 'replayed', 'shadow')),
	CONSTRAINT "signal_decisions_outcome_kind_check" CHECK (("signal_decisions"."kind" = 'no_signal') = ("signal_decisions"."outcome" = 'no_signal')),
	CONSTRAINT "signal_decisions_detail_check" CHECK ("signal_decisions"."detail" ~ '^[a-z0-9_]{1,64}$'),
	CONSTRAINT "signal_decisions_detail_pair_check" CHECK (("signal_decisions"."outcome" in ('refused', 'stake_stop')) = ("signal_decisions"."detail" is not null))
);
--> statement-breakpoint
ALTER TABLE "trading_sessions" ADD CONSTRAINT "trading_sessions_id_account_key" UNIQUE("id","broker_account_id");--> statement-breakpoint
ALTER TABLE "trade_intents" ADD COLUMN "signal_decision_id" uuid;--> statement-breakpoint
ALTER TABLE "signal_decisions" ADD CONSTRAINT "signal_decisions_trading_session_id_trading_sessions_id_fk" FOREIGN KEY ("trading_session_id") REFERENCES "public"."trading_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_decisions" ADD CONSTRAINT "signal_decisions_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_decisions" ADD CONSTRAINT "signal_decisions_session_account_fk" FOREIGN KEY ("trading_session_id","broker_account_id") REFERENCES "public"."trading_sessions"("id","broker_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_decisions_recorded_idx" ON "signal_decisions" USING btree ("recorded_at","id");--> statement-breakpoint
CREATE INDEX "signal_decisions_session_idx" ON "signal_decisions" USING btree ("trading_session_id","recorded_at");--> statement-breakpoint
ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_decision_session_fk" FOREIGN KEY ("signal_decision_id","trading_session_id") REFERENCES "public"."signal_decisions"("id","trading_session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trade_intents_decision_key" ON "trade_intents" USING btree ("signal_decision_id");