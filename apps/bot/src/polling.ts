import { BotError, GrammyError, type Api, type Bot, type PollingOptions } from 'grammy';
import type { Update } from 'grammy/types';
import { errorLogFields } from '@binarius/shared';
import type { Logger } from './logging';

// The client bot's long polling (#869, docs/bot-start.md → Timing and shutdown): its own loop over
// grammY's Bot rather than bot.start(), which runs a batch one update after another, or
// @grammyjs/runner, whose stop() neither waits for the handlers in flight nor confirms only the
// updates it handled. A user's updates run in their order, different users' side by side: at most
// `concurrency` handlers run, one per user (the head of the user's chain), and at most `waitingMax`
// fetched updates wait behind their user's running handler. A getUpdates goes only while both have
// room and asks for no more than the smaller remainder, so an update of a user with no handler
// running starts on arrival unless the process already holds `waitingMax` waiting updates; the next
// getUpdates confirms the batch. stop() aborts the long poll and confirms the offset with
// getUpdates({ offset, limit: 1 }) as grammY's does; start() resolves, or rejects on a 401 or a 409,
// only once every fetched update is handled — none lost, none handled twice inside the drain's
// budget.

export type PollingBot = Pick<Bot, 'init' | 'handleUpdate' | 'errorHandler' | 'api'>;

// grammY types its signals by the abort-controller shim's AbortSignal; the runtime takes Node's
type ApiSignal = Parameters<Api['getUpdates']>[1];
const apiSignal = (signal: AbortSignal): ApiSignal => signal as unknown as ApiSignal;

export interface PollingStartOptions {
  timeout: number;
  allowed_updates: NonNullable<PollingOptions['allowed_updates']>;
  // after getMe and deleteWebhook, before the first getUpdates; a stop while it runs ends the loop
  // without a poll
  onStart?: () => Promise<void>;
}

// what runBot drives; a fake with the same shape is what lifecycle.test.ts runs
export interface PollingLoop {
  start(options: PollingStartOptions): Promise<void>;
  stop(): Promise<void>;
  api: Pick<Api, 'setMyCommands' | 'setMyDescription' | 'setMyShortDescription'>;
}

export interface PollingLoopOptions {
  bot: PollingBot;
  concurrency: number;
  waitingMax: number;
  retryMs: number;
  logger: Logger;
}

// The key a user's updates are ordered by: the update's `from`, else its `chat`; an update with
// neither runs on its own. In a private chat from.id equals chat.id.
export function updateKey(update: Update): string | undefined {
  for (const [field, value] of Object.entries(update)) {
    if (field === 'update_id' || typeof value !== 'object' || value === null) continue;
    const { from, chat } = value as { from?: { id?: unknown }; chat?: { id?: unknown } };
    if (typeof from?.id === 'number') return `from:${String(from.id)}`;
    if (typeof chat?.id === 'number') return `chat:${String(chat.id)}`;
    return undefined;
  }
  return undefined;
}

export function createPollingLoop({
  bot,
  concurrency,
  waitingMax,
  retryMs,
  logger,
}: PollingLoopOptions): PollingLoop {
  let running = false;
  let controller = new AbortController();
  let offset = 0;
  const inflight = new Set<Promise<void>>();
  const chains = new Map<string, Promise<void>>();
  // A head is an update whose handler runs or starts in the next microtask: one per key with a
  // chain plus every keyless update in work. A head's finally runs while its key still maps to the
  // tail, so the count never dips between a head ending and the next update of its key starting.
  let unkeyed = 0;
  let wakeUp: (() => void) | undefined;

  const wake = (): void => {
    const resolve = wakeUp;
    wakeUp = undefined;
    resolve?.();
  };

  // a handler ending or the stop, whichever comes first
  const freed = () =>
    new Promise<void>((resolve) => {
      wakeUp = resolve;
    });

  // the retry's sleep, cut short by the stop
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(handle);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const handle = setTimeout(done, ms);
      signal.addEventListener('abort', done);
    });

  // A call of the loop retried until it answers: 401 (the token revoked) and 409 (another poller)
  // end the loop once the handlers in work are done, a 429 waits its retry_after, anything else retryMs. undefined once stopped.
  async function retrying<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const { signal } = controller;
    while (running) {
      try {
        return await call(signal);
      } catch (error) {
        if (!running) return undefined;
        if (error instanceof GrammyError) {
          if (error.error_code === 401 || error.error_code === 409) throw error;
          if (error.error_code === 429) {
            await sleep((error.parameters.retry_after ?? retryMs / 1000) * 1000, signal);
            continue;
          }
        }
        await sleep(retryMs, signal);
      }
    }
    return undefined;
  }

  async function handle(update: Update): Promise<void> {
    try {
      await bot.handleUpdate(update);
    } catch (error) {
      if (!(error instanceof BotError)) {
        logger.error(
          { ...errorLogFields(error), updateId: update.update_id },
          'update not handled',
        );
        return;
      }
      try {
        await bot.errorHandler(error);
      } catch (handlerError) {
        logger.error(
          { ...errorLogFields(handlerError), updateId: update.update_id },
          'bot.catch failed',
        );
      }
    }
  }

  function dispatch(update: Update): void {
    const key = updateKey(update);
    const previous = (key === undefined ? undefined : chains.get(key)) ?? Promise.resolve();
    const task: Promise<void> = previous
      .then(() => handle(update))
      .finally(() => {
        inflight.delete(task);
        if (key === undefined) unkeyed -= 1;
        else if (chains.get(key) === task) chains.delete(key);
        wake();
      });
    inflight.add(task);
    if (key === undefined) unkeyed += 1;
    else chains.set(key, task);
  }

  return {
    api: bot.api,
    async start({ timeout, allowed_updates, onStart }) {
      if (running) return;
      running = true;
      controller = new AbortController();
      try {
        await bot.init(apiSignal(controller.signal));
        const dropped = await retrying((signal) => bot.api.deleteWebhook({}, apiSignal(signal)));
        if (dropped === undefined) return;
        await onStart?.();
      } catch (error) {
        if (!running) return;
        running = false;
        throw error;
      }
      // Telegram keeps the last allowed_updates, so only the first poll sends them
      let allowed: PollingStartOptions['allowed_updates'] | undefined = allowed_updates;
      let pausedLogged = false;
      let failure: { error: unknown } | undefined;
      try {
        while (running) {
          const heads = chains.size + unkeyed;
          const waiting = inflight.size - heads;
          const free = Math.min(concurrency - heads, waitingMax - waiting);
          if (free <= 0) {
            if (waiting >= waitingMax && !pausedLogged) {
              pausedLogged = true;
              logger.warn(
                { heads, waiting },
                'polling paused: updates waiting behind their users at the bound',
              );
            }
            await freed();
            continue;
          }
          pausedLogged = false;
          const updates = await retrying((signal) =>
            bot.api.getUpdates(
              {
                offset,
                limit: free,
                timeout,
                ...(allowed === undefined ? {} : { allowed_updates: allowed }),
              },
              apiSignal(signal),
            ),
          );
          if (updates === undefined) break;
          allowed = undefined;
          for (const update of updates) {
            offset = update.update_id + 1;
            dispatch(update);
          }
        }
      } catch (error) {
        failure = { error };
      } finally {
        running = false;
      }
      await Promise.allSettled([...inflight]);
      if (failure !== undefined) throw failure.error;
    },
    async stop() {
      if (!running) return;
      running = false;
      controller.abort();
      wake();
      await bot.api.getUpdates({ offset, limit: 1 });
    },
  };
}
