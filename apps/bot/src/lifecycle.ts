import type { PollingOptions } from 'grammy';
import { closeAll, errorLogFields } from '@binarius/shared';
import type { Logger } from './logging';
import { POLLING_BATCH_LIMIT, POLLING_TIMEOUT_S, SHUTDOWN_BUDGET_MS } from './timing';

// Only the update kinds this bot handles: Telegram then stops delivering the rest, and a new
// kind has to be enabled deliberately rather than arrive unhandled.
export const ALLOWED_UPDATES = ['message', 'callback_query'] as const satisfies NonNullable<
  PollingOptions['allowed_updates']
>;

// the two methods of a grammY Bot this module drives; a fake with the same shape is what the
// tests run, so the drain is provable without a Telegram server
export interface PollingLoop {
  start(options: PollingOptions): Promise<void>;
  stop(): Promise<void>;
}

export interface RunBotOptions {
  bot: PollingLoop;
  logger: Logger;
  exit: (code: number) => void;
  shutdownBudgetMs?: number;
  signals?: readonly NodeJS.Signals[];
  // `process` by default; the tests drive their own emitter rather than the real signals
  signalSource?: { on(signal: NodeJS.Signals, handler: () => void): unknown };
}

// The process around the bot: start long polling, and on the first termination signal stop
// taking updates and let the middleware in flight finish inside one budget. bot.start() resolves
// only once the polling loop has ended, so it is drained alongside stop() rather than after it.
export function runBot({
  bot,
  logger,
  exit,
  shutdownBudgetMs = SHUTDOWN_BUDGET_MS,
  signals = ['SIGTERM', 'SIGINT'],
  signalSource = process,
}: RunBotOptions): void {
  let stopping = false;

  const started = bot.start({
    timeout: POLLING_TIMEOUT_S,
    limit: POLLING_BATCH_LIMIT,
    allowed_updates: ALLOWED_UPDATES,
    onStart: () => logger.info('bot started'),
  });
  // an invalid token fails here: getMe answers 401, which grammY does not retry
  started.catch((error: unknown) => {
    // once a drain owns this promise, only closeAll decides the exit code — exiting here would
    // kill the middleware the drain is deliberately waiting for
    if (stopping) return;
    logger.error(errorLogFields(error), 'long polling stopped with an error');
    exit(1);
  });

  const shutdown = (signal: NodeJS.Signals) => {
    // A second signal is not a reason to tear down a shutdown already under way. The listener
    // has to stay installed for that to be true: a signal with no listener left gets Node's
    // default action, and the second SIGTERM would kill the drain mid-handler — so this is
    // registered with `on`, not `once`, and runBot is not meant to be called twice per process.
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');

    // Each step reports its own failure as it happens, because closeAll answers with one
    // boolean for both an overrun and a rejected step. A SIGTERM during grammY's backoff
    // between getUpdates waits the sleep out (bot.stop() does not interrupt it), with no
    // update in flight.
    let settled = 0;
    const step =
      (name: string, run: () => Promise<unknown>) => (): Promise<unknown> =>
        run()
          .catch((error: unknown) => {
            logger.error(errorLogFields(error), `shutdown: ${name} failed`);
            throw error;
          })
          .finally(() => {
            settled += 1;
          });
    const steps = [step('bot.stop()', () => bot.stop()), step('polling loop', () => started)];

    void closeAll(steps, shutdownBudgetMs).then((drained) => {
      if (!drained) {
        logger.error(
          settled < steps.length
            ? 'shutdown: polling did not stop within the budget, exiting anyway'
            : 'shutdown: a drain step failed, exiting anyway',
        );
      }
      exit(drained ? 0 : 1);
    });
  };

  for (const signal of signals) signalSource.on(signal, () => shutdown(signal));
}
