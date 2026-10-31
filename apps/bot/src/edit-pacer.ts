// The pace of the wait's edits (#869, signal-wait.ts, docs/bot-demo.md → The wait for a signal): a
// token bucket of editsPerSecond with at most `burst` tokens, so any window of T holds at most
// burst + editsPerSecond × T edits; at most one edit of a chat in chatGapMs; the edits that show a
// signal before the ones a TTL or a caption asks for, first come first served inside a priority.
// A 429's pause holds every slot until it ends; close() answers every waiting take() at once. A
// waiter no longer wanted when its turn comes (its entry ended) is dropped without a token.

export type EditPriority = 'signal' | 'housekeeping';

export interface EditPacer {
  take(
    chatId: number,
    priority: EditPriority,
    wanted?: () => boolean,
  ): Promise<'slot' | 'dropped' | 'closed'>;
  pause(untilMs: number): void;
  pausedUntil(): number;
  close(): void;
}

export interface EditPacerOptions {
  editsPerSecond: number;
  burst: number;
  chatGapMs: number;
  now?: () => number;
}

interface Waiter {
  chatId: number;
  wanted: () => boolean;
  resolve(result: 'slot' | 'dropped' | 'closed'): void;
}

export function createEditPacer({
  editsPerSecond,
  burst,
  chatGapMs,
  now = Date.now,
}: EditPacerOptions): EditPacer {
  const queues: Record<EditPriority, Waiter[]> = { signal: [], housekeeping: [] };
  const lastEditAt = new Map<number, number>();
  let tokens = burst;
  let refilledAt = now();
  let paused = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function refill(at: number): void {
    tokens = Math.min(burst, tokens + ((at - refilledAt) * editsPerSecond) / 1000);
    refilledAt = at;
  }

  function arm(ms: number): void {
    timer = setTimeout(
      () => {
        timer = undefined;
        pump();
      },
      Math.max(0, Math.ceil(ms)),
    );
  }

  const chatFreeAt = (chatId: number): number => (lastEditAt.get(chatId) ?? -Infinity) + chatGapMs;

  function pump(): void {
    if (closed) return;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const at = now();
    if (at < paused) {
      refilledAt = Math.max(refilledAt, at);
      arm(paused - at);
      return;
    }
    refill(at);
    for (const [chatId, editedAt] of lastEditAt) {
      if (at - editedAt >= chatGapMs) lastEditAt.delete(chatId);
    }
    for (;;) {
      for (const priority of ['signal', 'housekeeping'] as const) {
        queues[priority] = queues[priority].filter((waiter) => {
          if (waiter.wanted()) return true;
          waiter.resolve('dropped');
          return false;
        });
      }
      const waiting = [...queues.signal, ...queues.housekeeping];
      if (waiting.length === 0) return;
      if (tokens < 1) {
        arm(((1 - tokens) * 1000) / editsPerSecond);
        return;
      }
      const next = waiting.find((waiter) => chatFreeAt(waiter.chatId) <= at);
      if (next === undefined) {
        arm(Math.min(...waiting.map((waiter) => chatFreeAt(waiter.chatId))) - at);
        return;
      }
      const queue = queues.signal.includes(next) ? queues.signal : queues.housekeeping;
      queue.splice(queue.indexOf(next), 1);
      tokens -= 1;
      lastEditAt.set(next.chatId, at);
      next.resolve('slot');
    }
  }

  return {
    take(chatId, priority, wanted = () => true) {
      if (closed) return Promise.resolve('closed');
      return new Promise((resolve) => {
        queues[priority].push({ chatId, wanted, resolve });
        pump();
      });
    },
    pause(untilMs) {
      if (untilMs <= paused) return;
      paused = untilMs;
      pump();
    },
    pausedUntil: () => paused,
    close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const waiter of [...queues.signal, ...queues.housekeeping]) waiter.resolve('closed');
      queues.signal = [];
      queues.housekeeping = [];
    },
  };
}
