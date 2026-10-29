// The bot's composition and its test harness for the in-process end-to-end test (packages/e2e,
// docs/e2e-demo-cycle.md). Test-only: imported by packages/e2e alone, never by a runtime module.

export { createBackendClient } from './backend-client';
export { createBot, type CreateBotOptions } from './bot';
export { createIntentTracker } from './intent-tracker';
export { createSessionResumer } from './session-resume';
export { createSessionTracker } from './session-tracker';
export { createShownSignals } from './shown-signals';
export { createSignalWaiter } from './signal-wait';
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
  SIGNAL_WAIT_CAPTION_EDITS_PER_TICK,
  SIGNAL_WAIT_CAPTION_MS,
  SIGNAL_WAIT_EDIT_FAILURES_MAX,
  SIGNAL_WAIT_EDIT_GAP_MS,
  SIGNAL_WAIT_MAX_MS,
  SIGNAL_WAIT_POLL_MS,
  SIGNAL_WAIT_POLL_OFFSET_MS,
  SIGNAL_WAIT_SHUTDOWN_BUDGET_MS,
  SIGNALS_LIST_TTL_MS,
} from './timing';
export * from './testing';
