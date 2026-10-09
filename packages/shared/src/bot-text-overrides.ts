import * as z from 'zod';
import { BotTextProblemCode, type BotTextProblem, type BotTextSource } from './bot-text-template';
import {
  BOT_TEXT_MESSAGES,
  botTextMessageKeys,
  estimateBotTextMessage,
  type BotTextMessage,
} from './bot-text-messages';
import { BOT_TEXT_CATALOG, botTextProblems, type BotTextKey } from './bot-texts';
import { errorLogFields } from './logging';

// Overrides of the client bot's texts (docs/bot-texts.md → Overrides): stored by @binarius/db,
// read by the bot over GET /bot-texts and by the backend from the database, edited by the CLI and
// the admin section (#300). One resolver decides which of them take effect, for the loaders and
// the writer alike.

// one source for the catalog's test, the wire schema and the table's CHECK
export const BOT_TEXT_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/;
// UTF-16 units; the CHECK counts code points, never more, so what the writer takes the table takes
export const BOT_TEXT_SOURCE_MAX = 16384;
export const BOT_TEXT_OVERRIDES_MAX = 1000;
// how often the bot and the backend reload the overrides
export const BOT_TEXTS_REFRESH_MS = 30_000;
// what the CLI and the admin section promise: a refresh plus a load's budget (apps/bot timing.test)
export const BOT_TEXTS_APPLIED_WITHIN_S = 35;
export const BOT_TEXTS_PATH = '/bot-texts';
// One publish of the command menu and the profile (#301): three Bot API calls, each bounded by the
// backend's BOT_PROFILE_PUBLISH_TIMEOUT_MS (its timing chain holds the product to this). Here
// because web sizes its request timeout against it when the admin section publishes (#361).
export const BOT_PROFILE_PUBLISH_BUDGET_MS = 6_000;

export const isBotTextKey = (key: string): key is BotTextKey =>
  Object.hasOwn(BOT_TEXT_CATALOG, key);

// A key outside this build's catalog passes: the bot and the backend can run different catalogs,
// and the resolver ignores what it does not know.
export const botTextOverrideSchema = z.strictObject({
  key: z.string().regex(BOT_TEXT_KEY_PATTERN),
  source: z.string().min(1).max(BOT_TEXT_SOURCE_MAX),
  version: z.int().positive(),
});
export type BotTextOverride = z.infer<typeof botTextOverrideSchema>;

export const botTextOverridesResponseSchema = z.strictObject({
  overrides: z.array(botTextOverrideSchema).max(BOT_TEXT_OVERRIDES_MAX),
});
export type BotTextOverridesResponse = z.infer<typeof botTextOverridesResponseSchema>;

export interface BotTextOverrideRow {
  key: string;
  source: string;
  version?: number;
}

export const BotTextRejectionCode = {
  UnknownKey: 'unknown_key',
  Invalid: 'invalid',
  BreaksHost: 'breaks_host',
  MessageOverflow: 'message_overflow',
} as const;
export type BotTextRejectionCode = (typeof BotTextRejectionCode)[keyof typeof BotTextRejectionCode];

type Rejection =
  | { code: typeof BotTextRejectionCode.UnknownKey }
  | { code: typeof BotTextRejectionCode.Invalid; problems: BotTextProblem[] }
  | { code: typeof BotTextRejectionCode.BreaksHost; host: BotTextKey; problems: BotTextProblem[] }
  | {
      code: typeof BotTextRejectionCode.MessageOverflow;
      message: BotTextMessage;
      length: number;
    };
export type BotTextRejection = Rejection & { version?: number };

export interface ResolvedBotTexts {
  source: BotTextSource<BotTextKey>;
  // the overrides in effect
  texts: ReadonlyMap<BotTextKey, string>;
  rejected: ReadonlyMap<string, BotTextRejection>;
}

const CATALOG_KEYS = Object.keys(BOT_TEXT_CATALOG) as BotTextKey[];
const HOSTS = CATALOG_KEYS.filter((key) => Object.keys(BOT_TEXT_CATALOG[key].fragments).length > 0);
const fragmentsOf = (host: BotTextKey): BotTextKey[] =>
  Object.values(BOT_TEXT_CATALOG[host].fragments) as BotTextKey[];
const MESSAGE_KEYS = new Map(
  BOT_TEXT_MESSAGES.map((message) => [message, botTextMessageKeys(message)]),
);

const sourceWith = (texts: ReadonlyMap<BotTextKey, string>): BotTextSource<BotTextKey> => ({
  sourceOf: (key) => texts.get(key) ?? BOT_TEXT_CATALOG[key].source,
});

