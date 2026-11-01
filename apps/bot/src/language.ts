import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, NextFunction } from 'grammy';
import {
  botLanguageOf,
  DEFAULT_BOT_LANGUAGE,
  errorLogFields,
  UserErrorCode,
  type BotLanguage,
} from '@binarius/shared';
import { BackendError, backendErrorFields, type BackendClient } from './backend-client';
import type { Logger } from './logging';
import { LANGUAGE_CACHE_MAX, LANGUAGE_MISSING_TTL_MS } from './timing';

// The language of the texts the bot is writing right now (#508, docs/bot-texts.md → Languages).
// The middleware puts the user's language into this store before any handler runs, so every text
// a handler reads (TEXTS, LABELS, the label maps) is in that language without being passed down;
// the trackers and the start, which write outside an update, run their work inside
// runWithLanguage with the language they hold.
const store = new AsyncLocalStorage<BotLanguage>();

let missingReads = 0;
let onMissing: () => void = () => {};
// how many texts were read outside any language, all of them in Russian; for the tests
export const missingLanguageReads = (): number => missingReads;
export const setMissingLanguageHandler = (handler: () => void): void => {
  onMissing = handler;
};

export const currentLanguage = (): BotLanguage => {
  const language = store.getStore();
  if (language !== undefined) return language;
  missingReads += 1;
  onMissing();
  return DEFAULT_BOT_LANGUAGE;
};

export const runWithLanguage = <T>(language: BotLanguage, run: () => T): T =>
  store.run(language, run);

// Telegram id → language, the oldest entry out first. A row's language has no TTL: users.language
// changes only by the first /start's INSERT and by this bot's own POST /users/language, and one bot
// process polls. A user with no row yet keeps the Telegram client's language for `ttlMs` (#875).
export interface UserLanguages {
  get(telegramUserId: number): BotLanguage | undefined;
  set(telegramUserId: number, language: BotLanguage, ttlMs?: number): void;
  delete(telegramUserId: number): void;
}

export function createUserLanguages({
  maxEntries = LANGUAGE_CACHE_MAX,
  now = Date.now,
}: { maxEntries?: number; now?: () => number } = {}): UserLanguages {
  const entries = new Map<number, { language: BotLanguage; until?: number }>();
  return {
    get(telegramUserId) {
      const entry = entries.get(telegramUserId);
      if (entry === undefined) return undefined;
      entries.delete(telegramUserId);
      if (entry.until !== undefined && now() >= entry.until) return undefined;
      // a Map keeps insertion order: re-inserting makes the entry the newest
      entries.set(telegramUserId, entry);
      return entry.language;
    },
    set(telegramUserId, language, ttlMs) {
      entries.delete(telegramUserId);
      entries.set(
        telegramUserId,
        ttlMs === undefined ? { language } : { language, until: now() + ttlMs },
      );
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done !== true) entries.delete(oldest.value);
      }
    },
    delete(telegramUserId) {
      entries.delete(telegramUserId);
    },
  };
}

export interface LanguageMiddlewareOptions {
  backend: Pick<BackendClient, 'readLanguage'>;
  languages: UserLanguages;
  logger: Logger;
}

// Only an update the bot can answer with a text is worth a read: a private chat's message,
// button or chat-member update, an inline query and a pre-checkout query. A group's or channel's
// update is ignored by every handler, and chosen_inline_result only logs (manager's answer В1,
// 2026-10-18).
const answersWithText = (ctx: Context): boolean =>
  ctx.chat?.type === 'private' ||
  ctx.inlineQuery !== undefined ||
  ctx.preCheckoutQuery !== undefined;

async function languageOf(
  ctx: Context,
  from: NonNullable<Context['from']>,
  { backend, languages, logger }: LanguageMiddlewareOptions,
): Promise<BotLanguage> {
  const cached = languages.get(from.id);
  if (cached !== undefined) return cached;
  // the user's Telegram language: what the first /start would give them
  const fallback = botLanguageOf(from.language_code);
  if (!answersWithText(ctx)) return fallback;
  try {
    const language = await backend.readLanguage(String(from.id));
    languages.set(from.id, language);
    return language;
  } catch (error) {
    // no users row yet: the first /start writes it, and its answer fills the cache; until then the
    // fallback is kept a while, so each update before it does not read again (#875)
    if (error instanceof BackendError && error.reason === UserErrorCode.UserNotFound) {
      languages.set(from.id, fallback, LANGUAGE_MISSING_TTL_MS);
      return fallback;
    }
    // not cached, so the next update reads again
    logger.warn(
      { ...errorLogFields(error), ...backendErrorFields(error) },
      'user language not read',
    );
    return fallback;
  }
}

// Registered first on the bot, before chatType('private') and every composer: whatever handles
// the update reads its texts in the user's language.
export const languageMiddleware =
  (options: LanguageMiddlewareOptions) =>
  async (ctx: Context, next: NextFunction): Promise<void> => {
    const from = ctx.from;
    const language =
      from === undefined ? DEFAULT_BOT_LANGUAGE : await languageOf(ctx, from, options);
    await runWithLanguage(language, next);
  };

// /start, /menu, /settings and the login's recheck read the user's row anyway: its language goes
// into the cache, so the next update needs no read of its own.
export const rememberingLanguages = (
  backend: BackendClient,
  languages: UserLanguages,
): BackendClient => ({
  ...backend,
  async recordStart(request) {
    const user = await backend.recordStart(request);
    languages.set(Number(request.telegramUserId), user.language);
    return user;
  },
});
