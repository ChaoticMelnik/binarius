import { Composer, GrammyError, HttpError, InlineKeyboard, InputFile, type Context } from 'grammy';
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
import {
  durationOf,
  SESSION_START_PATTERN,
  sessionStartCallbackData,
  sessionStartDataOf,
  stakeMenuCallbackData,
} from './demo';
import {
  appendEndOfPath,
  backToAnalysisKeyboard,
  menuKeyboard,
  supportKeyboard,
  withMenu,
} from './keyboards';
import { telegramErrorFields, type Logger } from './logging';
import { editRefusal } from './screen';
import { editMessageTextByIdHtml, editMessageTextHtml, replyHtml, sendPhotoByIdHtml } from './send';
import { renderSessionCard, sessionCardModel, sessionCardSvg } from './session-card';
import { SESSION_NOT_FOUND, type SessionTracker } from './session-tracker';
import { LABELS, sessionAssetLabel, sessionStatusText, TEXTS, textOf } from './texts';

// The demo session (#284, docs/bot-session.md): the analysis screen's session button starts one
// through POST /trading/sessions, one status message follows it (session-tracker.ts), and its
// buttons read the session again or stop it. The trades themselves are the worker's (#287).

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
// `session:<uuid>` is 44 bytes and `session:stop:<uuid>` 49, inside the Bot API 64.
export const sessionRefreshCallbackData = (sessionId: string): string => `session:${sessionId}`;
export const sessionStopCallbackData = (sessionId: string): string => `session:stop:${sessionId}`;
export const SESSION_REFRESH_PATTERN = new RegExp(`^session:${UUID}$`);
export const SESSION_STOP_PATTERN = new RegExp(`^session:stop:${UUID}$`);

// A live session gets both buttons; a stopped one the refresh, since its last trade can still
// settle and move the counters, and «🔁 Ещё сессия» on its own pair and duration (#320), the
// session button's data, so the start handler checks it as any other. A duration the demo no
// longer offers has no such button.
export const sessionKeyboard = (
  view: Pick<TradingSessionView, 'id' | 'status' | 'settings'>,
): InlineKeyboard => {
  const keyboard = new InlineKeyboard().text(
    LABELS.sessionRefreshButton,
    sessionRefreshCallbackData(view.id),
  );
  if (view.status !== TradingSessionStatus.Stopped) {
    return keyboard.text(LABELS.sessionStopButton, sessionStopCallbackData(view.id));
  }
  return appendSessionEnd(keyboard, view.settings);
};

// A stopped session's next steps under `keyboard`'s rows: the again button while the demo offers
// its duration, then the end of the path; the menu alone when its settings could not be read.
function appendSessionEnd(
  keyboard: InlineKeyboard,
  settings: TradingSessionView['settings'],
): InlineKeyboard {
  if (settings === null) return withMenu(keyboard);
  const durationSec = durationOf(String(settings.durationSec));
  if (durationSec !== undefined) {
    keyboard
      .row()
      .text(LABELS.sessionAgainButton, sessionStartCallbackData(settings.assetId, durationSec));
  }
  return appendEndOfPath(keyboard, settings.assetId, settings.durationSec);
}

// Under the summary card (#318): the stopped status's next steps without «🔄 Обновить», which
// edits the text of the message it is under, and a photo has a caption instead. «📊 Новый
// анализ» and «📡 К сигналам» edit too: a photo's edit is refused as gone and their screen is
// answered anew (screen.ts).
export const sessionCardKeyboard = (view: Pick<TradingSessionView, 'settings'>): InlineKeyboard =>
  // withMenu on an empty keyboard keeps its empty first row; menuKeyboard() has none
  view.settings === null ? menuKeyboard() : appendSessionEnd(new InlineKeyboard(), view.settings);

