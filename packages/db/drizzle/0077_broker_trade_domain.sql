ALTER TABLE "broker_trades" DROP CONSTRAINT "broker_trades_potential_profit_check";--> statement-breakpoint
ALTER TABLE "broker_trades" DROP CONSTRAINT "broker_trades_payout_check";--> statement-breakpoint
ALTER TABLE "broker_trades" DROP CONSTRAINT "broker_trades_open_price_check";--> statement-breakpoint
ALTER TABLE "broker_trades" DROP CONSTRAINT "broker_trades_close_price_check";--> statement-breakpoint
ALTER TABLE "broker_trades" ALTER COLUMN "payout" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "broker_trades" ADD CONSTRAINT "broker_trades_potential_profit_check" CHECK ("broker_trades"."potential_profit" is null or ("broker_trades"."potential_profit" >= 0 and "broker_trades"."potential_profit" <> 'NaN'::numeric));--> statement-breakpoint
ALTER TABLE "broker_trades" ADD CONSTRAINT "broker_trades_payout_check" CHECK ("broker_trades"."payout" is null or ("broker_trades"."payout" >= 0 and "broker_trades"."payout" <> 'NaN'::numeric));--> statement-breakpoint
ALTER TABLE "broker_trades" ADD CONSTRAINT "broker_trades_open_price_check" CHECK ("broker_trades"."open_price" > '-Infinity'::double precision and "broker_trades"."open_price" < 'Infinity'::double precision);--> statement-breakpoint
ALTER TABLE "broker_trades" ADD CONSTRAINT "broker_trades_close_price_check" CHECK ("broker_trades"."close_price" is null or ("broker_trades"."close_price" > '-Infinity'::double precision and "broker_trades"."close_price" < 'Infinity'::double precision));