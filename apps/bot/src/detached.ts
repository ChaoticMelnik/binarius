import { errorLogFields } from '@binarius/shared';
import type { Logger } from './logging';

// Work a handler hands off so the user's chain is not held by it (#875, Rule 70, Rule 73): a
// card's unpin and pin. It starts on a timer, so after the handler has returned and its update is
// done; a failure is logged and goes nowhere else. One chat's work runs one at a time, in the order
// handed off, and a newer work replaces the one still waiting for its chat: a newer card's pin
// supersedes an older one's, so the newest card is pinned last. stop() runs beside the drain of
// the handlers (closeAll runs the shutdown steps side by side): work not yet started is dropped,
// and so is any handed off after it — the next /start pins again — while work already running is
// waited for, at most DETACHED_DRAIN_MS (timing.ts).
export interface DetachedWork {
  // the next work of a chat starts from the previous one's settling, so it inherits that one's
  // async context (the ALS language): a pin writes no text, so that is harmless
  run: (chatId: number, work: () => Promise<void>) => void;
  // every handed-off work started and settled: for the tests
  settled: () => Promise<void>;
  stop: () => Promise<void>;
}

interface ChatWork {
  next?: () => Promise<void>;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export function createDetachedWork({ logger }: { logger: Logger }): DetachedWork {
  let stopping = false;
  // a chat's entry lives only while its work runs or waits
  const chats = new Map<number, ChatWork>();
  const waiting = new Set<ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<void>>();

  const begin = (chatId: number, state: ChatWork) => {
    const work = state.next;
    delete state.next;
    if (work === undefined) {
      chats.delete(chatId);
      return;
    }
    state.running = true;
    const running = work()
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'detached work failed');
      })
      .finally(() => {
        inFlight.delete(running);
        state.running = false;
        if (state.next !== undefined && !stopping) begin(chatId, state);
        else chats.delete(chatId);
      });
    inFlight.add(running);
  };
  const drain = async () => {
    while (inFlight.size > 0) await Promise.all([...inFlight]);
  };

  return {
    run: (chatId, work) => {
      if (stopping) return;
      let state = chats.get(chatId);
      if (state === undefined) {
        state = { running: false };
        chats.set(chatId, state);
      }
      state.next = work;
      if (state.running || state.timer !== undefined) return;
      const chat = state;
      const timer = setTimeout(() => {
        waiting.delete(timer);
        delete chat.timer;
        begin(chatId, chat);
      }, 0);
      chat.timer = timer;
      waiting.add(timer);
    },
    settled: async () => {
      while (waiting.size > 0 || inFlight.size > 0) {
        // timers of one delay fire in the order set: this one comes after every waiting work's
        if (waiting.size > 0) await new Promise((resolve) => setTimeout(resolve, 0));
        await drain();
      }
    },
    stop: async () => {
      stopping = true;
      for (const timer of waiting) clearTimeout(timer);
      waiting.clear();
      // a chat whose timer was cleared keeps nothing; a running one ends its entry itself
      for (const [chatId, state] of chats) if (!state.running) chats.delete(chatId);
      await drain();
    },
  };
}
