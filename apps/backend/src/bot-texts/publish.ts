import { Api, HttpError } from 'grammy';
import {
  BOT_COMMAND_SCOPE,
  BOT_PROFILE_METHODS,
  BotLanguage,
  botCommandsOf,
  createBotTexts,
  errorIdentity,
  errorLogFields,
  resolveBotTextOverrides,
  TELEGRAM_PROFILE_DEFAULT_LANGUAGE,
  type BotProfileMethod,
  type BotTextKey,
  type BotTextSource,
  type ErrorLogFields,
  telegramErrorFields,
} from '@binarius/shared';
import { listBotTextOverrides, type DbExecutor } from '@binarius/db';
import { BOT_PROFILE_PUBLISH_TIMEOUT_MS } from '../timing';

// Publishing the client bot's command menu and profile (#301, docs/bot-texts.md → Publishing):
// the CLI and the admin section (#361), each after its save or reset of a `commands`/`profile` key
// and on its republish (`bot-text publish`, «Опубликовать заново»). apps/bot publishes the same
// three at its start. Each in both languages (#508): Russian under language_code ru, English as the
// default Telegram shows every other client. A save or reset publishes its key's method in its
// key's language only (#634).

export type BotProfileApi = Pick<Api, BotProfileMethod>;

// Identity only (Rule 8): Telegram's `description` and the payload never reach a result, so a
// caller may log one as it is.
export type BotProfileMethodResult =
  | { method: BotProfileMethod; ok: true }
  | ({
      method: BotProfileMethod;
      ok: false;
      telegramErrorCode?: number;
      // the language whose call failed; the first, when both did
      language: BotLanguage;
    } & ErrorLogFields);

// the texts of each language, each with its own overrides (#634)
export type BotProfileSources = Readonly<Record<BotLanguage, BotTextSource<BotTextKey>>>;

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
export async function readBotProfileSource(db: DbExecutor): Promise<BotProfileSources> {
  const resolved = resolveBotTextOverrides(await listBotTextOverrides(db));
  return { [BotLanguage.Ru]: resolved.ru.source, [BotLanguage.En]: resolved.en.source };
}

function failureOf(
  method: BotProfileMethod,
  language: BotLanguage,
  error: unknown,
): BotProfileMethodResult {
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
    language,
  };
}

/**
 * Sends `methods` in BOT_PROFILE_METHODS order, one method after another and its `languages` side
 * by side, one attempt each and each caught on its own: a failed call costs its part in its
 * language and Telegram keeps the last value that did register. One result per method sent, in
 * call order: ok when every language sent was, else the first language's failure. Neither logs nor
 * audits — the caller does.
 */
export async function publishBotProfile(
  api: BotProfileApi,
  sources: BotProfileSources,
  methods: readonly BotProfileMethod[],
  only: readonly BotLanguage[] = Object.values(BotLanguage),
): Promise<BotProfileMethodResult[]> {
  const callsOf = (language: BotLanguage): Record<BotProfileMethod, () => Promise<true>> => {
    const { plain } = createBotTexts(sources[language]);
    const other = language === TELEGRAM_PROFILE_DEFAULT_LANGUAGE ? {} : { language_code: language };
    return {
      setMyCommands: () =>
        api.setMyCommands(botCommandsOf(plain), { scope: BOT_COMMAND_SCOPE, ...other }),
      setMyDescription: () => api.setMyDescription(plain.profileDescription, other),
      setMyShortDescription: () => api.setMyShortDescription(plain.profileShortDescription, other),
    };
  };
  const languages = Object.values(BotLanguage).filter((language) => only.includes(language));
  const calls = languages.map((language) => ({ language, calls: callsOf(language) }));
  const results: BotProfileMethodResult[] = [];
  for (const method of BOT_PROFILE_METHODS.filter((m) => methods.includes(m))) {
    const settled = await Promise.allSettled(calls.map(({ calls: of }) => of[method]()));
    const failed = settled.findIndex((outcome) => outcome.status === 'rejected');
    const outcome = settled[failed];
    const language = languages[failed];
    results.push(
      outcome?.status === 'rejected' && language !== undefined
        ? failureOf(method, language, outcome.reason)
        : { method, ok: true },
    );
  }
  return results;
}
