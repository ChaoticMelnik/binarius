import * as z from 'zod';
import { BonusRuleKind, bonusRuleParamsSchemas } from './bonus';
import { decimalStringSchema } from './money';
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
  RealModeByDeposit: 'real_mode_by_deposit',
  Inactive3d: 'inactive_3d',
  SessionIdle24h: 'session_idle_24h',
  WeeklySummary: 'weekly_summary',
  TokensOut2d: 'tokens_out_2d',
  HelpLinks: 'help_links',
  DemoToReal1h: 'demo_to_real_1h',
  DemoToReal24h: 'demo_to_real_24h',
  DemoToReal72h: 'demo_to_real_72h',
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

// The job's payload: the pair and duration of the analysis, for the «📊 Анализ» button.
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

// The switch to real after a deposit (#686, docs/mailing.md → The real-mode notification): due at
// the switch's own moment, which the deposit's mode_switch_at records.
export const REAL_MODE_BY_DEPOSIT_AFTER_MS = 0;

// The job's payload: the real stake the user's trades now use (effectiveStake, #326) as text
// (rule 2) — the saved one, else the broker's minimum from the account's snapshot; null when
// neither is known, which the text names in words.
export const realModeByDepositPayloadSchema = z.object({
  stake: decimalStringSchema.nullable(),
});
export type RealModeByDepositPayload = z.infer<typeof realModeByDepositPayloadSchema>;

// Retention (#124, docs/mailing.md → Retention; owner 2026-10-08, manager 2026-10-23): a demo user
// with a session behind them and no activity for INACTIVE_AFTER, at most once per
// INACTIVE_REPEAT_DAYS; the newest session stopped SESSION_IDLE_AFTER ago with none since; the
// previous ISO week's demo trades on Monday at WEEKLY_SUMMARY_HOUR_UTC; and the balance still at 0
// TOKENS_OUT_REPEAT_AFTER after the sent tokens_out.
export const INACTIVE_AFTER_MS = 72 * 3_600_000;
export const INACTIVE_REPEAT_DAYS = 7;
export const SESSION_IDLE_AFTER_MS = 24 * 3_600_000;
export const WEEKLY_SUMMARY_HOUR_UTC = 10;
export const TOKENS_OUT_REPEAT_AFTER_MS = 48 * 3_600_000;

const tradeCountSchema = z.int().nonnegative();
// a settled-trade count and its split by the sign of the profit; counts only, no money (rule 2)
const settledScoreShape = {
  settled: tradeCountSchema,
  won: tradeCountSchema,
  lost: tradeCountSchema,
  tied: tradeCountSchema,
};

// session_idle_24h's payload: the newest session's pair and duration for «🔁 Запустить снова»
// (null when its settings do not carry them) and its settled trades.
export const sessionIdlePayloadSchema = z.object({
  assetId: createTradeIntentRequestSchema.shape.assetId.nullable(),
  durationSec: createTradeIntentRequestSchema.shape.durationSec.nullable(),
  ...settledScoreShape,
});
export type SessionIdlePayload = z.infer<typeof sessionIdlePayloadSchema>;

// weekly_summary's payload: the previous ISO week's settled demo trades, as the planning saw them
export const weeklySummaryPayloadSchema = z.object(settledScoreShape);
export type WeeklySummaryPayload = z.infer<typeof weeklySummaryPayloadSchema>;

// The help push (#879, docs/mailing.md → The help push; manager 2026-10-31): hours after the
// account was connected, once per user; the links come from the backend's env.
export const HELP_LINKS_AFTER_MS = 2 * 3_600_000;

// The demo-to-real chain (#880, docs/mailing.md → The demo-to-real chain; manager 2026-10-31):
// hours after the user's DEMO_TO_REAL_SESSIONS-th stopped demo session, while no deposit of theirs
// is recorded. In order: a step is sent only until the next one is due, as FIRST_SESSION_CHAIN.
export const DEMO_TO_REAL_SESSIONS = 3;
export const DEMO_TO_REAL_CHAIN = [
  { kind: NotificationKind.DemoToReal1h, afterHours: 1 },
  { kind: NotificationKind.DemoToReal24h, afterHours: 24 },
  { kind: NotificationKind.DemoToReal72h, afterHours: 72 },
] as const satisfies readonly { kind: NotificationKind; afterHours: number }[];

// The chain's payload, the user's facts as the planning saw them: the stopped demo sessions, the
// settled demo trades and their summed profit as text (rule 2), and the params of the active
// deposit_bonus version, null when none is active.
export const demoToRealPayloadSchema = z.object({
  sessions: tradeCountSchema,
  ...settledScoreShape,
  profit: decimalStringSchema,
  bonus: bonusRuleParamsSchemas[BonusRuleKind.DepositBonus].nullable(),
});
export type DemoToRealPayload = z.infer<typeof demoToRealPayloadSchema>;

// The smallest offset among the scenarios that wait; the planner's tick must be shorter. The
// immediate kinds (referral_rewarded, the low-token nudges, real_mode_by_deposit and
// weekly_summary, 0) are not in it: the link about the planner's tick concerns only a kind that
// waits.
export const MAILING_MIN_OFFSET_MS = Math.min(
  ...FIRST_SESSION_CHAIN.map((step) => step.afterHours * 3_600_000),
  ANALYSIS_UNUSED_AFTER_MS,
  INACTIVE_AFTER_MS,
  SESSION_IDLE_AFTER_MS,
  TOKENS_OUT_REPEAT_AFTER_MS,
  HELP_LINKS_AFTER_MS,
  ...DEMO_TO_REAL_CHAIN.map((step) => step.afterHours * 3_600_000),
);
