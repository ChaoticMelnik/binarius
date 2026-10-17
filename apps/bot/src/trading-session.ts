import {
  Composer,
  GrammyError,
  HttpError,
  InlineKeyboard,
  InputFile,
  type Api,
  type Context,
} from 'grammy';
import type { Message } from 'grammy/types';
import {
  deleteRefusal,
  editRefusal,
  DEFAULT_SESSION_CYCLES,
  errorLogFields,
  pairLabel,
  SESSION_STOP_PATTERN,
  TradeMode,
  TradingModeErrorCode,
  TradingSessionErrorCode,
  TradingSessionStopReason,
  type BotStaticHtmlKey,
  type CreateTradingSessionRequest,
  type PairLabel,
  type PairsCatalogResponse,
  type SetTradingModeResponse,
  type TelegramHtml,
  type TrackedSession,
  type TradeAction,
  type TradingSessionView,
  telegramErrorFields,
} from '@binarius/shared';
import {
  BackendError,
  BackendErrorCode,
  backendErrorFields,
  type BackendClient,
  type StartSessionResult,
} from './backend-client';
import {
  demoLaunchCallbackData,
  durationOf,
  otherPairKeyboard,
  removeLegacyKeyboard,
  SESSION_START_PATTERN,
  sessionStartCallbackData,
  sessionStartDataOf,
  stakeMenuCallbackData,
} from './demo';
import {
  appendEndOfPath,
  backToAnalysisKeyboard,
  depositButtons,
  inviteButton,
  MODE_CALLBACK_DATA,
  menuKeyboard,
  supportKeyboard,
  waitingStopKeyboard,
  withBuy,
  withInvite,
  withMenu,
} from './keyboards';
import type { Logger } from './logging';
import {
  editMessagePhotoByIdHtml,
  editMessagePhotoByIdHtmlWithoutNextStep,
  editMessageTextByIdHtml,
  editMessageTextByIdHtmlWithoutNextStep,
  editMessageTextHtml,
  NO_NEXT_STEP_REASONS,
  replyHtml,
  replyHtmlWithoutNextStep,
  replyWithPhotoHtmlWithoutNextStep,
  sendPhotoByIdHtml,
} from './send';
import { renderSessionCard, sessionCardModel, sessionCardSvg } from './session-card';
import { attachShareButton } from './session-share';
import {
  SESSION_NOT_FOUND,
  type SessionDrawing,
  sessionDrawing,
  sessionEditMethod,
  type SessionTracker,
} from './session-tracker';
import type { SetupCardPhotos } from './setup-card';
import {
  LABELS,
  sessionAgainButtonLabel,
  sessionAssetLabel,
  sessionStatusText,
  sessionStopReplyText,
  TEXTS,
  textOf,
} from './texts';

// The session (#284, docs/bot-session.md), demo or real by the button's mode (#327): the session
// buttons start one through POST /trading/sessions, one session message without buttons follows it
// (session-tracker.ts), and the «⏹» under the backend's waiting message stops it (#536), its reply
// drawn in place of that message (#587). The trades
// themselves are the worker's (#287), their messages the backend's (#464). The launch screen (#418)
// and the amount screen of a demo cycle (#476) are deleted once the session message is sent.

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
// The old status message's «🔄 Обновить» (before #536): its press only strips that keyboard.
const LEGACY_SESSION_REFRESH_PATTERN = new RegExp(`^session:${UUID}$`);

