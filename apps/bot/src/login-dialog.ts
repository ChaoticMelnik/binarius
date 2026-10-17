import type { CycleStakeStep } from './demo';
import type { StakeStep } from './stake-picker';

// The text dialog of each Telegram user: the email login — waiting for an address, then for the
// code sent to it — a typed stake of one mode (#297, #326, stake-picker.ts), or the typed amount of
// a demo cycle (#476, cycle-stake.ts). One entry per user, so the login and the inputs exclude
// each other: opening one replaces the other. Any inline button press and any command end the
// two inputs (endInputStep, bot.ts, #319); the login steps are not touched. The
// module keeps the login's name. In process memory by the owner's decision (#162): a restart drops
// the step and the user presses the button again. The address lives here and nowhere else in the
// bot — never logged — and leaves with the entry.

export const LOGIN_DIALOG_TTL_MS = 10 * 60_000;
export const LOGIN_DIALOG_MAX_ENTRIES = 10_000;

export type LoginDialogState =
  | { step: 'email' }
  | { step: 'code'; email: string }
  | ({ step: 'stake' } & StakeStep)
  | ({ step: 'cycleStake' } & CycleStakeStep);
export type LoginStep = Exclude<LoginDialogState['step'], 'stake' | 'cycleStake'>;

export interface LoginDialog {
  get(telegramUserId: number): LoginDialogState | undefined;
  set(telegramUserId: number, state: LoginDialogState): void;
  delete(telegramUserId: number): void;
}

export interface LoginDialogOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

// No lock: grammY runs updates one at a time and the bot polls one update per batch
// (POLLING_BATCH_LIMIT), so a get, an awaited backend call and a set never interleave with
// another update's.
export function createLoginDialog({
  ttlMs = LOGIN_DIALOG_TTL_MS,
  maxEntries = LOGIN_DIALOG_MAX_ENTRIES,
  now = Date.now,
}: LoginDialogOptions = {}): LoginDialog {
  const entries = new Map<number, { state: LoginDialogState; expiresAt: number }>();

  return {
    get(telegramUserId) {
      const entry = entries.get(telegramUserId);
      if (entry === undefined) return undefined;
      if (now() >= entry.expiresAt) {
        entries.delete(telegramUserId);
        return undefined;
      }
      return entry.state;
    },
    set(telegramUserId, state) {
      // deleted first so the key moves to the end of the insertion order: a refreshed entry
      // overwritten in place would stay the oldest and be the next one evicted. It also makes a
      // returning user's own slot free, so only a new user can evict anyone.
      entries.delete(telegramUserId);
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done !== true) entries.delete(oldest.value);
      }
      entries.set(telegramUserId, { state, expiresAt: now() + ttlMs });
    },
    delete(telegramUserId) {
      entries.delete(telegramUserId);
    },
  };
}

// get without set: a login step's TTL does not move.
export function endInputStep(dialog: LoginDialog, telegramUserId: number): void {
  const step = dialog.get(telegramUserId)?.step;
  if (step === 'stake' || step === 'cycleStake') dialog.delete(telegramUserId);
}
