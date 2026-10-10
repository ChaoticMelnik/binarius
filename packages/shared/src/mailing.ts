// The kinds of notification_jobs (docs/mailing.md): the CHECK on the column is built from this
// constant, and every kind has one scenario in packages/db (mailing-scenarios.ts) and one message
// in the backend (apps/backend/src/mailing/messages.ts). Lives here, like UserStatus, so the
// backend's timing chain reads the offsets without the database package.
export const NotificationKind = {
  FirstSession1h: 'first_session_1h',
  FirstSession24h: 'first_session_24h',
  FirstSession72h: 'first_session_72h',
  TokensHalf: 'tokens_half',
  TokensLow: 'tokens_low',
  TokensOut: 'tokens_out',
} as const;
export type NotificationKind = (typeof NotificationKind)[keyof typeof NotificationKind];

// The first-session chain (#202, owner 2026-10-08): hours after the account was connected, while
// the user has started no trading session. In order: a step is sent only until the next one is due.
export const FIRST_SESSION_CHAIN = [
  { kind: NotificationKind.FirstSession1h, afterHours: 1 },
  { kind: NotificationKind.FirstSession24h, afterHours: 24 },
  { kind: NotificationKind.FirstSession72h, afterHours: 72 },
] as const satisfies readonly { kind: NotificationKind; afterHours: number }[];

// The low-token nudge (#123, owner 2026-10-08 and 2026-10-10): the share of the starter pack used,
// lowest first. A user gets one push for the highest threshold reached, never a lower one later.
export const TOKEN_NUDGES = [
  { kind: NotificationKind.TokensHalf, usedPercent: 50 },
  { kind: NotificationKind.TokensLow, usedPercent: 80 },
  { kind: NotificationKind.TokensOut, usedPercent: 100 },
] as const satisfies readonly { kind: NotificationKind; usedPercent: number }[];

// the first step of the chain: the planner's tick must be shorter, so no step is planned after the
// next one is due (the token nudges have no offset and are planned on the next tick)
export const MAILING_MIN_OFFSET_HOURS = Math.min(
  ...FIRST_SESSION_CHAIN.map((step) => step.afterHours),
);
