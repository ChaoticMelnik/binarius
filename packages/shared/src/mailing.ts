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
  ReferralRewarded: 'referral_rewarded',
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

// The inviter's reward notification (#576, docs/mailing.md → The referral reward notification):
// due at the reward's own moment, so its delay is the planner's and the sender's next ticks, not a
// wait of its own.
export const REFERRAL_REWARDED_AFTER_MS = 0;

// The job's payload: the reward's tokens, the ledger row's balance_delta as text (a bigint, rule 2);
// a referral reward is a bonus row, so always positive.
export const referralRewardedPayloadSchema = z.object({
  tokens: z.string().regex(/^[1-9]\d*$/),
});
export type ReferralRewardedPayload = z.infer<typeof referralRewardedPayloadSchema>;

// The low-token nudge (#123, docs/mailing.md → The low-token nudge; owner 2026-10-08, 2026-10-10,
// 2026-10-18): the share of the user's own starter pack used, lowest first. A user gets one push,
// for the highest threshold reached, and no lower one while the higher one's job is not canceled.
export const TOKEN_NUDGES = [
  { kind: NotificationKind.TokensHalf, usedPercent: 50 },
  { kind: NotificationKind.TokensLow, usedPercent: 80 },
  { kind: NotificationKind.TokensOut, usedPercent: 100 },
] as const satisfies readonly { kind: NotificationKind; usedPercent: number }[];

// The nudges are due at the planning moment: their delay is the planner's and the sender's ticks.
export const TOKEN_NUDGE_AFTER_MS = 0;

// The job's payload: the threshold's balance, floor(pack × (100 − usedPercent) / 100), as text (a
// bigint, rule 2); 0 for the last threshold.
export const tokenNudgePayloadSchema = z.object({
  tokens: z.string().regex(/^\d+$/),
});
export type TokenNudgePayload = z.infer<typeof tokenNudgePayloadSchema>;

// The smallest offset among the scenarios that wait; the planner's tick must be shorter. The
// immediate kinds (referral_rewarded and the low-token nudges, 0) are not in it: the link about
// the planner's tick concerns only a kind that waits.
export const MAILING_MIN_OFFSET_MS = Math.min(
  ...FIRST_SESSION_CHAIN.map((step) => step.afterHours * 3_600_000),
  ANALYSIS_UNUSED_AFTER_MS,
);
