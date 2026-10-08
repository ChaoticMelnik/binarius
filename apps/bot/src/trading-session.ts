import { Composer, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import {
  DEFAULT_SESSION_TRADES,
  errorLogFields,
  TradingSessionErrorCode,
  TradingSessionStatus,
  type BotStaticHtmlKey,
  type CreateTradingSessionRequest,
  type PairsCatalogResponse,
  type TradingSessionView,
} from '@binarius/shared';
import {
  BackendError,
  BackendErrorCode,
  backendErrorFields,
  type BackendClient,
  type StartSessionResult,
} from './backend-client';
import { SESSION_START_PATTERN, sessionStartDataOf, stakeMenuCallbackData } from './demo';
import { telegramErrorFields, type Logger } from './logging';
import { editRefusal } from './screen';
import { editMessageTextByIdHtml, editMessageTextHtml, replyHtml } from './send';
import { SESSION_NOT_FOUND, sessionTrackingDone, type SessionTracker } from './session-tracker';
import { LABELS, sessionStatusText, TEXTS, textOf } from './texts';

// The demo session (#284, docs/bot-session.md): the analysis screen's session button starts one
// through POST /trading/sessions, one status message follows it (session-tracker.ts), and its
// buttons read the session again or stop it. The trades themselves are the worker's (#287).

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
// `session:<uuid>` is 44 bytes and `session:stop:<uuid>` 49, inside the Bot API 64.
export const sessionRefreshCallbackData = (sessionId: string): string => `session:${sessionId}`;
export const sessionStopCallbackData = (sessionId: string): string => `session:stop:${sessionId}`;
export const SESSION_REFRESH_PATTERN = new RegExp(`^session:${UUID}$`);
export const SESSION_STOP_PATTERN = new RegExp(`^session:stop:${UUID}$`);

// A live session gets both buttons; a stopped one only the refresh, since its last trade can
// still settle and move the counters.
export const sessionKeyboard = (
  view: Pick<TradingSessionView, 'id' | 'status'>,
): InlineKeyboard => {
  const keyboard = new InlineKeyboard().text(
    LABELS.sessionRefreshButton,
    sessionRefreshCallbackData(view.id),
  );
  return view.status === TradingSessionStatus.Stopped
    ? keyboard
    : keyboard.text(LABELS.sessionStopButton, sessionStopCallbackData(view.id));
};

export interface TradingSessionDeps {
  backend: Pick<BackendClient, 'readPairs' | 'startSession' | 'readSession' | 'stopSession'>;
  logger: Logger;
  sessionTracker: Pick<SessionTracker, 'track'>;
  // the welcome's connect button, for a press with no account to trade on
  connectKeyboard: () => InlineKeyboard;
}

interface Refusal {
  text: BotStaticHtmlKey;
  connect?: true;
  // «💵 Сумма» under the text: a refusal of the saved stake itself (#297)
  stakeMenu?: true;
  // a refusal the bot never provokes: a bug, or a backend this bot does not know
  log?: true;
}

// Every refusal of POST /trading/sessions, by its code. Each is answered before a row is
// committed (docs/trading-session.md → Routes). Exhaustive: a code added to the contract fails
// tsc here.
export const START_REFUSALS = {
  [TradingSessionErrorCode.UserNotFound]: { text: 'unavailable', log: true },
  [TradingSessionErrorCode.UserBlocked]: { text: 'blocked' },
  [TradingSessionErrorCode.BrokerAccountNotFound]: { text: 'accountNone', connect: true },
  [TradingSessionErrorCode.AmbiguousBrokerAccount]: { text: 'statusAmbiguous' },
  [TradingSessionErrorCode.AccountRevoked]: { text: 'accountRevoked', connect: true },
  [TradingSessionErrorCode.AccountNotConfirmed]: { text: 'stakeAccountNotConfirmed' },
  [TradingSessionErrorCode.AccountHalted]: { text: 'stakeAccountHalted' },
  [TradingSessionErrorCode.InsufficientTokens]: { text: 'sessionInsufficientTokens' },
  [TradingSessionErrorCode.TradingPaused]: { text: 'tradingPaused' },
  // the bot asks for the backend's default mode, demo, which createTradingSession accepts
  [TradingSessionErrorCode.ModeNotAllowed]: { text: 'unavailable', log: true },
  // reachable only if the bot's sessionFits and the backend's check drift apart
  [TradingSessionErrorCode.SessionTooLong]: { text: 'sessionTooLong' },
  [TradingSessionErrorCode.BalanceUnavailable]: { text: 'stakeBalanceMissing' },
  [TradingSessionErrorCode.PairUnavailable]: { text: 'sessionPairUnavailable' },
  [TradingSessionErrorCode.CatalogUnavailable]: { text: 'demoCatalogUnavailable' },
  // the client returns it as { active }, so it never arrives here
  [TradingSessionErrorCode.ActiveSessionExists]: { text: 'unavailable', log: true },
  // answers of the read and stop routes, not of the start
  [TradingSessionErrorCode.NotFound]: { text: 'unavailable', log: true },
  [TradingSessionErrorCode.SessionNotActive]: { text: 'unavailable', log: true },
  // the saved stake against the account's snapshot (#297): the texts of the stake press, but the
  // session press reads no access, so the minimum is not named — the picker shows it
  [TradingSessionErrorCode.StakePrecision]: { text: 'stakePrecision', stakeMenu: true },
  [TradingSessionErrorCode.StakeBelowMinimum]: { text: 'stakeBelowBrokerMinimum', stakeMenu: true },
  [TradingSessionErrorCode.InsufficientDemoBalance]: {
    text: 'stakeAboveAvailable',
    stakeMenu: true,
  },
} as const satisfies Record<TradingSessionErrorCode, Refusal>;

const isStartRefusal = (reason: string | undefined): reason is TradingSessionErrorCode =>
  reason !== undefined && Object.hasOwn(START_REFUSALS, reason);

const isHttpError = (error: unknown, reason: string): boolean =>
  error instanceof BackendError &&
  error.code === BackendErrorCode.HttpStatus &&
  error.reason === reason;

// A 5xx, no answer, or a body that is not the contract's: the session may have been committed and
// the answer lost. Any 4xx, and the 503 catalog_unavailable, the start route answers before
// createTradingSession.
export const sessionOutcomeUnknown = (error: unknown): boolean =>
  error instanceof BackendError &&
  (error.code !== BackendErrorCode.HttpStatus || (error.status ?? 0) >= 500) &&
  !(error.status === 503 && error.reason === TradingSessionErrorCode.CatalogUnavailable);

type StartOutcome =
  { ok: true; result: StartSessionResult } | { ok: false; unknown: boolean; error: unknown };

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );

