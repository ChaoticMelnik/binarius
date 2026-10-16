import * as z from 'zod';
import { createTradeIntentRequestSchema } from './trading';

// The kinds of notification_jobs (docs/mailing.md): the CHECK on the column is built from this
// constant, and every kind has one scenario in packages/db (mailing-scenarios.ts) and one message
// in the backend (apps/backend/src/mailing/messages.ts). Lives here, like UserStatus, so the
// backend's timing chain reads the offsets without the database package.
export const NotificationKind = {
  FirstSession1h: 'first_session_1h',
  FirstSession24h: 'first_session_24h',
  FirstSession72h: 'first_session_72h',
  AnalysisUnused: 'analysis_unused',
} as const;
export type NotificationKind = (typeof NotificationKind)[keyof typeof NotificationKind];

// The first-session chain (#202, owner 2026-10-08): hours after the account was connected, while
// the user has started no trading session. In order: a step is sent only until the next one is due.
export const FIRST_SESSION_CHAIN = [
  { kind: NotificationKind.FirstSession1h, afterHours: 1 },
  { kind: NotificationKind.FirstSession24h, afterHours: 24 },
  { kind: NotificationKind.FirstSession72h, afterHours: 72 },
] as const satisfies readonly { kind: NotificationKind; afterHours: number }[];

// The analysis reminder (#484, docs/mailing.md → The analysis reminder): a demo user shown an
// analysis card with a signal who has started no trade or session and opened no other analysis
// within AFTER gets one reminder, and none once UNTIL has passed since the analysis.
export const ANALYSIS_UNUSED_AFTER_MS = 600_000;
export const ANALYSIS_UNUSED_UNTIL_MS = 3_600_000;

// The job's payload: the pair and duration of the analysis, for the «📊 Новый анализ» button.
export const analysisUnusedPayloadSchema = z.object({
  assetId: createTradeIntentRequestSchema.shape.assetId,
  durationSec: createTradeIntentRequestSchema.shape.durationSec,
});
export type AnalysisUnusedPayload = z.infer<typeof analysisUnusedPayloadSchema>;

// the earliest a scenario plans anything after its fact; the planner's tick must be shorter
export const MAILING_MIN_OFFSET_MS = Math.min(
  ...FIRST_SESSION_CHAIN.map((step) => step.afterHours * 3_600_000),
  ANALYSIS_UNUSED_AFTER_MS,
);
