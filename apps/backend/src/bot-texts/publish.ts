import { Api, HttpError } from 'grammy';
import {
  BOT_COMMAND_SCOPE,
  BOT_PROFILE_METHODS,
  botCommandsOf,
  createBotTexts,
  errorIdentity,
  errorLogFields,
  resolveBotTextOverrides,
  type BotProfileMethod,
  type BotTextKey,
  type BotTextSource,
  type ErrorLogFields,
} from '@binarius/shared';
import { listBotTextOverrides, type DbExecutor } from '@binarius/db';
import { telegramErrorFields } from '../telegram-logging';
import { BOT_PROFILE_PUBLISH_TIMEOUT_MS } from '../timing';

// Publishing the client bot's command menu and profile (#301, docs/bot-texts.md → Publishing):
// the CLI after its save or reset of a `commands`/`profile` key and on `bot-text publish`, the
// admin section in #361. apps/bot publishes the same three at its start.

export type BotProfileApi = Pick<Api, BotProfileMethod>;

// Identity only (Rule 8): Telegram's `description` and the payload never reach a result, so a
// caller may log one as it is.
export type BotProfileMethodResult =
  | { method: BotProfileMethod; ok: true }
  | ({ method: BotProfileMethod; ok: false; telegramErrorCode?: number } & ErrorLogFields);

export interface CreateBotProfileApiOptions {
  token: string;
  // the seams the tests need, as for the link push
  apiRoot?: string;
  telegramApiTimeoutMs?: number;
}

// On the public bot's token without polling it: apps/bot is the one poller, and a bare Api calls
// nothing until a method is called — not even getMe.
export function createBotProfileApi({
  token,
  apiRoot,
  telegramApiTimeoutMs = BOT_PROFILE_PUBLISH_TIMEOUT_MS,
}: CreateBotProfileApiOptions): BotProfileApi {
  return new Api(token, {
    ...(apiRoot === undefined ? {} : { apiRoot }),
    // grammY's own default is 500 s
    timeoutSeconds: telegramApiTimeoutMs / 1000,
  });
}

// What the loaders would apply now. Read after the caller's commit, never built from the
// request's own text, so a publish shows exactly what the bot shows.
export async function readBotProfileSource(db: DbExecutor): Promise<BotTextSource<BotTextKey>> {
  return resolveBotTextOverrides(await listBotTextOverrides(db)).source;
}

function failureOf(method: BotProfileMethod, error: unknown): BotProfileMethodResult {
  const fields = errorLogFields(error);
  // grammY's HttpError keeps what failed under `error`, not `cause`
  const cause =
    fields.cause ?? (error instanceof HttpError ? errorIdentity(error.error) : undefined);
  const { telegramErrorCode } = telegramErrorFields(error, method);
  return {
    method,
    ok: false,
    err: fields.err,
    ...(cause === undefined ? {} : { cause }),
    ...(telegramErrorCode === undefined ? {} : { telegramErrorCode }),
  };
}

/**
 * Sends `methods` in BOT_PROFILE_METHODS order, one attempt each and one after another, each
 * caught on its own: a failed call costs its part and Telegram keeps the last value that did
 * register. One result per method sent, in call order. Neither logs nor audits — the caller does.
 */
export async function publishBotProfile(
  api: BotProfileApi,
  source: BotTextSource<BotTextKey>,
  methods: readonly BotProfileMethod[],
): Promise<BotProfileMethodResult[]> {
  const { plain } = createBotTexts(source);
  const calls: Record<BotProfileMethod, () => Promise<true>> = {
    setMyCommands: () => api.setMyCommands(botCommandsOf(plain), { scope: BOT_COMMAND_SCOPE }),
    setMyDescription: () => api.setMyDescription(plain.profileDescription),
    setMyShortDescription: () => api.setMyShortDescription(plain.profileShortDescription),
  };
  const results: BotProfileMethodResult[] = [];
  for (const method of BOT_PROFILE_METHODS.filter((m) => methods.includes(m))) {
    try {
      await calls[method]();
      results.push({ method, ok: true });
    } catch (error: unknown) {
      results.push(failureOf(method, error));
    }
  }
  return results;
}