// the symbol only, so any catalog will do, a stale one included; null names the asset by its id
const symbolOf = (
  catalog: Settled<PairsCatalogResponse>,
  view: Pick<TradingSessionView, 'settings'>,
): string | null =>
  catalog.ok && view.settings !== null
    ? (catalog.value.pairs.find((pair) => pair.id === view.settings?.assetId)?.symbol ?? null)
    : null;

export function createTradingSessionComposer<C extends Context>({
  backend,
  logger,
  sessionTracker,
  connectKeyboard,
}: TradingSessionDeps): Composer<C> {
  const composer = new Composer<C>();

  composer.callbackQuery(SESSION_START_PATTERN, async (ctx) => {
    const data = sessionStartDataOf(ctx.match);
    if (data === undefined) {
      await answer(ctx);
      return;
    }
    const telegramUserId = String(ctx.from.id);
    const [, catalog] = await Promise.all([answer(ctx), settle(backend.readPairs())]);
    // trades sent explicitly, so the button's label, its check and the request use one number
    const request: CreateTradingSessionRequest = {
      telegramUserId,
      assetId: data.assetId,
      durationSec: data.durationSec,
      trades: DEFAULT_SESSION_TRADES,
    };
    // One more ask on an unknown outcome: a committed first attempt answers 409 with its session,
    // otherwise the session is created once.
    let started = await start(request);
    if (!started.ok && started.unknown) started = await start(request);
    if (!started.ok) {
      await replyStartFailure(ctx, started, data);
      return;
    }
    const { result } = started;
    // A session already running — another press, or our own first attempt — gets a new message,
    // and tracking moves to it (owner's decision).
    const view = 'started' in result ? result.started : result.active;
    if (view === null) {
      await replyHtml(ctx, TEXTS.sessionJustEnded);
      return;
    }
    const symbol = symbolOf(catalog, view);
    const sent = await replyHtml(ctx, sessionStatusText(symbol, view), {
      reply_markup: sessionKeyboard(view),
    });
    track(ctx, telegramUserId, symbol, view, sent.chat.id, sent.message_id);
  });

  composer.callbackQuery(SESSION_REFRESH_PATTERN, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const telegramUserId = String(ctx.from.id);
    const [, read, catalog] = await Promise.all([
      answer(ctx),
      settle(backend.readSession(sessionId, telegramUserId)),
      settle(backend.readPairs()),
    ]);
    if (!read.ok) {
      await replyReadFailure(ctx, read.error, 'trading session status not read');
      return;
    }
    await showInPlace(ctx, telegramUserId, symbolOf(catalog, read.value), read.value);
  });

  // No confirmation and no retry: an unknown outcome leaves the refresh button to show the truth,
  // and a second stop is harmless (409 → the session read).
  composer.callbackQuery(SESSION_STOP_PATTERN, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const telegramUserId = String(ctx.from.id);
    const [, stopped, catalog] = await Promise.all([
      answer(ctx),
      settle(backend.stopSession(sessionId, telegramUserId)),
      settle(backend.readPairs()),
    ]);
    let view: TradingSessionView;
    if (stopped.ok) {
      view = stopped.value;
    } else if (isHttpError(stopped.error, TradingSessionErrorCode.SessionNotActive)) {
      // it had ended already: show how
      const read = await settle(backend.readSession(sessionId, telegramUserId));
      if (!read.ok) {
        await replyReadFailure(ctx, read.error, 'trading session status not read');
        return;
      }
      view = read.value;
    } else {
      await replyReadFailure(ctx, stopped.error, 'trading session not stopped');
      return;
    }
    await showInPlace(ctx, telegramUserId, symbolOf(catalog, view), view);
  });

  async function start(request: CreateTradingSessionRequest): Promise<StartOutcome> {
    try {
      return { ok: true, result: await backend.startSession(request) };
    } catch (error) {
      return { ok: false, unknown: sessionOutcomeUnknown(error), error };
    }
  }

  async function replyStartFailure(
    ctx: Context,
    failure: Extract<StartOutcome, { ok: false }>,
    { assetId, durationSec }: NonNullable<ReturnType<typeof sessionStartDataOf>>,
  ): Promise<void> {
    const reason = failure.error instanceof BackendError ? failure.error.reason : undefined;
    const known =
      !failure.unknown &&
      failure.error instanceof BackendError &&
      failure.error.code === BackendErrorCode.HttpStatus &&
      isStartRefusal(reason);
    const refusal: Refusal = known
      ? START_REFUSALS[reason]
      : { text: failure.unknown ? 'sessionOutcomeUnknown' : 'unavailable', log: true };
    if (refusal.log === true) {
      logger.warn(
        { ...errorLogFields(failure.error), ...backendErrorFields(failure.error) },
        'trading session not started',
      );
    }
    const reply_markup =
      refusal.connect === true
        ? connectKeyboard()
        : refusal.stakeMenu === true
          ? new InlineKeyboard().text(
              LABELS.stakeMenuButton,
              stakeMenuCallbackData(assetId, durationSec),
            )
          : undefined;
    await replyHtml(ctx, textOf(refusal.text), reply_markup === undefined ? {} : { reply_markup });
  }

  // a missing or foreign id is told as such; anything else is logged
  async function replyReadFailure(ctx: Context, error: unknown, message: string): Promise<void> {
    const notFound = isHttpError(error, SESSION_NOT_FOUND);
    if (!notFound) logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, message);
    await replyHtml(ctx, notFound ? TEXTS.sessionStatusUnavailable : TEXTS.unavailable);
  }

  // The view in place of the message the button is under, then tracking on whichever message
  // shows it, unless the session is done: after a restart the button is how tracking resumes.
  async function showInPlace(
    ctx: Context,
    telegramUserId: string,
    symbol: string | null,
    view: TradingSessionView,
  ): Promise<void> {
    const text = sessionStatusText(symbol, view);
    const reply_markup = sessionKeyboard(view);
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery?.message?.message_id;
    try {
      await editMessageTextHtml(ctx, text, { reply_markup });
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'gone') {
        const sent = await replyHtml(ctx, text, { reply_markup });
        track(ctx, telegramUserId, symbol, view, sent.chat.id, sent.message_id);
        return;
      }
      if (refusal !== 'shown') {
        if (!(error instanceof HttpError)) throw error;
        logger.warn(
          { ...errorLogFields(error), ...telegramErrorFields(error, 'editMessageText') },
          'trading session message not edited',
        );
        return;
      }
    }
    if (chatId !== undefined && messageId !== undefined) {
      track(ctx, telegramUserId, symbol, view, chatId, messageId);
    }
  }

  function track(
    ctx: Context,
    telegramUserId: string,
    symbol: string | null,
    view: TradingSessionView,
    chatId: number,
    messageId: number,
  ): void {
    if (sessionTrackingDone(view)) return;
    sessionTracker.track({
      sessionId: view.id,
      telegramUserId,
      symbol,
      view,
      edit: (text, current) =>
        editMessageTextByIdHtml(ctx.api, chatId, messageId, text, {
          reply_markup: sessionKeyboard(current),
        }),
    });
  }

  async function answer(ctx: Context): Promise<void> {
    await ctx.answerCallbackQuery().catch((error: unknown) => {
      logger.warn(
        { ...errorLogFields(error), ...telegramErrorFields(error, 'answerCallbackQuery') },
        'answering the callback query failed',
      );
    });
  }

  return composer;
}
