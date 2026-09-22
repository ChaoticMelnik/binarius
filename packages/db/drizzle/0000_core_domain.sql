CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"display_name" text,
	"language_code" text,
	"status" text DEFAULT 'active' NOT NULL,
	"token_balance" bigint DEFAULT 0 NOT NULL,
	"token_reserved" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('active', 'blocked')),
	CONSTRAINT "users_token_balance_check" CHECK ("users"."token_balance" >= 0),
	CONSTRAINT "users_token_reserved_check" CHECK ("users"."token_reserved" >= 0 and "users"."token_reserved" <= "users"."token_balance")
);
--> statement-breakpoint
CREATE TABLE "broker_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"broker_user_id" text NOT NULL,
	"email" text,
	"is_partner_client" boolean DEFAULT false NOT NULL,
	"access_token_enc" "bytea" NOT NULL,
	"refresh_token_enc" "bytea" NOT NULL,
	"token_key_id" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"trading_halted" boolean DEFAULT false NOT NULL,
	"halted_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broker_accounts_id_user_id_key" UNIQUE("id","user_id"),
	CONSTRAINT "broker_accounts_status_check" CHECK ("broker_accounts"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"balance_delta" bigint DEFAULT 0 NOT NULL,
	"reserved_delta" bigint DEFAULT 0 NOT NULL,
	"intent_id" uuid,
	"deposit_event_id" uuid,
	"ref_type" text,
	"ref_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_ledger_kind_check" CHECK ("token_ledger"."kind" in ('purchase', 'bonus', 'reserve', 'release', 'settle', 'adjustment')),
	CONSTRAINT "token_ledger_ref_type_check" CHECK ("token_ledger"."ref_type" in ('manual')),
	CONSTRAINT "token_ledger_delta_check" CHECK ("token_ledger"."balance_delta" <> 0 or "token_ledger"."reserved_delta" <> 0),
	CONSTRAINT "token_ledger_ref_pair_check" CHECK (("token_ledger"."ref_type" is null) = ("token_ledger"."ref_id" is null)),
	CONSTRAINT "token_ledger_reference_check" CHECK (case
            when "token_ledger"."kind" in ('reserve', 'release', 'settle')
              then "token_ledger"."intent_id" is not null and "token_ledger"."deposit_event_id" is null and "token_ledger"."ref_id" is null
            when "token_ledger"."kind" = 'purchase'
              then "token_ledger"."deposit_event_id" is not null and "token_ledger"."intent_id" is null and "token_ledger"."ref_id" is null
            when "token_ledger"."kind" = 'bonus'
              then "token_ledger"."intent_id" is null and "token_ledger"."ref_id" is null
            else "token_ledger"."intent_id" is null and "token_ledger"."deposit_event_id" is null
          end),
	CONSTRAINT "token_ledger_delta_shape_check" CHECK (case "token_ledger"."kind"
            when 'reserve' then "token_ledger"."reserved_delta" > 0 and "token_ledger"."balance_delta" = 0
            when 'release' then "token_ledger"."reserved_delta" < 0 and "token_ledger"."balance_delta" = 0
            when 'settle' then "token_ledger"."reserved_delta" < 0
            when 'purchase' then "token_ledger"."balance_delta" > 0 and "token_ledger"."reserved_delta" = 0
            when 'bonus' then "token_ledger"."balance_delta" > 0 and "token_ledger"."reserved_delta" = 0
            else true
          end)
);
--> statement-breakpoint
CREATE TABLE "trading_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_account_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_sessions_id_account_mode_key" UNIQUE("id","broker_account_id","mode"),
	CONSTRAINT "trading_sessions_mode_check" CHECK ("trading_sessions"."mode" in ('demo', 'real')),
	CONSTRAINT "trading_sessions_status_check" CHECK ("trading_sessions"."status" in ('active', 'paused', 'stopped'))
);
--> statement-breakpoint
CREATE TABLE "trade_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"trading_session_id" uuid,
	"mode" text NOT NULL,
	"asset_id" integer NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"action" text NOT NULL,
	"duration_sec" integer NOT NULL,
	"client_request_id" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"tokens_reserved" bigint DEFAULT 0 NOT NULL,
	"transport" text,
	"submitted_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_intents_id_account_mode_key" UNIQUE("id","broker_account_id","mode"),
	CONSTRAINT "trade_intents_id_user_key" UNIQUE("id","user_id"),
	CONSTRAINT "trade_intents_mode_check" CHECK ("trade_intents"."mode" in ('demo', 'real')),
	CONSTRAINT "trade_intents_action_check" CHECK ("trade_intents"."action" in ('up', 'down')),
	CONSTRAINT "trade_intents_status_check" CHECK ("trade_intents"."status" in ('planned', 'reserved', 'queued', 'submitting', 'accepted', 'settled', 'rejected', 'unknown', 'reconciling', 'manual_review')),
	CONSTRAINT "trade_intents_transport_check" CHECK ("trade_intents"."transport" in ('socket', 'rest_fallback')),
	CONSTRAINT "trade_intents_asset_id_check" CHECK ("trade_intents"."asset_id" > 0),
	CONSTRAINT "trade_intents_amount_check" CHECK ("trade_intents"."amount" > 0 and "trade_intents"."amount" <> 'NaN'::numeric),
	CONSTRAINT "trade_intents_duration_sec_check" CHECK ("trade_intents"."duration_sec" > 0),
	CONSTRAINT "trade_intents_tokens_reserved_check" CHECK ("trade_intents"."tokens_reserved" >= 0)
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"topic" text DEFAULT 'trading-intents' NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_topic_intent_key" UNIQUE("topic","intent_id"),
	CONSTRAINT "outbox_events_topic_check" CHECK ("outbox_events"."topic" in ('trading-intents', 'trading-reconciliation')),
	CONSTRAINT "outbox_events_status_check" CHECK ("outbox_events"."status" in ('pending', 'published', 'failed')),
	CONSTRAINT "outbox_events_payload_check" CHECK (jsonb_typeof("outbox_events"."payload") = 'object'
          and "outbox_events"."payload" ? 'intent_id'
          and jsonb_typeof("outbox_events"."payload" -> 'intent_id') = 'string'
          and "outbox_events"."payload" ->> 'intent_id' = "outbox_events"."intent_id"::text)
);
--> statement-breakpoint
CREATE TABLE "broker_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_account_id" uuid NOT NULL,
	"intent_id" uuid,
	"broker_trade_id" text NOT NULL,
	"mode" text NOT NULL,
	"asset_id" integer NOT NULL,
	"action" text NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"payout" numeric(8, 4) NOT NULL,
	"open_price" double precision NOT NULL,
	"open_timestamp_ms" bigint NOT NULL,
	"close_price" double precision,
	"close_timestamp_ms" bigint,
	"potential_profit" numeric(20, 8),
	"profit" numeric(20, 8),
	"source" text,
	"broker_client_id" text,
	"status" text NOT NULL,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broker_trades_account_trade_key" UNIQUE("broker_account_id","broker_trade_id"),
	CONSTRAINT "broker_trades_intent_id_key" UNIQUE("intent_id"),
	CONSTRAINT "broker_trades_mode_check" CHECK ("broker_trades"."mode" in ('demo', 'real')),
	CONSTRAINT "broker_trades_action_check" CHECK ("broker_trades"."action" in ('up', 'down')),
	CONSTRAINT "broker_trades_status_check" CHECK ("broker_trades"."status" in ('open', 'closed')),
	CONSTRAINT "broker_trades_asset_id_check" CHECK ("broker_trades"."asset_id" > 0),
	CONSTRAINT "broker_trades_amount_check" CHECK ("broker_trades"."amount" > 0 and "broker_trades"."amount" <> 'NaN'::numeric),
	CONSTRAINT "broker_trades_potential_profit_check" CHECK ("broker_trades"."potential_profit" is null or ("broker_trades"."potential_profit" > 0 and "broker_trades"."potential_profit" <> 'NaN'::numeric)),
	CONSTRAINT "broker_trades_profit_check" CHECK ("broker_trades"."profit" is null or "broker_trades"."profit" <> 'NaN'::numeric),
	CONSTRAINT "broker_trades_payout_check" CHECK ("broker_trades"."payout" >= 0 and "broker_trades"."payout" <> 'NaN'::numeric),
	CONSTRAINT "broker_trades_open_price_check" CHECK ("broker_trades"."open_price" > 0 and "broker_trades"."open_price" < 'Infinity'::double precision),
	CONSTRAINT "broker_trades_close_price_check" CHECK ("broker_trades"."close_price" is null or ("broker_trades"."close_price" > 0 and "broker_trades"."close_price" < 'Infinity'::double precision)),
	CONSTRAINT "broker_trades_open_timestamp_check" CHECK ("broker_trades"."open_timestamp_ms" > 0),
	CONSTRAINT "broker_trades_close_timestamp_check" CHECK ("broker_trades"."close_timestamp_ms" is null or "broker_trades"."close_timestamp_ms" > 0),
	CONSTRAINT "broker_trades_settlement_check" CHECK (num_nonnulls("broker_trades"."close_timestamp_ms", "broker_trades"."close_price", "broker_trades"."profit") = case when "broker_trades"."status" = 'closed' then 3 else 0 end)
);
--> statement-breakpoint
CREATE TABLE "deposit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"broker_account_id" uuid,
	"postback_id" text NOT NULL,
	"payment_id" text,
	"amount" numeric(20, 8),
	"currency" text,
	"status" text DEFAULT 'received' NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_events_id_user_key" UNIQUE("id","user_id"),
	CONSTRAINT "deposit_events_owner_pair_check" CHECK ("deposit_events"."user_id" is null or "deposit_events"."broker_account_id" is not null),
	CONSTRAINT "deposit_events_amount_check" CHECK ("deposit_events"."amount" is null or ("deposit_events"."amount" > 0 and "deposit_events"."amount" <> 'NaN'::numeric)),
	CONSTRAINT "deposit_events_status_check" CHECK ("deposit_events"."status" in ('received', 'credited', 'ignored', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "bonus_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bonus_rules_validity_check" CHECK ("bonus_rules"."valid_from" is null or "bonus_rules"."valid_to" is null or "bonus_rules"."valid_to" > "bonus_rules"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "notification_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"dedupe_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_jobs_status_check" CHECK ("notification_jobs"."status" in ('pending', 'sent', 'failed', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor_type_check" CHECK ("audit_log"."actor_type" in ('user', 'system', 'admin'))
);
--> statement-breakpoint
ALTER TABLE "broker_accounts" ADD CONSTRAINT "broker_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_intent_owner_fk" FOREIGN KEY ("intent_id","user_id") REFERENCES "public"."trade_intents"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_deposit_owner_fk" FOREIGN KEY ("deposit_event_id","user_id") REFERENCES "public"."deposit_events"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_sessions" ADD CONSTRAINT "trading_sessions_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_trading_session_id_trading_sessions_id_fk" FOREIGN KEY ("trading_session_id") REFERENCES "public"."trading_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_account_owner_fk" FOREIGN KEY ("broker_account_id","user_id") REFERENCES "public"."broker_accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_session_account_fk" FOREIGN KEY ("trading_session_id","broker_account_id","mode") REFERENCES "public"."trading_sessions"("id","broker_account_id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_intent_id_trade_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."trade_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broker_trades" ADD CONSTRAINT "broker_trades_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broker_trades" ADD CONSTRAINT "broker_trades_intent_id_trade_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."trade_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broker_trades" ADD CONSTRAINT "broker_trades_intent_account_fk" FOREIGN KEY ("intent_id","broker_account_id","mode") REFERENCES "public"."trade_intents"("id","broker_account_id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_events" ADD CONSTRAINT "deposit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_events" ADD CONSTRAINT "deposit_events_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_events" ADD CONSTRAINT "deposit_events_account_owner_fk" FOREIGN KEY ("broker_account_id","user_id") REFERENCES "public"."broker_accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_telegram_user_id_idx" ON "users" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "broker_accounts_broker_user_id_idx" ON "broker_accounts" USING btree ("broker_user_id");--> statement-breakpoint
CREATE INDEX "broker_accounts_user_id_idx" ON "broker_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_hash_idx" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "token_ledger_reserve_intent_idx" ON "token_ledger" USING btree ("intent_id") WHERE "token_ledger"."kind" = 'reserve';--> statement-breakpoint
CREATE UNIQUE INDEX "token_ledger_terminal_intent_idx" ON "token_ledger" USING btree ("intent_id") WHERE "token_ledger"."kind" in ('release', 'settle');--> statement-breakpoint
CREATE UNIQUE INDEX "token_ledger_deposit_event_idx" ON "token_ledger" USING btree ("deposit_event_id","kind") WHERE "token_ledger"."deposit_event_id" is not null;--> statement-breakpoint
CREATE INDEX "token_ledger_user_created_idx" ON "token_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "token_ledger_intent_id_idx" ON "token_ledger" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "trading_sessions_account_status_idx" ON "trading_sessions" USING btree ("broker_account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "trade_intents_account_request_idx" ON "trade_intents" USING btree ("broker_account_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trade_intents_active_account_idx" ON "trade_intents" USING btree ("broker_account_id") WHERE "trade_intents"."status" not in ('settled', 'rejected');--> statement-breakpoint
CREATE INDEX "trade_intents_account_status_idx" ON "trade_intents" USING btree ("broker_account_id","status");--> statement-breakpoint
CREATE INDEX "trade_intents_status_updated_idx" ON "trade_intents" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "trade_intents_user_id_idx" ON "trade_intents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trade_intents_session_id_idx" ON "trade_intents" USING btree ("trading_session_id");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("available_at") WHERE "outbox_events"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "broker_trades_account_status_idx" ON "broker_trades" USING btree ("broker_account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_events_postback_id_idx" ON "deposit_events" USING btree ("postback_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_events_payment_id_idx" ON "deposit_events" USING btree ("payment_id") WHERE "deposit_events"."payment_id" is not null;--> statement-breakpoint
CREATE INDEX "deposit_events_user_id_idx" ON "deposit_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "deposit_events_broker_account_id_idx" ON "deposit_events" USING btree ("broker_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bonus_rules_code_idx" ON "bonus_rules" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_jobs_dedupe_key_idx" ON "notification_jobs" USING btree ("user_id","dedupe_key") WHERE "notification_jobs"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "notification_jobs_status_scheduled_idx" ON "notification_jobs" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "notification_jobs_user_id_idx" ON "notification_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");