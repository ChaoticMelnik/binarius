// The bot's composition and its test harness for the in-process end-to-end test (packages/e2e,
// docs/e2e-demo-cycle.md). Test-only: imported by packages/e2e alone, never by a runtime module.

export { createBackendClient } from './backend-client';
export { createBot, type CreateBotOptions } from './bot';
export { createIntentTracker } from './intent-tracker';
export { createSessionResumer } from './session-resume';
export { createSessionTracker } from './session-tracker';
export {
  cycleStakeLabel,
  groupButtonLabel,
  LABELS,
  pairButtonLabel,
  sessionStatusText,
  TEXTS,
} from './texts';
export {
  INTENT_TRACK_DEADLINE_MS,
  INTENT_TRACK_FIRST_POLL_MS,
  INTENT_TRACK_POLL_MS,
  SESSION_RESUME_GAP_MS,
  SESSION_RESUME_INTERVAL_MS,
  SESSION_TRACK_DEADLINE_MS,
} from './timing';
export * from './testing';
