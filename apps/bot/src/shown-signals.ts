import type { ShownSignalSource, ShownSignalStart, TradeAction } from '@binarius/shared';

// The direction the bot showed for a pair (#829, docs/bot-demo.md, Rule 55): the start of a
// session takes it, so the first trade and the session's picture are the direction the user chose
// on, even when the pair's signal is gone by the press. A record is written only after a screen
// with directions went out (the list, its redraw by the wait, the analysis card), from the
// backend's answer as it came (GET /trading/signals, POST /trading/signal's h1) - never from a
// callback's data. The newest record of a pair wins; a start takes it once. In this process's
// memory, bounded per user and in users (LRU, as the wait's entries, #664): a restart, a second
// process or the bounds lose records, and such a start goes by the start's own H1 reading.

export interface ShownSignalRecord {
  assetId: number;
  action: TradeAction;
  second: number;
  decidedAt: number;
}

export interface ShownSignals {
  // the records of one screen, all with its source and the time it went out
  remember(
    telegramUserId: number,
    source: ShownSignalSource,
    shownAtMs: number,
    records: readonly ShownSignalRecord[],
  ): void;
  // the pair's record, removed: the next start of the pair without a new draw has none
  take(telegramUserId: number, assetId: number): ShownSignalStart | undefined;
  // the users with records
  size(): number;
}

const SHOWN_SIGNALS_MAX_PER_USER = 32;
const SHOWN_SIGNALS_MAX_USERS = 10_000;

export function createShownSignals({
  maxPerUser = SHOWN_SIGNALS_MAX_PER_USER,
  maxUsers = SHOWN_SIGNALS_MAX_USERS,
}: { maxPerUser?: number; maxUsers?: number } = {}): ShownSignals {
  // Map insertion order is the recency: a written user and a written pair go last
  const users = new Map<number, Map<number, ShownSignalStart>>();

  return {
    remember(telegramUserId, source, shownAtMs, records) {
      if (records.length === 0) return;
      const own = users.get(telegramUserId) ?? new Map<number, ShownSignalStart>();
      users.delete(telegramUserId);
      users.set(telegramUserId, own);
      for (const { assetId, action, second, decidedAt } of records) {
        own.delete(assetId);
        own.set(assetId, { action, second, decidedAt, shownAtMs, source });
      }
      for (const oldest of own.keys()) {
        if (own.size <= maxPerUser) break;
        own.delete(oldest);
      }
      for (const oldest of users.keys()) {
        if (users.size <= maxUsers) break;
        users.delete(oldest);
      }
    },
    take(telegramUserId, assetId) {
      const own = users.get(telegramUserId);
      const record = own?.get(assetId);
      if (own === undefined || record === undefined) return undefined;
      own.delete(assetId);
      if (own.size === 0) users.delete(telegramUserId);
      return record;
    },
    size: () => users.size,
  };
}
