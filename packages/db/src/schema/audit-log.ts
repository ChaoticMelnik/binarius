import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, inList } from './columns';

export const AuditActorType = { User: 'user', System: 'system', Admin: 'admin' } as const;
export type AuditActorType = (typeof AuditActorType)[keyof typeof AuditActorType];

// Every action this table accepts. The CHECK is built from this object, so an action a writer
// invents is refused by the database rather than landing as a row nothing can query by. A new
// action ships with its own migration (#34 extends the list the same way).
//
// Names are snake_case and nothing else: sqlLiteralList inlines only [a-z0-9_-], so a dotted
// name would be refused at import rather than reaching the DDL.
export const AuditAction = {
  StaffCreated: 'staff_created',
  StaffDisabled: 'staff_disabled',
  StaffPasswordReset: 'staff_password_reset',
  StaffLoginFailed: 'staff_login_failed',
  StaffLoginLocked: 'staff_login_locked',
  StaffLoginPasswordOk: 'staff_login_password_ok',
  StaffLoginTelegramFailed: 'staff_login_telegram_failed',
  StaffLoginTelegramConfirmed: 'staff_login_telegram_confirmed',
  StaffLoginDenied: 'staff_login_denied',
  StaffLoginCodeFailed: 'staff_login_code_failed',
  StaffLoginCompleted: 'staff_login_completed',
  StaffSessionsViewed: 'staff_sessions_viewed',
  StaffSessionRevoked: 'staff_session_revoked',
  StaffLogout: 'staff_logout',
  // the kill-switch CLI (#144): trading_switch closed / opened
  TradingStopped: 'trading_stopped',
  TradingResumed: 'trading_resumed',
  // a client bot text overridden / reset to its default (#299)
  BotTextSaved: 'bot_text_saved',
  BotTextReset: 'bot_text_reset',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

// `entity_type` is deliberately free text — it names whatever the action touched, and the set
// grows with every feature — but the ones the writers use are spelled once here rather than at
// each of their call sites.
export const AuditEntityType = {
  Staff: 'staff',
  StaffLoginChallenge: 'staff_login_challenge',
  StaffSession: 'staff_session',
  TradingSwitch: 'trading_switch',
  BotText: 'bot_text',
} as const;
export type AuditEntityType = (typeof AuditEntityType)[keyof typeof AuditEntityType];

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