// The first thing wrong with the accepted candidates, as the candidates it takes out.
function firstFailure(
  texts: ReadonlyMap<BotTextKey, string>,
): [BotTextKey, Rejection][] | undefined {
  const lookup = sourceWith(texts);
  for (const [key, source] of texts) {
    const problems = botTextProblems(key, source, lookup);
    if (problems.length > 0) return [[key, { code: BotTextRejectionCode.Invalid, problems }]];
  }
  // a fragment is checked against every host still on its default (#299, m3)
  for (const host of HOSTS) {
    if (texts.has(host)) continue;
    const problems = botTextProblems(host, BOT_TEXT_CATALOG[host].source, lookup);
    const culprits = fragmentsOf(host).filter((key) => texts.has(key));
    if (problems.length > 0 && culprits.length > 0) {
      return culprits.map((key) => [
        key,
        { code: BotTextRejectionCode.BreaksHost, host, problems },
      ]);
    }
  }
  for (const message of BOT_TEXT_MESSAGES) {
    const length = estimateBotTextMessage(message, lookup);
    const culprits = [...(MESSAGE_KEYS.get(message) ?? [])].filter((key) => texts.has(key));
    if (length > message.limit && culprits.length > 0) {
      return culprits.map((key) => [
        key,
        { code: BotTextRejectionCode.MessageOverflow, message, length },
      ]);
    }
  }
  return undefined;
}

/**
 * Which of `rows` take effect. Each failing step only takes candidates out, and the defaults pass
 * every step, so the loop ends; on its last pass every accepted override is valid with the others,
 * every host on its default renders, and every assembled message fits.
 */
export function resolveBotTextOverrides(rows: readonly BotTextOverrideRow[]): ResolvedBotTexts {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const rejected = new Map<string, BotTextRejection>();
  const reject = (key: string, rejection: Rejection) => {
    const version = byKey.get(key)?.version;
    rejected.set(key, version === undefined ? rejection : { ...rejection, version });
  };
  for (const key of [...byKey.keys()].filter((key) => !isBotTextKey(key)).sort()) {
    reject(key, { code: BotTextRejectionCode.UnknownKey });
  }
  const texts = new Map<BotTextKey, string>();
  for (const key of CATALOG_KEYS) {
    const row = byKey.get(key);
    if (row !== undefined) texts.set(key, row.source);
  }
  for (let failure = firstFailure(texts); failure !== undefined; failure = firstFailure(texts)) {
    for (const [key, rejection] of failure) {
      texts.delete(key);
      reject(key, rejection);
    }
  }
  return { source: sourceWith(texts), texts, rejected };
}

export interface BotTextChangeProblem {
  key: string;
  rejection: BotTextRejection;
}

/**
 * Why setting `key` to `next` (null: back to the default) cannot be saved: the key itself would be
 * rejected, or an override in effect now would stop being. An override rejected already does not
 * block a change of another key.
 */
export function botTextChangeProblems(
  key: string,
  next: string | null,
  rows: readonly BotTextOverrideRow[],
): BotTextChangeProblem[] {
  const before = resolveBotTextOverrides(rows);
  const after = resolveBotTextOverrides([
    ...rows.filter((row) => row.key !== key),
    ...(next === null ? [] : [{ key, source: next }]),
  ]);
  const problems: BotTextChangeProblem[] = [];
  const own = after.rejected.get(key);
  if (next !== null && own !== undefined) problems.push({ key, rejection: own });
  for (const other of before.texts.keys()) {
    const rejection = after.rejected.get(other);
    if (other !== key && rejection !== undefined) problems.push({ key: other, rejection });
  }
  return problems;
}

// ---- Messages, one source for the CLI and the admin section ---------------------------------

const placeholders = (names: readonly string[]): string =>
  names.map((name) => `{${name}}`).join(', ');

// what the key's text may hold, for a refusal of a placeholder it may not (#358)
function availableOf(key: BotTextKey): string {
  const entry = BOT_TEXT_CATALOG[key];
  const fragments = Object.keys(entry.fragments);
  return [
    entry.vars.length === 0
      ? 'Переменных у этого текста нет'
      : `Доступны: ${placeholders(entry.vars)}`,
    ...(fragments.length === 0 ? [] : [`фрагменты: ${placeholders(fragments)}`]),
  ].join('; ');
}

