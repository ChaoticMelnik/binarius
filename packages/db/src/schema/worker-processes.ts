import { sql } from 'drizzle-orm';
import { check, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

// The live trading-worker processes (#94, docs/worker-capacity.md → The registry). One row per
// process start; the live set is the rows whose expiry is still ahead by the database clock.
// Written only by worker-process-ops.ts, each operation one autocommit statement outside the
// users → broker_accounts → trading_sessions → trade_intents lock chain.
export const workerProcesses = pgTable(
  'worker_processes',
  {
    // the same uuid as broker_session_leases.owner_id of this process
    ownerId: uuid('owner_id').primaryKey(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [check('worker_processes_expiry_check', sql`${t.expiresAt} > ${t.heartbeatAt}`)],
);

export type WorkerProcessRow = typeof workerProcesses.$inferSelect;