// A stopped session's next steps under `keyboard`'s rows: «🔁 Ещё сессия» on its own pair,
// duration and mode (#320, #327) - in real the session button's data, so the start handler checks
// it as any other; in demo the amount screen (#476) - while the demo offers its duration, then the
// end of the path with «💳 Пополнить» (#27) and «👥 Пригласить друга»
// (#115) in one row right above the menu; the deposit, the invite and the menu alone when its settings could
// not be read. A no_signal_timeout stop (#509) offers another pair instead of the same one again.
function appendSessionEnd(
  keyboard: InlineKeyboard,
  { mode, settings, stopReason }: Pick<TradingSessionView, 'mode' | 'settings' | 'stopReason'>,
  cashierUrl: string | undefined,
): InlineKeyboard {
  if (settings === null) return withInvite(keyboard, cashierUrl);
  const otherPair = stopReason === TradingSessionStopReason.NoSignalTimeout;
  const durationSec = durationOf(String(settings.durationSec));
  if (durationSec !== undefined && !otherPair) {
    // a demo session's again opens the amount screen (#476) as a new message, so this one stays
    keyboard
      .row()
      .text(
        sessionAgainButtonLabel(mode),
        mode === TradeMode.Demo
          ? demoLaunchCallbackData(settings.assetId, durationSec, 'n')
          : sessionStartCallbackData(mode, settings.assetId, durationSec),
      );
  }
  return appendEndOfPath(
    keyboard,
    settings.assetId,
    settings.durationSec,
    [[...depositButtons(cashierUrl), inviteButton()]],
    { otherPair },
  );
}

// A stopped session's next steps: under the summary card (#318), under the reply to its stop and
// under an old status message the stop drew in place (#536). «📊 Новый анализ» and «📡 К
// сигналам» edit the message they are under: a photo's edit is refused as gone and their screen
// is answered anew (telegram-refusals.ts in @binarius/shared).
export const sessionCardKeyboard = (
  view: Pick<TradingSessionView, 'mode' | 'settings' | 'stopReason'>,
  cashierUrl: string | undefined,
): InlineKeyboard => appendSessionEnd(new InlineKeyboard(), view, cashierUrl);

export interface TradingSessionDeps {
  backend: Pick<
    BackendClient,
    | 'readPairs'
    | 'startSession'
    | 'readSession'
    | 'stopSession'
    | 'claimSessionSummary'
    | 'stopSessions'
    | 'setTradingMode'
  >;
  logger: Logger;
  sessionTracker: Pick<SessionTracker, 'track'>;
  // the welcome's connect button, for a press with no account to trade on
  connectKeyboard: () => InlineKeyboard;
  // «💳 Пополнить»'s page (#27): cashierUrlOf's; none, no button
  cashierUrl?: string;
  // the pictures of a signal's direction, shared with the analysis card (#568)
  setupCardPhotos: SetupCardPhotos;
  // «📤 Поделиться» under the card (#538): only with the storage channel the promo card is posted to
  shareEnabled: boolean;
}