export interface TradingSessionDeps {
  backend: Pick<
    BackendClient,
    | 'readPairs'
    | 'startSession'
    | 'readSession'
    | 'stopSession'
    | 'claimSessionSummary'
    | 'stopSessions'
  >;
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
  // the backend runs DEMO_ONLY (#396): a real session, refused before any write; the bot asks for
  // demo until #327
  [TradingSessionErrorCode.DemoOnly]: { text: 'tradingDemoOnly' },
  // reachable only if the bot's sessionFits and the backend's check drift apart
  [TradingSessionErrorCode.SessionTooLong]: { text: 'sessionTooLong' },
  [TradingSessionErrorCode.BalanceUnavailable]: { text: 'stakeBalanceMissing' },
  [TradingSessionErrorCode.PairUnavailable]: { text: 'sessionPairUnavailable' },
  // an old analysis message or «🔁 Ещё сессия» on a pair whose payout fell below the floor (#379)
  [TradingSessionErrorCode.PayoutTooLow]: { text: 'sessionPayoutTooLow' },
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
      // the start is a write: back to the analysis, whose session button starts the next one
      await replyHtml(ctx, TEXTS.sessionJustEnded, {
        reply_markup: backToAnalysisKeyboard(data.assetId, data.durationSec),
      });
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
      await replyReadFailure(ctx, sessionId, read.error, 'trading session status not read');
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
        await replyReadFailure(ctx, sessionId, read.error, 'trading session status not read');
        return;
      }
      view = read.value;
    } else {
      await replyReadFailure(ctx, sessionId, stopped.error, 'trading session not stopped');
      return;
    }
    await showInPlace(ctx, telegramUserId, symbolOf(catalog, view), view);
  });

  // /stop (#122): every active session of the user, one message whatever the count. No
  // confirmation and no retry, as the stop button: an unknown outcome shows in the session's own
  // status message, and a second /stop is harmless («Активных сессий нет.»). Every answer carries
  // «🏠 В меню» or the session's keyboard (Rule 31).
  composer.command('stop', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) return;
    const telegramUserId = String(from.id);
    const [stopped, catalog] = await Promise.all([
      settle(backend.stopSessions(telegramUserId)),
      settle(backend.readPairs()),
    ]);
    if (!stopped.ok) {
      logger.warn(
        { ...errorLogFields(stopped.error), ...backendErrorFields(stopped.error) },
        'trading sessions not stopped',
      );
      await replyHtml(ctx, TEXTS.unavailable, { reply_markup: menuKeyboard() });
      return;
    }
    const sessions = stopped.value;
    const [view] = sessions;
    if (view === undefined) {
      await replyHtml(ctx, TEXTS.sessionNoneActive, { reply_markup: menuKeyboard() });
      return;
    }
    if (sessions.length > 1) {
      await replyHtml(ctx, TEXTS.sessionsStopped({ count: String(sessions.length) }), {
        reply_markup: menuKeyboard(),
      });
      return;
    }
    const symbol = symbolOf(catalog, view);
    const sent = await replyHtml(ctx, sessionStatusText(symbol, view), {
      reply_markup: sessionKeyboard(view),
    });
    track(ctx, telegramUserId, symbol, view, sent.chat.id, sent.message_id);
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
      refusal.text === 'blocked'
        ? supportKeyboard()
        : refusal.connect === true
          ? connectKeyboard()
          : refusal.stakeMenu === true
            ? new InlineKeyboard().text(
                LABELS.stakeMenuButton,
                stakeMenuCallbackData(assetId, durationSec),
              )
            : backToAnalysisKeyboard(assetId, durationSec);
    await replyHtml(ctx, textOf(refusal.text), { reply_markup });
  }

  // A missing or foreign id is told as such and has nothing to read again; anything else is
  // logged and offers the session's read, the refresh, whether the press was the refresh or the
  // stop (a stop is a write and is not repeated).
  async function replyReadFailure(
    ctx: Context,
    sessionId: string,
    error: unknown,
    message: string,
  ): Promise<void> {
    const notFound = isHttpError(error, SESSION_NOT_FOUND);
    if (!notFound) logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, message);
    await replyHtml(ctx, notFound ? TEXTS.sessionStatusUnavailable : TEXTS.unavailable, {
      reply_markup: notFound
        ? menuKeyboard()
        : withMenu(
            new InlineKeyboard().text(
              LABELS.sessionRefreshButton,
              sessionRefreshCallbackData(sessionId),
            ),
          ),
    });
  }

  // The view in place of the message the button is under, then tracking on whichever message
  // shows it: after a restart the button is how tracking resumes, and a done session's entry
  // sends its summary card once and ends (#318).
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
    const botUsername = ctx.me.username;
    sessionTracker.track({
      sessionId: view.id,
      telegramUserId,
      symbol,
      view,
      edit: (text, current, end) =>
        editMessageTextByIdHtml(ctx.api, chatId, messageId, text, {
          reply_markup: end === 'not_found' ? menuKeyboard() : sessionKeyboard(current),
        }),
      card: (current) => sendCard(ctx, chatId, telegramUserId, symbol, botUsername, current),
    });
  }

  // The summary card (#318, docs/bot-session.md → The summary card): claimed once by the backend,
  // drawn here, sent under the final status. A refused claim sends nothing and says nothing; any
  // other failure is logged and not retried — a committed claim would answer 409 the second time.
  async function sendCard(
    ctx: Context,
    chatId: number,
    telegramUserId: string,
    symbol: string | null,
    botUsername: string,
    view: TradingSessionView,
  ): Promise<void> {
    try {
      const summary = await backend.claimSessionSummary(view.id, telegramUserId);
      if (summary === null) return;
      // a claimed session has a settled trade, so its last intent names the asset when the
      // settings could not be read
      const assetId = view.settings?.assetId ?? view.lastIntent?.assetId;
      if (assetId === undefined) throw new Error('a claimed session names no asset');
      const png = renderSessionCard(sessionCardSvg(sessionCardModel(summary, symbol, assetId)));
      await sendPhotoByIdHtml(
        ctx.api,
        chatId,
        new InputFile(png, 'session.png'),
        TEXTS.sessionCardCaption({
          symbol: sessionAssetLabel(symbol, assetId),
          profit: summary.result,
          botUsername,
        }),
        { reply_markup: sessionCardKeyboard(view) },
      );
    } catch (error) {
      logger.warn(
        {
          ...errorLogFields(error),
          ...(error instanceof BackendError
            ? backendErrorFields(error)
            : error instanceof GrammyError || error instanceof HttpError
              ? telegramErrorFields(error, 'sendPhoto')
              : {}),
          sessionId: view.id,
        },
        'trading session card not sent',
      );
    }
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
