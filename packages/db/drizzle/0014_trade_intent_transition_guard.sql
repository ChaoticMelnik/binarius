-- Custom migration (drizzle-kit generate --custom): drizzle-kit does not model triggers.
-- #17: the trade intent graph and the version bump, enforced by the database. The pairs below
-- are a copy of TRADE_INTENT_TRANSITIONS (packages/shared/src/trading.ts); the transition grid
-- in packages/db/src/schema.db.test.ts tries every ordered pair of statuses and fails when the
-- two disagree, so a graph change is a new migration that replaces this function.
-- An UPDATE that leaves the status as it is passes: it is not a transition. The CAS predicate
-- (status = from, version = expected) stays in each writer's WHERE; this checks only the edge
-- and that the version moved by exactly one.
CREATE FUNCTION trade_intents_guard_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status, NEW.status) NOT IN (
    ('planned', 'reserved'), ('planned', 'rejected'),
    ('reserved', 'queued'), ('reserved', 'rejected'),
    ('queued', 'submitting'), ('queued', 'rejected'),
    ('submitting', 'accepted'), ('submitting', 'rejected'), ('submitting', 'unknown'),
    ('accepted', 'settled'),
    ('unknown', 'reconciling'),
    ('reconciling', 'accepted'), ('reconciling', 'rejected'), ('reconciling', 'manual_review'),
    ('manual_review', 'settled'), ('manual_review', 'rejected')
  ) THEN
    RAISE EXCEPTION 'illegal trade intent transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'P0001', CONSTRAINT = 'trade_intents_transition_guard';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'trade intent status change % -> % must bump version by one', OLD.status, NEW.status
      USING ERRCODE = 'P0001', CONSTRAINT = 'trade_intents_transition_guard';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER trade_intents_transition_guard
BEFORE UPDATE OF status ON "trade_intents"
FOR EACH ROW EXECUTE FUNCTION trade_intents_guard_transition();