interface Refusal {
  text: BotStaticHtmlKey;
  // the text for a real session's press, where the default names the demo account (#327)
  real?: BotStaticHtmlKey;
  connect?: true;
  // «⭐ Купить токены» above the way back: a refusal for want of tokens (#117)
  buy?: true;
  // «💵 Сумма» under the text: a refusal of the saved stake itself (#297)
  stakeMenu?: true;
  // «🔀 Выбрать другую пару» and the menu: the pair has no signal now (#509)
  otherPair?: true;
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
  [TradingSessionErrorCode.InsufficientTokens]: { text: 'sessionInsufficientTokens', buy: true },
  [TradingSessionErrorCode.TradingPaused]: { text: 'tradingPaused' },
  // a button drawn in the other mode, or a switch between the render and the press (#327): refused
  // before any write, the analysis drawn anew carries the user's mode
  [TradingSessionErrorCode.ModeNotAllowed]: { text: 'stakeAmountChanged' },
  // the backend runs DEMO_ONLY (#396): a real session, refused before any write; the bot does not
  // know the flag and draws the real doors as for the real stake button
  [TradingSessionErrorCode.DemoOnly]: { text: 'tradingDemoOnly' },
  // reachable only if the bot's sessionFits and the backend's check drift apart
  [TradingSessionErrorCode.SessionTooLong]: { text: 'sessionTooLong' },
  [TradingSessionErrorCode.BalanceUnavailable]: { text: 'stakeBalanceMissing' },
  [TradingSessionErrorCode.PairUnavailable]: { text: 'sessionPairUnavailable' },
  // an old analysis message or «🔁 Ещё сессия» on a pair whose payout fell below the floor (#379)
  [TradingSessionErrorCode.PayoutTooLow]: { text: 'sessionPayoutTooLow' },
  [TradingSessionErrorCode.CatalogUnavailable]: { text: 'demoCatalogUnavailable' },
  // an old «🔁 Ещё сессия», the offer under a single trade or a real launch screen on a pair with
  // no signal now (#509); both answered before any row is written
  [TradingSessionErrorCode.NoSignal]: { text: 'sessionNoSignal', otherPair: true },
  [TradingSessionErrorCode.SignalUnavailable]: { text: 'sessionSignalUnavailable' },
  // the client returns it as { active }, so it never arrives here
  [TradingSessionErrorCode.ActiveSessionExists]: { text: 'unavailable', log: true },
  // answers of the read and stop routes, not of the start
  [TradingSessionErrorCode.NotFound]: { text: 'unavailable', log: true },
  [TradingSessionErrorCode.SessionNotActive]: { text: 'unavailable', log: true },
  // the saved stake against the account's snapshot (#297): the texts of the stake press, but the
  // session press reads no access, so the minimum is not named — the picker shows it
  [TradingSessionErrorCode.StakePrecision]: { text: 'stakePrecision', stakeMenu: true },
  [TradingSessionErrorCode.StakeBelowMinimum]: { text: 'stakeBelowBrokerMinimum', stakeMenu: true },
  [TradingSessionErrorCode.InsufficientBalance]: {
    text: 'stakeAboveAvailable',
    real: 'stakeAboveAvailableReal',
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
// the answer lost. Any 4xx, and the 503s catalog_unavailable and signal_unavailable (#509), the
// start route answers before createTradingSession.
const KNOWN_503: ReadonlySet<string> = new Set([
  TradingSessionErrorCode.CatalogUnavailable,
  TradingSessionErrorCode.SignalUnavailable,
]);
export const sessionOutcomeUnknown = (error: unknown): boolean =>
  error instanceof BackendError &&
  (error.code !== BackendErrorCode.HttpStatus || (error.status ?? 0) >= 500) &&
  !(error.status === 503 && error.reason !== undefined && KNOWN_503.has(error.reason));

type StartOutcome =
  { ok: true; result: StartSessionResult } | { ok: false; unknown: boolean; error: unknown };

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );

// the pair's label only, so any catalog will do, a stale one included; null names the asset by
// its id, as does no catalog read
const symbolOf = (
  catalog: Settled<PairsCatalogResponse> | undefined,
  view: Pick<TradingSessionView, 'settings'>,
): PairLabel | null => {
  const pair =
    catalog?.ok === true && view.settings !== null
      ? catalog.value.pairs.find((listed) => listed.id === view.settings?.assetId)
      : undefined;
  return pair === undefined ? null : pairLabel(pair);
};

// What a session start needs (#476): the session button's data, the catalog read beside it (the
// status's symbol), whether an unknown outcome is asked once more, and whether the pressed message
// is a screen to delete once the status is sent (#418).
export type SessionStartData = Pick<
  NonNullable<ReturnType<typeof sessionStartDataOf>>,
  'mode' | 'assetId' | 'durationSec'
>;
// Tracks a session again on its recorded status message after a restart (#567,
// session-resume.ts): the same entry a press makes, with no view read yet, the deadline from the
// session's start, and the message already recorded. The label is the catalog's, or null.
export type ResumeSession = (
  api: Api,
  botUsername: string,
  session: TrackedSession,
  label: PairLabel | null,
) => void;

export type StartSession = (
  ctx: Context,
  data: SessionStartData,
  catalog: Settled<PairsCatalogResponse>,
  options: { retryUnknown: boolean; removeScreen: boolean },
) => Promise<void>;

export function createTradingSessionComposer<C extends Context>({
  backend,
  logger,
  sessionTracker,
  connectKeyboard,
  cashierUrl,
  setupCardPhotos,
  shareEnabled,
}: TradingSessionDeps): {
  composer: Composer<C>;
  startSession: StartSession;
  resume: ResumeSession;
} {
  const composer = new Composer<C>();

  composer.callbackQuery(SESSION_START_PATTERN, async (ctx) => {
    const data = sessionStartDataOf(ctx.match);
    if (data === undefined) {
      await answer(ctx);
      return;
    }
    const [, catalog] = await Promise.all([answer(ctx), settle(backend.readPairs())]);
    await startSession(ctx, data, catalog, { retryUnknown: true, removeScreen: data.launch });
  });

  // The one start path: the session button, and the amount screen's press and typed amount
  // (cycle-stake.ts, #476).
  async function startSession(
    ctx: Context,
    data: SessionStartData,
    catalog: Settled<PairsCatalogResponse>,
    { retryUnknown, removeScreen }: { retryUnknown: boolean; removeScreen: boolean },
  ): Promise<void> {
    const from = ctx.from;
    if (from === undefined) return;
    const telegramUserId = String(from.id);
    // cycles sent explicitly, so the button's label, its check and the request use one number
    const request: CreateTradingSessionRequest = {
      telegramUserId,
      mode: data.mode,
      assetId: data.assetId,
      durationSec: data.durationSec,
      cycles: DEFAULT_SESSION_CYCLES,
    };
    // One more ask on an unknown outcome: a committed first attempt answers 409 with its session,
    // otherwise the session is created once. The amount press asks once (#476): its delete of the
    // screen leaves no room for a second ask in HANDLER_CALLS, and pressing it again is safe.
    let started = await start(request);
    if (retryUnknown && !started.ok && started.unknown) started = await start(request);
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
    const { sent, photoRefused } = await sendSessionMessage(ctx, sessionDrawing(symbol, view));
    track(ctx, telegramUserId, symbol, view, sent.chat.id, sent.message_id);
    // the text after a refused photo took the delete's call (HANDLER_CALLS.sessionStart): the
    // screen stays, and its button pressed again answers 409 with this session
    if (removeScreen && !photoRefused) {
      await removeLaunchScreen(ctx);
    }
  }

  // The session message, without a keyboard (#536): the backend's waiting message under it
  // carries the «⏹». With a signal's direction it is that direction's picture with the text as
  // its caption (#568); a refused photo (a stale file_id among others) forgets its file_id and
  // sends the same text as a message. A transport failure is thrown, as a text's is: a second
  // message after an unknown delivery could be a duplicate (#126).
  async function sendSessionMessage(
    ctx: Context,
    { text, picture: signalAction }: SessionDrawing,
  ): Promise<{ sent: { chat: { id: number }; message_id: number }; photoRefused: boolean }> {
    const reason = NO_NEXT_STEP_REASONS.SessionStatus;
    if (signalAction === null) {
      return { sent: await replyHtmlWithoutNextStep(ctx, text, reason), photoRefused: false };
    }
    const photo = setupCardPhotos.photo(signalAction);
    try {
      const sent = await replyWithPhotoHtmlWithoutNextStep(ctx, photo, text, reason);
      setupCardPhotos.remember(signalAction, sent);
      return { sent, photoRefused: false };
    } catch (error) {
      if (!(error instanceof GrammyError)) throw error;
      setupCardPhotos.forget(signalAction);
      logger.warn(
        {
          ...errorLogFields(error),
          ...telegramErrorFields(error),
          byFileId: typeof photo === 'string',
        },
        'the session photo was refused, sending its text',
      );
      return { sent: await replyHtmlWithoutNextStep(ctx, text, reason), photoRefused: true };
    }
  }

  // The session picture's edit by editMessageMedia (#568): an answer with the photo remembers its
  // file_id; a refusal other than shown, gone or 403 forgets it, so the next poll uploads the file
  // (a stale file_id is not told apart from other refusals); the tracker classifies the error.
  async function editSessionPhoto(
    action: TradeAction,
    edit: (photo: string | InputFile) => Promise<Message | true>,
  ): Promise<Message | true> {
    try {
      const result = await edit(setupCardPhotos.photo(action));
      setupCardPhotos.remember(action, result);
      return result;
    } catch (error) {
      if (error instanceof GrammyError) {
        const refusal = editRefusal(error);
        if (refusal !== 'shown' && refusal !== 'gone' && error.error_code !== 403) {
          setupCardPhotos.forget(action);
        }
      }
      throw error;
    }
  }

  // an old status message's «🔄 Обновить» (#536): its keyboard stripped, nothing read or sent
  composer.callbackQuery(LEGACY_SESSION_REFRESH_PATTERN, (ctx) =>
    removeLegacyKeyboard(ctx, logger),
  );

  // «⏹ Остановить сессию». No confirmation and no retry: a second stop is harmless (409 → the
  // session read). Under the waiting message (`:w`, #536) the stop names the pressed message, so the
  // backend takes it over from its sender (#587), and the reply - or a failure - is drawn in its
  // place: the summary the backend sends next comes under it. Under an old status message (no
  // `:w`) the reply is drawn in its place, as before #536, and tracked.
  composer.callbackQuery(SESSION_STOP_PATTERN, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const waiting = ctx.match[2] !== undefined;
    const telegramUserId = String(ctx.from.id);
    const pressed = waiting ? ctx.callbackQuery.message?.message_id : undefined;
    const [, stopped, catalog] = await Promise.all([
      answer(ctx),
      settle(backend.stopSession(sessionId, telegramUserId, pressed)),
      waiting ? undefined : settle(backend.readPairs()),
    ]);
    let view: TradingSessionView;
    if (stopped.ok) {
      view = stopped.value;
    } else if (isHttpError(stopped.error, TradingSessionErrorCode.SessionNotActive)) {
      // it had ended already: show how
      const read = await settle(backend.readSession(sessionId, telegramUserId));
      if (!read.ok) {
        await stopFailure(ctx, read.error, 'trading session status not read', waiting && {});
        return;
      }
      view = read.value;
    } else {
      const again = waiting && { sessionId };
      await stopFailure(ctx, stopped.error, 'trading session not stopped', again);
      return;
    }
    if (waiting) {
      // A press starts no tracking: the session message is tracked from its start in this
      // process, or by #567's pass once its id is recorded; one whose id is not recorded gets no
      // card (docs/bot-session.md risk 56)
      await drawStopReply(
        ctx,
        sessionStopReplyText(view),
        sessionCardKeyboard(view, cashierUrl),
        'the pressed message was already gone',
      );
      return;
    }
    await showInPlace(ctx, telegramUserId, symbolOf(catalog, view), view);
  });