export function botTextProblemMessage(key: BotTextKey, problem: BotTextProblem): string {
  const detail = problem.detail ?? '';
  const messages = {
    [BotTextProblemCode.Empty]: 'Пустой текст',
    [BotTextProblemCode.StrayBrace]: 'Лишняя фигурная скобка',
    [BotTextProblemCode.UnknownPlaceholder]: `Переменная {${detail}} недоступна в этом тексте. ${availableOf(key)}`,
    [BotTextProblemCode.PlaceholderInTag]: `Плейсхолдер {${detail}} внутри тега`,
    [BotTextProblemCode.InvalidHtml]: `Битый HTML: ${detail}`,
    [BotTextProblemCode.TooLong]: `Текст ${key} — ${detail} символов при лимите ${String(BOT_TEXT_CATALOG[key].limit)}`,
    [BotTextProblemCode.PaddedLine]: 'Пробел в начале или в конце строки',
    [BotTextProblemCode.Multiline]: 'Перенос строки в однострочном тексте',
  } satisfies Record<BotTextProblemCode, string>;
  return messages[problem.code];
}

const problemsText = (key: BotTextKey, problems: readonly BotTextProblem[]): string =>
  problems.map((problem) => botTextProblemMessage(key, problem)).join('; ');

export function botTextRejectionMessage(rejection: BotTextRejection, key: string): string {
  switch (rejection.code) {
    case BotTextRejectionCode.UnknownKey:
      return 'Неизвестный ключ — игнорируется';
    case BotTextRejectionCode.Invalid:
      return problemsText(key as BotTextKey, rejection.problems);
    case BotTextRejectionCode.BreaksHost:
      return `Ломает текст-хозяин ${rejection.host}: ${problemsText(rejection.host, rejection.problems)}`;
    case BotTextRejectionCode.MessageOverflow:
      return `Сообщение «${rejection.message.title}» станет ${String(rejection.length)} символов при лимите ${String(rejection.message.limit)}`;
  }
}

// ---- Refresher ------------------------------------------------------------------------------

export class BotTextsLoadTimeout extends Error {
  override readonly name = 'BotTextsLoadTimeout';
}

export interface BotTextRefresherOptions {
  load(): Promise<readonly BotTextOverrideRow[]>;
  intervalMs: number;
  // a load that takes longer counts as failed
  budgetMs: number;
  apply(source: BotTextSource<BotTextKey>): void;
  logger: { warn(fields: object, message: string): void };
  // more identity of a failure than errorLogFields gives, by the caller's error types
  failureFields?(error: unknown): object;
}

export interface BotTextRefresher {
  start(): void;
  stop(): Promise<void>;
  // Settles once the first load has, whether it applied the overrides or failed (a load never
  // rejects), or on stop() before any load: the bot publishes its menu and profile after it (#301).
  loaded(): Promise<void>;
}

/**
 * Loads the overrides at start and then every `intervalMs` from the start of the previous load,
 * so a saved text is applied within `intervalMs + budgetMs`. A failed load keeps what was applied
 * last; before the first success that is the defaults.
 */
export function createBotTextRefresher(options: BotTextRefresherOptions): BotTextRefresher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let reported = '';
  let settleFirst: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    settleFirst = resolve;
  });

  const withinBudget = <T>(work: Promise<T>): Promise<T> => {
    let budget: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      budget = setTimeout(() => reject(new BotTextsLoadTimeout()), options.budgetMs);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(budget));
  };

  // reported once per change of the set, not on every load
  function report(rejected: ReadonlyMap<string, BotTextRejection>): void {
    const signature = JSON.stringify(
      [...rejected].map(([key, rejection]) => [key, rejection.code, rejection.version]),
    );
    if (signature === reported) return;
    reported = signature;
    for (const [key, rejection] of rejected) {
      options.logger.warn(
        {
          botTextKey: key,
          botTextVersion: rejection.version,
          rejection: rejection.code,
          ...(rejection.code === BotTextRejectionCode.BreaksHost ? { host: rejection.host } : {}),
          ...(rejection.code === BotTextRejectionCode.MessageOverflow
            ? { botTextMessage: rejection.message.id }
            : {}),
        },
        'bot text override rejected, the default is shown',
      );
    }
  }

  async function load(): Promise<void> {
    try {
      const { source, rejected } = resolveBotTextOverrides(await withinBudget(options.load()));
      options.apply(source);
      report(rejected);
    } catch (error) {
      options.logger.warn(
        { ...errorLogFields(error), ...options.failureFields?.(error) },
        'bot texts load failed, the last loaded texts stay',
      );
    }
  }

  function tick(): void {
    if (stopped) return;
    inFlight = load();
    void inFlight.then(settleFirst);
    timer = setTimeout(tick, options.intervalMs);
  }

  return {
    start() {
      if (stopped || timer !== undefined) return;
      tick();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (inFlight === undefined) settleFirst();
      await inFlight;
    },
    loaded: () => first,
  };
}
