import type { PollingOptions } from 'grammy';
import { closeAll, errorLogFields } from '@binarius/shared';
import type { Logger } from './logging';
import { POLLING_TIMEOUT_S, SHUTDOWN_BUDGET_MS } from './timing';

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
  signalSource?: { once(signal: NodeJS.Signals, handler: () => void): unknown };
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
  const started = bot.start({
    timeout: POLLING_TIMEOUT_S,
    allowed_updates: ALLOWED_UPDATES,
    onStart: () => logger.info('bot started'),
  });
  // an invalid token fails here: getMe answers 401, which grammY does not retry
  started.catch((error: unknown) => {
    logger.error(errorLogFields(error), 'long polling stopped with an error');
    exit(1);
  });

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    // a second signal is not a reason to tear down a shutdown already under way
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    void closeAll([() => bot.stop(), () => started], shutdownBudgetMs).then((drained) => {
      if (!drained) {
        logger.error('shutdown: polling did not stop within the budget, exiting anyway');
      }
      exit(drained ? 0 : 1);
    });
  };

  for (const signal of signals) signalSource.once(signal, () => shutdown(signal));
}