  // /stop (#122): every active session of the user, one message whatever the count, and the user
  // back in demo (#473): a line before that message when the mode changed or the switch failed. No
  // confirmation and no retry, as the stop button: an unknown outcome shows in the session's own
  // message, and a second /stop is harmless («Активных сессий нет.»). Every answer carries
  // «🏠 В меню» or the session's end of the path (Rule 31).
  composer.command('stop', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) return;
    const telegramUserId = String(from.id);
    // the switch after the stop, never beside it: a switch out of real stops the sessions itself
    // (#327), and a stop that came second would answer «Активных сессий нет.» about them
    const stopped = await settle(backend.stopSessions(telegramUserId));
    const reset = await settle(backend.setTradingMode(telegramUserId, TradeMode.Demo));
    await replyModeReset(ctx, reset);
    await replyStopped(ctx, stopped);
  });

  // the message of #122, unchanged by #473; one session's is the reply to its «⏹» (#536)
  async function replyStopped(
    ctx: Context,
    stopped: Settled<Awaited<ReturnType<BackendClient['stopSessions']>>>,
  ): Promise<void> {
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
    await replyHtml(ctx, sessionStopReplyText(view), {
      reply_markup: sessionCardKeyboard(view, cashierUrl),
    });
  }

  // The mode line of /stop (#473); its `stoppedSessions` is not read, the stop before it answered
  // for the sessions. No users row has no mode to reset. A 4xx is a refusal before the write; any
  // other failure, a throw that is not the client's included, may have committed: unlike the mode
  // screen's outcomeUnknown, /stop has no screen to fall back to, so «не переключён» is said only
  // when proven.
  async function replyModeReset(ctx: Context, reset: Settled<SetTradingModeResponse>) {
    let text: TelegramHtml;
    let keyboard: InlineKeyboard;
    if (reset.ok) {
      if (!reset.value.changed) return;
      text = TEXTS.modeStopReset;
      keyboard = menuKeyboard();
    } else {
      const { error } = reset;
      if (isHttpError(error, TradingModeErrorCode.UserNotFound)) return;
      const fields = { ...errorLogFields(error), ...backendErrorFields(error) };
      if (
        error instanceof BackendError &&
        error.code === BackendErrorCode.HttpStatus &&
        (error.status ?? 0) < 500
      ) {
        logger.warn(fields, 'trading mode not reset');
        text = TEXTS.modeNotReset;
        keyboard = menuKeyboard();
      } else {
        logger.warn(fields, 'trading mode outcome unknown');
        text = TEXTS.modeOutcomeUnknown;
        keyboard = withMenu(new InlineKeyboard().text(LABELS.modeScreenButton, MODE_CALLBACK_DATA));
      }
    }
    await replyHtml(ctx, text, { reply_markup: keyboard }).catch((error: unknown) => {
      logger.warn(
        { ...errorLogFields(error), ...telegramErrorFields(error, 'sendMessage') },
        'trading mode line not sent',
      );
    });
  }

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
    { mode, assetId, durationSec }: SessionStartData,
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
                stakeMenuCallbackData(mode, assetId, durationSec),
              )
            : refusal.buy === true
              ? withBuy(backToAnalysisKeyboard(assetId, durationSec), cashierUrl)
              : refusal.otherPair === true
                ? otherPairKeyboard(durationSec)
                : backToAnalysisKeyboard(assetId, durationSec);
    const text =
      mode === TradeMode.Real && refusal.real !== undefined ? refusal.real : refusal.text;
    await replyHtml(ctx, textOf(text), { reply_markup });
  }

  // A missing or foreign id is told as such; anything else is logged. The stop is a write and is
  // not repeated. Under an old status message the failure is a reply with the menu, and the pressed
  // message stays, its «⏹» pressed again is safe (409 → the session read). Under the waiting
  // message (`inPlace`, #587) it is drawn in place of the pressed message, never as a message under
  // it: a stop whose outcome is unknown (`inPlace.sessionId`) keeps the one «⏹» for another press,
  // a missing session or a failed read after a 409 the menu. Refused as gone: the same text as a
  // new message under «🏠 В меню» - the bot draws «⏹» only in place of the pressed message, never
  // as a second «⏹» beside the sender's next one (#587 round 1).
  async function stopFailure(
    ctx: Context,
    error: unknown,
    message: string,
    inPlace: false | { sessionId?: string },
  ): Promise<void> {
    const notFound = isHttpError(error, SESSION_NOT_FOUND);
    if (!notFound) logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, message);
    const text = notFound ? TEXTS.sessionStatusUnavailable : TEXTS.unavailable;
    if (inPlace === false) {
      await replyHtml(ctx, text, { reply_markup: menuKeyboard() });
      return;
    }
    const keyboard =
      notFound || inPlace.sessionId === undefined
        ? menuKeyboard()
        : waitingStopKeyboard(inPlace.sessionId);
    await drawStopReply(
      ctx,
      text,
      keyboard,
      'the pressed message was already gone',
      menuKeyboard(),
    );
  }

  // The reply under the waiting message (#587), in place of the pressed message. Logged and left
  // when Telegram refused it otherwise: the summary and the card still follow.
  async function drawStopReply(
    ctx: Context,
    text: TelegramHtml,
    reply_markup: InlineKeyboard,
    goneNote: string,
    goneMarkup = reply_markup,
  ): Promise<void> {
    const drawn = await drawInPlace(ctx, text, reply_markup, goneNote, goneMarkup);
    if (drawn.in === 'refused') {
      logger.warn(
        { ...errorLogFields(drawn.error), ...telegramErrorFields(drawn.error, 'editMessageText') },
        'trading session stop reply not drawn',
      );
    }
  }

  // The pressed message edited in place; refused as gone (deleted, or past 48 h), the same text as
  // a new message, under `goneMarkup` (the same keyboard by default); «not modified» counts as drawn; any other Telegram refusal or a
  // transport failure is handed back to log; anything else is a bug, rethrown to bot.catch.
  async function drawInPlace(
    ctx: Context,
    text: TelegramHtml,
    reply_markup: InlineKeyboard,
    goneNote?: string,
    goneMarkup = reply_markup,
  ): Promise<
    | { in: 'place' }
    | { in: 'new'; sent: { chat: { id: number }; message_id: number } }
    | { in: 'refused'; error: HttpError }
  > {
    try {
      await editMessageTextHtml(ctx, text, { reply_markup });
      return { in: 'place' };
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'shown') return { in: 'place' };
      if (refusal === 'gone') {
        if (goneNote !== undefined) {
          logger.info({ ...telegramErrorFields(error, 'editMessageText') }, goneNote);
        }
        return { in: 'new', sent: await replyHtml(ctx, text, { reply_markup: goneMarkup }) };
      }
      if (!(error instanceof HttpError)) throw error;
      return { in: 'refused', error };
    }
  }

  // An old status message's «⏹» (before #536): the session message in its place, under the
  // stopped session's end of the path, then tracking on whichever message shows it: its first poll
  // records the message (#567), the newest id winning (#587); a done session's entry sends its
  // summary card once and ends (#318). It is the view's drawing cut down to its text, with the
  // keyboard: the tracker redraws it at the next change of the drawing (#568, risk 68).
  async function showInPlace(
    ctx: Context,
    telegramUserId: string,
    symbol: PairLabel | null,
    view: TradingSessionView,
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery?.message?.message_id;
    const drawn = await drawInPlace(
      ctx,
      sessionStatusText(symbol, view),
      sessionCardKeyboard(view, cashierUrl),
    );
    if (drawn.in === 'refused') {
      logger.warn(
        { ...errorLogFields(drawn.error), ...telegramErrorFields(drawn.error, 'editMessageText') },
        'trading session message not edited',
      );
      return;
    }
    if (drawn.in === 'new') {
      track(ctx, telegramUserId, symbol, view, drawn.sent.chat.id, drawn.sent.message_id);
      return;
    }
    if (chatId !== undefined && messageId !== undefined) {
      track(ctx, telegramUserId, symbol, view, chatId, messageId);
    }
  }

  // The launch screen after the session message was sent (#418, docs/bot-session.md → The launch
  // screen after the start), after it so a slow or refused delete never withholds it.
  //   deleted                                   → nothing more
  //   400 «message to delete not found»         → nothing, info
  //   400 «…can't be deleted…» (48 h)          → its keyboard stripped, the text stays
  //   any other GrammyError or HttpError        → nothing, warn
  //   anything else                             → a bug, rethrown to bot.catch
  async function removeLaunchScreen(ctx: Context): Promise<void> {
    const what = 'the launch screen';
    try {
      await ctx.deleteMessage();
      return;
    } catch (error) {
      if (!(error instanceof GrammyError) && !(error instanceof HttpError)) throw error;
      const refusal = error instanceof GrammyError ? deleteRefusal(error) : undefined;
      if (refusal === 'gone') {
        logger.info({ ...telegramErrorFields(error, 'deleteMessage') }, `${what} was already gone`);
        return;
      }
      if (refusal !== 'forbidden') {
        logger.warn(
          {
            ...errorLogFields(error),
            ...telegramErrorFields(error, 'deleteMessage'),
            updateId: ctx.update.update_id,
          },
          `${what} was not deleted`,
        );
        return;
      }
    }
    try {
      await ctx.editMessageReplyMarkup();
    } catch (error) {
      if (!(error instanceof GrammyError) && !(error instanceof HttpError)) throw error;
      logger.warn(
        {
          ...errorLogFields(error),
          ...telegramErrorFields(error, 'editMessageReplyMarkup'),
          updateId: ctx.update.update_id,
        },
        `${what} keyboard was not removed`,
      );
    }
  }

  function track(
    ctx: Context,
    telegramUserId: string,
    symbol: PairLabel | null,
    view: TradingSessionView,
    chatId: number,
    messageId: number,
  ): void {
    const target = { sessionId: view.id, telegramUserId, symbol, chatId, messageId };
    follow(ctx.api, ctx.me.username, target, { view, record: true });
  }

  // a private chat's id is its user's id (Telegram ids fit in 52 bits, so Number keeps them)
  const resume: ResumeSession = (api, botUsername, session, label) => {
    const target = {
      sessionId: session.id,
      telegramUserId: session.telegramUserId,
      symbol: label,
      chatId: Number(session.telegramUserId),
      messageId: session.messageId,
    };
    follow(api, botUsername, target, {
      view: null,
      record: false,
      startedAt: Date.parse(session.startedAt),
    });
  };

  function follow(
    api: Api,
    botUsername: string,
    {
      sessionId,
      telegramUserId,
      symbol,
      chatId,
      messageId,
    }: {
      sessionId: string;
      telegramUserId: string;
      symbol: PairLabel | null;
      chatId: number;
      messageId: number;
    },
    entry: {
      view: TradingSessionView | null;
      record: boolean;
      startedAt?: number;
    },
  ): void {
    sessionTracker.track({
      sessionId,
      telegramUserId,
      messageId,
      label: symbol,
      ...entry,
      // the session message has no keyboard (#536): an edit without one strips an old status
      // message's buttons too; a session gone leaves only the menu (#350). Its kind follows the
      // drawing's picture (#568, sessionEditMethod).
      edit: ({ text, picture: drawn }, end) => {
        const picture = sessionEditMethod(drawn) === 'editMessageMedia' ? drawn : null;
        const reason = NO_NEXT_STEP_REASONS.SessionStatus;
        if (end === 'not_found') {
          const extra = { reply_markup: menuKeyboard() };
          return picture === null
            ? editMessageTextByIdHtml(api, chatId, messageId, text, extra)
            : editSessionPhoto(picture, (photo) =>
                editMessagePhotoByIdHtml(api, chatId, messageId, photo, text, extra),
              );
        }
        return picture === null
          ? editMessageTextByIdHtmlWithoutNextStep(api, chatId, messageId, text, reason)
          : editSessionPhoto(picture, (photo) =>
              editMessagePhotoByIdHtmlWithoutNextStep(api, chatId, messageId, photo, text, reason),
            );
      },
      card: (current) => sendCard(api, chatId, telegramUserId, symbol, botUsername, current),
    });
  }

  // The summary card (#318, docs/bot-session.md → The summary card): claimed once by the backend,
  // drawn here, sent under the final status. A refused claim sends nothing and says nothing; any
  // other failure is logged and not retried — a committed claim would answer 409 the second time.
  async function sendCard(
    api: Api,
    chatId: number,
    telegramUserId: string,
    symbol: PairLabel | null,
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
      const keyboard = sessionCardKeyboard(view, cashierUrl);
      const sent = await sendPhotoByIdHtml(
        api,
        chatId,
        new InputFile(png, 'session.png'),
        TEXTS.sessionCardCaption({
          symbol: sessionAssetLabel(symbol, assetId),
          profit: summary.result,
          botUsername,
        }),
        // without sound: the backend's summary message just before it carries the session's
        // one sound (#464)
        { reply_markup: keyboard, disable_notification: true },
      );
      // «📤 Поделиться» (#321): catches its own failures, so the warning below is the send's only
      if (shareEnabled) await attachShareButton(api, logger, view.id, sent, keyboard);
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

  return { composer, startSession, resume };
}
