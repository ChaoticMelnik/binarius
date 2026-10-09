import type { Api, PollingOptions } from 'grammy';
import { BOT_COMMAND_SCOPE, closeAll, errorLogFields } from '@binarius/shared';
import type { IntentTracker } from './intent-tracker';
import type { SessionTracker } from './session-tracker';
import { telegramErrorFields, type Logger } from './logging';
import { botCommands, PROFILE } from './texts';
import { POLLING_BATCH_LIMIT, POLLING_TIMEOUT_S, SHUTDOWN_BUDGET_MS } from './timing';

// Only the update kinds this bot handles: Telegram then stops delivering the rest, and a new
// kind has to be enabled deliberately rather than arrive unhandled.
export const ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'my_chat_member',
] as const satisfies NonNullable<PollingOptions['allowed_updates']>;

// the parts of a grammY Bot this module drives: start, stop and the profile calls; a fake with
// the same shape is what the tests run, so the drain is provable without a Telegram server
export interface PollingLoop {
  start(options: PollingOptions): Promise<void>;
  stop(): Promise<void>;
  api: Pick<Api, 'setMyCommands' | 'setMyDescription' | 'setMyShortDescription'>;
}

export interface RunBotOptions {
  bot: PollingLoop;
  // the demo trades' status tracker (#127): stopped with the bot, its attempt in flight drained
  tracker: Pick<IntentTracker, 'stop'>;
  // the demo sessions' status tracker (#284), drained the same way
  sessionTracker: Pick<SessionTracker, 'stop'>;
  // the text overrides' refresher (#299): its load in flight waited for, and its first load
  // awaited before the menu and the profile are published (#301)
  botTexts: { stop(): Promise<void>; loaded(): Promise<void> };
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
  tracker,
  sessionTracker,
  botTexts,
  logger,
  exit,
  shutdownBudgetMs = SHUTDOWN_BUDGET_MS,
  signals = ['SIGTERM', 'SIGINT'],
  signalSource = process,
}: RunBotOptions): void {
  let stopping = false;

  // The profile, one call at a time and one attempt each. Every call is caught on its own: a
  // failed one costs that part of the profile and nothing else — the next call is still made, no
  // update is lost and Telegram keeps the last value that did register — while a throw out of
  // onStart would reject start() and exit 1. The next start registers again. The number of
  // calls is STARTUP_CALLS in timing.ts. The values are the texts in effect — the overrides of the
  // first load, or the defaults when it failed (#301).
  const registrations = [
    {
      method: 'setMyCommands',
      failure: 'bot commands not registered',
      call: () => bot.api.setMyCommands(botCommands(), { scope: BOT_COMMAND_SCOPE }),
    },
    {
      method: 'setMyDescription',
      failure: 'bot description not registered',
      call: () => bot.api.setMyDescription(PROFILE.description),
    },
    {
      method: 'setMyShortDescription',
      failure: 'bot short description not registered',
      call: () => bot.api.setMyShortDescription(PROFILE.shortDescription),
    },
  ] as const;
  const registerProfile = async (): Promise<void> => {
    for (const { method, failure, call } of registrations) {
      try {
        await call();
      } catch (error: unknown) {
        logger.warn({ ...errorLogFields(error), ...telegramErrorFields(error, method) }, failure);
      }
    }
  };

  const started = bot.start({
    timeout: POLLING_TIMEOUT_S,
    limit: POLLING_BATCH_LIMIT,
    allowed_updates: ALLOWED_UPDATES,
    // grammY awaits this after getMe and deleteWebhook and before the first getUpdates, so
    // `bot started` still means polling begins now
    onStart: async () => {
      // A failed load settles it too, and the defaults are published. start() runs the first
      // load before polling, so a signal while it is pending does not cut it short: stop() awaits
      // that load, which ends within its budget. The check below is what skips publishing then —
      // it would only hold the drain.
      await botTexts.loaded();
      if (stopping) return;
      await registerProfile();
      logger.info('bot started');
    },
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
    const step = (name: string, run: () => Promise<unknown>) => (): Promise<unknown> =>
      run()
        .catch((error: unknown) => {
          logger.error(errorLogFields(error), `shutdown: ${name} failed`);
          throw error;
        })
        .finally(() => {
          settled += 1;
        });
    const steps = [
      step('bot.stop()', () => bot.stop()),
      step('polling loop', () => started),
      step('intent tracker', () => tracker.stop()),
      step('session tracker', () => sessionTracker.stop()),
      step('bot texts', () => botTexts.stop()),
    ];

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
