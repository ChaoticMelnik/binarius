// The email login dialog of each Telegram user: waiting for an address, then for the code sent
// to it. In process memory by the owner's decision (#162): a restart drops the step and the user
// presses the button again. The address lives here and nowhere else in the bot — never logged —
// and leaves with the entry.

export const LOGIN_DIALOG_TTL_MS = 10 * 60_000;
export const LOGIN_DIALOG_MAX_ENTRIES = 10_000;

export type LoginDialogState = { step: 'email' } | { step: 'code'; email: string };

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
