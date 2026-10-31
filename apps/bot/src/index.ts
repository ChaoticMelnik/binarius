import pino from 'pino';
import {
  BOT_TEXTS_REFRESH_MS,
  cashierUrlOf,
  createBotTextRefresher,
  logOptions,
} from '@binarius/shared';
import { backendErrorFields, createBackendClient } from './backend-client';
import { createBot } from './bot';
import { parseEnv } from './env';
import { createIntentTracker } from './intent-tracker';
import { runBot } from './lifecycle';
import { createPollingLoop } from './polling';
import { createSessionResumer } from './session-resume';
import { createSessionTracker } from './session-tracker';
import { createShownSignals } from './shown-signals';
import { createSignalWaiter } from './signal-wait';
import { setBotTextSources } from './texts';
import {
  BACKEND_REQUEST_TIMEOUT_MS,
  INTENT_TRACK_DEADLINE_MS,
  INTENT_TRACK_FIRST_POLL_MS,
  INTENT_TRACK_POLL_MS,
  POLLING_CONCURRENCY,
  POLLING_RETRY_MS,
  SESSION_RESUME_GAP_MS,
  SESSION_RESUME_INTERVAL_MS,
  SESSION_TRACK_DEADLINE_MS,
  SESSION_TRACK_FIRST_POLL_MS,
  SESSION_TRACK_POLL_MS,
  SIGNAL_WAIT_CAPTION_EDITS_PER_TICK,
  SIGNAL_WAIT_CAPTION_MS,
  SIGNAL_WAIT_EDIT_FAILURES_MAX,
  SIGNAL_WAIT_CHAT_EDIT_GAP_MS,
  SIGNAL_WAIT_EDIT_BURST,
  SIGNAL_WAIT_EDIT_GAP_MS,
  SIGNAL_WAIT_EDITS_PER_SECOND,
  SIGNAL_WAIT_RESOLVE_CONCURRENCY,
  SIGNAL_WAIT_MAX_MS,
  SIGNAL_WAIT_POLL_MS,
  SIGNAL_WAIT_POLL_OFFSET_MS,
  SIGNAL_WAIT_SHUTDOWN_BUDGET_MS,
  SIGNALS_LIST_TTL_MS,
} from './timing';
import { setMissingLanguageHandler } from './language';

const env = parseEnv(process.env);

const logger = pino(logOptions(env.logLevel));

// Telegram opens a Mini App over https only: local dev runs without «💳 Пополнить» (#27)
const cashierUrl = cashierUrlOf(env.webPublicUrl);
if (cashierUrl === undefined) logger.warn('cashier button off: WEB_PUBLIC_URL is not https');
// the promo card needs a channel to get its file id from (#538): none, no «📤 Поделиться»
if (env.shareStorageChatId === undefined) {
  logger.warn('share button off: SHARE_STORAGE_CHAT_ID is not set');
}

const backend = createBackendClient({ baseUrl: env.backendUrl, token: env.internalApiToken });

// A text read outside any update's language is shown in Russian (#508, language.ts): logged once
// per process, the canary for a sender this bot does not yet run under runWithLanguage.
let missingLanguageLogged = false;
setMissingLanguageHandler(() => {
  if (missingLanguageLogged) return;
  missingLanguageLogged = true;
  logger.warn('text read outside a language context, Russian shown');
});

const intentTracker = createIntentTracker({
  backend,
  logger,
  firstPollMs: INTENT_TRACK_FIRST_POLL_MS,
  pollMs: INTENT_TRACK_POLL_MS,
  deadlineMs: INTENT_TRACK_DEADLINE_MS,
});

const sessionTracker = createSessionTracker({
  backend,
  logger,
  firstPollMs: SESSION_TRACK_FIRST_POLL_MS,
  pollMs: SESSION_TRACK_POLL_MS,
  deadlineMs: SESSION_TRACK_DEADLINE_MS,
  resumeGapMs: SESSION_RESUME_GAP_MS,
});

// tracks the sessions again after a restart (#567); createBot hands it the session composer's resume
const sessionResumer = createSessionResumer({
  backend,
  tracker: sessionTracker,
  logger,
  intervalMs: SESSION_RESUME_INTERVAL_MS,
});

// the directions the bot showed (#829): written by the screens and the wait, taken by the start
const shownSignals = createShownSignals();

// the wait for a signal (#664); createBot hands it the demo's screens
const signalWaiter = createSignalWaiter({
  backend,
  logger,
  shownSignals,
  pollMs: SIGNAL_WAIT_POLL_MS,
  pollOffsetMs: SIGNAL_WAIT_POLL_OFFSET_MS,
  listTtlMs: SIGNALS_LIST_TTL_MS,
  maxMs: SIGNAL_WAIT_MAX_MS,
  editGapMs: SIGNAL_WAIT_EDIT_GAP_MS,
  editsPerSecond: SIGNAL_WAIT_EDITS_PER_SECOND,
  editBurst: SIGNAL_WAIT_EDIT_BURST,
  chatGapMs: SIGNAL_WAIT_CHAT_EDIT_GAP_MS,
  resolveConcurrency: SIGNAL_WAIT_RESOLVE_CONCURRENCY,
  captionMs: SIGNAL_WAIT_CAPTION_MS,
  captionEditsPerTick: SIGNAL_WAIT_CAPTION_EDITS_PER_TICK,
  editFailuresMax: SIGNAL_WAIT_EDIT_FAILURES_MAX,
  shutdownBudgetMs: SIGNAL_WAIT_SHUTDOWN_BUDGET_MS,
});

// the texts with their overrides, from the first load on (docs/bot-texts.md → Loading)
const botTexts = createBotTextRefresher({
  load: () => backend.readBotTexts(),
  intervalMs: BOT_TEXTS_REFRESH_MS,
  budgetMs: BACKEND_REQUEST_TIMEOUT_MS,
  apply: setBotTextSources,
  logger,
  failureFields: backendErrorFields,
});
botTexts.start();

const bot = createBot({
  token: env.telegramBotToken,
  backend,
  logger,
  welcomeVideoFileId: env.welcomeVideoFileId,
  cashierUrl,
  shareStorageChatId: env.shareStorageChatId,
  intentTracker,
  sessionTracker,
  sessionResumer,
  signalWaiter,
  shownSignals,
});

runBot({
  bot: createPollingLoop({
    bot,
    concurrency: POLLING_CONCURRENCY,
    retryMs: POLLING_RETRY_MS,
    logger,
  }),
  tracker: intentTracker,
  sessionTracker,
  sessionResumer: {
    start: () => sessionResumer.start(bot.api),
    stop: () => sessionResumer.stop(),
  },
  signalWaiter,
  botTexts,
  logger,
  exit: (code) => process.exit(code),
});
