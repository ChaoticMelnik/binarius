import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { AuditAction, AuditActorType } from '@binarius/shared';
import { createdAt, id, inList } from './columns';

// append-only (trigger in drizzle/0001_append_only.sql)
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actorType: text('actor_type').$type<AuditActorType>().notNull(),
    actorId: text('actor_id'),
    action: text('action').$type<AuditAction>().notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
    index('audit_log_created_at_idx').on(t.createdAt),
    inList('audit_log_actor_type_check', t.actorType, AuditActorType),
    inList('audit_log_action_check', t.action, AuditAction),
  ],
);
