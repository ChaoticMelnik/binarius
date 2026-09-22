-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model triggers.
-- token_ledger and audit_log are append-only; balances are caches of ledger sums, so a
-- silent UPDATE/DELETE would desynchronize them.
CREATE FUNCTION raise_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;--> statement-breakpoint
CREATE TRIGGER token_ledger_append_only
BEFORE UPDATE OR DELETE ON "token_ledger"
FOR EACH ROW EXECUTE FUNCTION raise_append_only();--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION raise_append_only();
