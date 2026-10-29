import { errorLogFields } from './logging';
import { telegramErrorFields } from './telegram-logging';

// The Bot API calls grammY retries by itself: getUpdates in the polling loop (everything but 401
// and 409), getMe and deleteWebhook while starting. grammY reports those failures only through the
// `debug` package, which is silent without DEBUG — and DEBUG is never set, because its lines carry
// the error message, whose URL holds the token.
export const TELEGRAM_RETRIED_METHODS = ['getUpdates', 'getMe', 'deleteWebhook'] as const;
export const TELEGRAM_RETRY_FAILED_MESSAGE = 'Bot API call failed, grammY retries it';
export const TELEGRAM_RETRY_RECOVERED_MESSAGE = 'Bot API call succeeded after failures';

export interface TelegramRefusalAnswer {
  ok: false;
  error_code: number;
  description: string;
  parameters?: { retry_after?: number };
}

export type TelegramAnswer = { ok: true; result: unknown } | TelegramRefusalAnswer;

export interface TelegramRetryLogOptions {
  logger: {
    warn(fields: object, message: string): void;
    info(fields: object, message: string): void;
  };
  methods?: readonly string[];
  now?: () => number;
}

export interface TelegramRetryLog {
  call<T extends TelegramAnswer>(
    method: string,
    run: () => Promise<T>,
    signal?: { readonly aborted: boolean },
  ): Promise<T>;
}

interface Series {
  failures: number;
  since: number;
}

// What grammY throws a moment later for an `ok: false` answer (grammy core/error.js, toGrammyError),
// built here because a transformer sees the answer before callApi turns it into a GrammyError.
// telegramErrorFields reads a refusal by its fields, errorIdentity only by its name; the
// description stays in the message, which is never logged.
function refusalOf(method: string, refusal: TelegramRefusalAnswer): Error {
  return Object.assign(new Error(refusal.description), {
    name: 'GrammyError',
    method,
    error_code: refusal.error_code,
    description: refusal.description,
  });
}

function retryAfterOf(refusal: TelegramRefusalAnswer): number | undefined {
  const retryAfter = refusal.parameters?.retry_after;
  return typeof retryAfter === 'number' ? retryAfter : undefined;
}

// Typed by shape, without grammY, as telegram-logging.ts is; each app installs it with a one-line
// transformer around `prev`, which is what makes it a grammY Transformer. The answer is always
// returned and the error always rethrown unchanged, so grammY behaves as it would without it.
export function createTelegramRetryLog(options: TelegramRetryLogOptions): TelegramRetryLog {
  const { logger } = options;
  const methods = options.methods ?? TELEGRAM_RETRIED_METHODS;
  const now = options.now ?? Date.now;
  const series = new Map<string, Series>();

  function failed(method: string, error: unknown, startedAt: number, retryAfterS?: number): void {
    const current = series.get(method) ?? { failures: 0, since: startedAt };
    current.failures += 1;
    series.set(method, current);
    logger.warn(
      {
        ...errorLogFields(error),
        ...telegramErrorFields(error, method),
        ...(retryAfterS === undefined ? {} : { retryAfterS }),
        failures: current.failures,
        elapsedMs: now() - startedAt,
      },
      TELEGRAM_RETRY_FAILED_MESSAGE,
    );
  }

  function succeeded(method: string): void {
    const current = series.get(method);
    if (current === undefined) return;
    series.delete(method);
    logger.info(
      { method, failures: current.failures, downMs: now() - current.since },
      TELEGRAM_RETRY_RECOVERED_MESSAGE,
    );
  }

  return {
    async call(method, run, signal) {
      if (!methods.includes(method)) return run();
      const startedAt = now();
      let data: unknown;
      try {
        data = await run();
      } catch (error) {
        // bot.stop() aborts the hanging long poll: our own stop, not a Telegram failure.
        if (signal?.aborted !== true) failed(method, error, startedAt);
        throw error;
      }
      const answer = data as Partial<TelegramAnswer> | null;
      if (typeof answer === 'object' && answer !== null && answer.ok === true) {
        succeeded(method);
      } else if (typeof answer === 'object' && answer !== null && answer.ok === false) {
        const refusal = answer as TelegramRefusalAnswer;
        failed(method, refusalOf(method, refusal), startedAt, retryAfterOf(refusal));
      } else {
        // callApi fails on exactly this answer with a TypeError of its own.
        failed(method, new TypeError('Bot API answer without ok'), startedAt);
      }
      return data as Awaited<ReturnType<typeof run>>;
    },
  };
}
