// The trade log (#666, docs/trade-log.md): one signal_decisions row per decision a session acted
// on.

// signal_decisions.context: who decided. `shadow` has no writer in part 1 (#667's).
export const SignalDecisionContext = {
  Session: 'session',
  SessionStart: 'session_start',
  Shadow: 'shadow',
} as const;
export type SignalDecisionContext =
  (typeof SignalDecisionContext)[keyof typeof SignalDecisionContext];

// signal_decisions.outcome: what the writer did with the decision (docs/trade-log.md → The
// writers and their outcomes)
export const SignalDecisionOutcome = {
  Intent: 'intent',
  Started: 'started',
  NoSignal: 'no_signal',
  Paused: 'paused',
  StakeStop: 'stake_stop',
  Refused: 'refused',
  Replayed: 'replayed',
  Shadow: 'shadow',
} as const;
export type SignalDecisionOutcome =
  (typeof SignalDecisionOutcome)[keyof typeof SignalDecisionOutcome];

// Identifiers, not statuses: a later detector adds a version without a migration (#667), and a
// detail is a code of the writer's own closed list (a refusal's or a stake stop's code).
export const SIGNAL_VERSION_PATTERN = /^[a-z0-9_-]{1,16}$/;
export const SIGNAL_DECISION_DETAIL_PATTERN = /^[a-z0-9_]{1,64}$/;
