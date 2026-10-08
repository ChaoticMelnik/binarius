import * as z from 'zod';

// Lives here rather than in packages/db, like TokenLedgerKind: the admin audit page types a row and
// builds its filters from the values; packages/db builds the CHECKs from these same objects
// (schema/audit-log.ts).
export const AuditActorType = { User: 'user', System: 'system', Admin: 'admin' } as const;
export type AuditActorType = (typeof AuditActorType)[keyof typeof AuditActorType];
export const auditActorTypeSchema = z.enum(AuditActorType);

// Every action audit_log accepts. The CHECK is built from this object, so an action a writer
// invents is refused by the database rather than landing as a row nothing can query by. A new
// action ships with its own migration (the admin pages, #107 and its siblings, extend it the same
// way); packages/db builds the CHECK from this object (schema/audit-log.ts).
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
  // admin read pages (#107)
  OverviewViewed: 'overview_viewed',
  UsersViewed: 'users_viewed',
  UserViewed: 'user_viewed',
  // admin intents pages (#108)
  IntentsViewed: 'intents_viewed',
  IntentViewed: 'intent_viewed',
  // admin trading sessions page (#330)
  TradingSessionsViewed: 'trading_sessions_viewed',
  // admin token ledger page (#109)
  TokensViewed: 'tokens_viewed',
  // admin audit log page (#110)
  AuditLogViewed: 'audit_log_viewed',
  // staff self password change (#78)
  StaffPasswordChanged: 'staff_password_changed',
  StaffPasswordChangeFailed: 'staff_password_change_failed',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
export const auditActionSchema = z.enum(AuditAction);

// `entity_type` is deliberately free text — it names whatever the action touched, and the set
// grows with every feature — but the ones the writers use are spelled once here rather than at
// each of their call sites.
export const AuditEntityType = {
  Staff: 'staff',
  StaffLoginChallenge: 'staff_login_challenge',
  StaffSession: 'staff_session',
  TradingSwitch: 'trading_switch',
  BotText: 'bot_text',
  User: 'user',
  TradeIntent: 'trade_intent',
} as const;
export type AuditEntityType = (typeof AuditEntityType)[keyof typeof AuditEntityType];
export const auditEntityTypeSchema = z.enum(AuditEntityType);
