import { Composer, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import {
  BrokerBalanceUnavailableReason,
  DEFAULT_SESSION_TRADES,
  errorLogFields,
  pairPayoutAccepted,
  TradeIntentErrorCode,
  TradeMode,
  UserStatus,
  type CreateTradeIntentRequest,
  type DecimalString,
  type PairView,
  type BotStaticHtmlKey,
  type TelegramHtml,
  TRADE_INTENT_TRANSITIONS,
  type TradeIntentView,
  type TradingAccessResponse,
} from '@binarius/shared';
import {
  BackendError,
  BackendErrorCode,
  backendErrorFields,
  type BackendClient,
} from './backend-client';
import {
  DEMO_GROUPS_CALLBACK_DATA,
  demoAnalysisCallbackData,
  demoAssetCallbackData,
  effectiveStake,
  sessionStartCallbackData,
  STAKE_CALLBACK_PATTERN,
  stakeDataOf,
  stakeFingerprint,
  stakeMenuCallbackData,
  type StakeData,
} from './demo';
import {
  appendEndOfPath,
  backToAnalysisKeyboard,
  menuKeyboard,
  retryKeyboard,
  supportKeyboard,
  withMenu,
} from './keyboards';
import { readDemoTrade, type DemoTradeRead } from './demo-catalog';
import {
  INTENT_NOT_FOUND,
  sessionOfferOf,
  TRACKER_STOP_STATUSES,
  type IntentTracker,
} from './intent-tracker';
import { telegramErrorFields, type Logger } from './logging';
import { editRefusal } from './screen';
import { editMessageTextByIdHtml, editMessageTextHtml, replyHtml } from './send';
import { intentStatusText, LABELS, sessionStartButtonLabel, TEXTS, textOf } from './texts';

// The demo trade (#127, docs/bot-demo-trade.md): the stake button «➕ Ещё» draws under the analysis
// screen (#360) creates an intent through POST /trading/intents, one status message follows it (the tracker),
// and «🔄 Обновить статус» under that message reads the intent again.

// `intent:<uuid>` is 43 bytes, inside the Bot API 64.
export const intentCallbackData = (intentId: string): string => `intent:${intentId}`;
export const INTENT_CALLBACK_PATTERN =
  /^intent:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

// «🔄 Обновить статус» while the trade can still move (accepted until it settles); once the
// tracker stops following it, the session offer (#360, not below the cycle floor, #379) and the
// end of the path (#350): a new analysis, the signals, the menu.
export function intentKeyboard(
  view: Pick<TradeIntentView, 'id' | 'mode' | 'status' | 'assetId' | 'durationSec'>,
  payoutAccepted: boolean,
): InlineKeyboard {
  const keyboard =
    TRADE_INTENT_TRANSITIONS[view.status].length > 0
      ? new InlineKeyboard().text(LABELS.refreshIntentButton, intentCallbackData(view.id))
      : new InlineKeyboard();
  const offer = sessionOfferOf(view, payoutAccepted);
  if (offer !== undefined) {
    keyboard
      .row()
      .text(
        sessionStartButtonLabel(DEFAULT_SESSION_TRADES),
        sessionStartCallbackData(view.assetId, offer),
      );
  }
  return TRACKER_STOP_STATUSES.has(view.status)
    ? appendEndOfPath(keyboard, view.assetId, view.durationSec)
    : keyboard;
}

export interface DemoTradeDeps {
  backend: Pick<BackendClient, 'readPairs' | 'readTradingAccess' | 'createIntent' | 'readIntent'>;
  logger: Logger;
  now: () => number;
  intentTracker: Pick<IntentTracker, 'track'>;
  // the welcome's connect button, for a press with no account to trade on
  connectKeyboard: () => InlineKeyboard;
}

interface Refusal {
  text: BotStaticHtmlKey;
  connect?: true;
  // «💵 Сумма» under the text: a refusal of the amount itself (#297)
  stakeMenu?: true;
  // a refusal the bot never provokes: a bug, or a backend this bot does not know
  log?: true;
}

// Every refusal of POST /trading/intents, by its code. Each is answered before a row is
// committed (docs/trade-intent-transport.md → Creation transaction), so nothing was created.
// Exhaustive: a code added to the contract fails tsc here.
const CREATE_REFUSALS = {
  // the access read a moment ago found the users row: a backend that contradicts itself
  [TradeIntentErrorCode.UserNotFound]: { text: 'unavailable', log: true },
  [TradeIntentErrorCode.UserBlocked]: { text: 'blocked' },
  [TradeIntentErrorCode.BrokerAccountNotFound]: { text: 'accountNone', connect: true },
  [TradeIntentErrorCode.AmbiguousBrokerAccount]: { text: 'statusAmbiguous' },
  [TradeIntentErrorCode.AccountRevoked]: { text: 'accountRevoked', connect: true },
  [TradeIntentErrorCode.AccountNotConfirmed]: { text: 'stakeAccountNotConfirmed' },
  [TradeIntentErrorCode.AccountHalted]: { text: 'stakeAccountHalted' },
  [TradeIntentErrorCode.InsufficientTokens]: { text: 'stakeInsufficientTokens' },
  [TradeIntentErrorCode.ActiveIntentExists]: { text: 'stakeActiveIntent' },
  // the same button pressed with other parameters: the amount changed between two presses, which
  // the fingerprint normally refuses first
  [TradeIntentErrorCode.ClientRequestIdConflict]: { text: 'stakeButtonUsed' },
  // the global trading switch is closed (#144): demo and real alike
  [TradeIntentErrorCode.TradingPaused]: { text: 'tradingPaused' },
  // the backend runs DEMO_ONLY (#396): a real press, refused before any write
  [TradeIntentErrorCode.DemoOnly]: { text: 'tradingDemoOnly' },
  // a real press whose user went back to demo between the access read and the POST (#121); an
  // older render is refused by the fingerprint first
  [TradeIntentErrorCode.RealModeOff]: { text: 'stakeRealModeOff' },
  // the demo-stake bounds against the account's snapshot (#297); stake_below_minimum names the
  // minimum when this press's access read had it (replyCreateFailure)
  [TradeIntentErrorCode.BalanceUnavailable]: { text: 'stakeBalanceMissing' },
  [TradeIntentErrorCode.StakePrecision]: { text: 'stakePrecision', stakeMenu: true },
  [TradeIntentErrorCode.StakeBelowMinimum]: { text: 'stakeBelowBrokerMinimum', stakeMenu: true },
  [TradeIntentErrorCode.InsufficientDemoBalance]: { text: 'stakeAboveAvailable', stakeMenu: true },
} as const satisfies Record<TradeIntentErrorCode, Refusal>;

const isCreateRefusal = (reason: string | undefined): reason is TradeIntentErrorCode =>
  reason !== undefined && Object.hasOwn(CREATE_REFUSALS, reason);

// A 5xx, no answer, or a 2xx that is not the contract's: the transaction may have committed and
// the answer been lost. Any 4xx was answered before the side effect.
const outcomeUnknown = (error: unknown): boolean =>
  error instanceof BackendError &&
  (error.code !== BackendErrorCode.HttpStatus || (error.status ?? 0) >= 500);

type CreateOutcome =
  | { ok: true; intent: TradeIntentView }
  | { ok: false; unknown: true; error: unknown }
  | { ok: false; unknown: false; error: unknown };

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );

export function createDemoTradeComposer<C extends Context>({
  backend,
  logger,
  now,
  intentTracker,
  connectKeyboard,
}: DemoTradeDeps): Composer<C> {
  const composer = new Composer<C>();

  // The order of the checks: the catalog read at this press (the pair can close or vanish
  // between the analysis and the press), the access (the user's mode, #121; the amount is the
  // broker's minimum in real mode, in demo the saved demo stake or the broker's minimum without
  // one, a string as the backend sent it — never computed, Rule 2), the button's fingerprint
  // against that amount and mode (#297, #121), then the POST in that mode.
  // The key is the mode and the button's own nonce: the same button pressed again — a double tap,
  // an old message, a press after a restart — replays the same intent and never opens a second
  // trade (trade_intents_user_request_idx), while every analysis render draws a new nonce; the
  // mode in the key keeps a demo button from replaying as a real intent.
  composer.callbackQuery(STAKE_CALLBACK_PATTERN, async (ctx) => {
    const stake = stakeDataOf(ctx.match);
    if (stake === undefined) {
      await ctx.answerCallbackQuery().catch(logAnswerFailure);
      return;
    }
    const telegramUserId = String(ctx.from.id);
    const [, trade, access] = await Promise.all([
      ctx.answerCallbackQuery().catch(logAnswerFailure),
      readDemoTrade(backend, stake.assetId, stake.durationSec, now),
      settle(backend.readTradingAccess(telegramUserId)),
    ]);
    if (!trade.ok) {
      await replyTradeFailure(ctx, trade, stake.assetId);
      return;
    }
    const amount = await amountOf(ctx, access, stake);
    if (amount === undefined) return;
    // a button drawn for another amount or the other mode, or before the fingerprint existed: the
    // user would trade an amount or in a mode the label did not show
    if (stake.fingerprint !== stakeFingerprint(amount.amount, amount.mode)) {
      await replyHtml(ctx, TEXTS.stakeAmountChanged, {
        reply_markup: new InlineKeyboard().text(
          LABELS.stakeBackAnalysisButton,
          demoAnalysisCallbackData(stake.assetId, stake.durationSec),
        ),
      });
      return;
    }

    const request: CreateTradeIntentRequest = {
      telegramUserId,
      mode: amount.mode,
      assetId: stake.assetId,
      amount: amount.amount,
      action: stake.action,
      durationSec: stake.durationSec,
      clientRequestId: `${amount.mode}:${telegramUserId}:${stake.nonce}`,
    };
    // one more ask with the same key on an unknown outcome: a replay returns the row if it
    // exists and creates it once if not — the user pressed once and meant it
    let created = await create(request);
    if (!created.ok && created.unknown) created = await create(request);
    if (!created.ok) {
      await replyCreateFailure(ctx, created, stake, amount.minTradeAmount);
      return;
    }
    await sendStatus(ctx, trade.pair, created.intent);
  });

  composer.callbackQuery(INTENT_CALLBACK_PATTERN, async (ctx) => {
    const intentId = ctx.match[1] ?? '';
    const [, read, catalog] = await Promise.all([
      ctx.answerCallbackQuery().catch(logAnswerFailure),
      settle(backend.readIntent(intentId, String(ctx.from.id))),
      // the symbol and the payout floor's verdict only, so any catalog will do, a stale one
      // included
      settle(backend.readPairs()),
    ]);
    if (!read.ok) {
      const notFound =
        read.error instanceof BackendError &&
        read.error.code === BackendErrorCode.HttpStatus &&
        read.error.reason === INTENT_NOT_FOUND;
      if (!notFound) {
        logger.warn(
          { ...errorLogFields(read.error), ...backendErrorFields(read.error) },
          'trade intent status not read',
        );
      }
      // a missing intent has nothing to read again; any other failure repeats the read
      await replyHtml(ctx, notFound ? TEXTS.intentStatusUnavailable : TEXTS.unavailable, {
        reply_markup: notFound ? menuKeyboard() : retryKeyboard(ctx.callbackQuery.data),
      });
      return;
    }
    const view = read.value;
    const pair = catalog.ok
      ? catalog.value.pairs.find((listed) => listed.id === view.assetId)
      : undefined;
    // an unknown payout (the read failed, the id not listed) draws no session offer
    const payoutAccepted = pair !== undefined && pairPayoutAccepted(pair);
    // no tracker follows the message a refresh draws, so a live status gets the menu too (#350)
    const keyboard = TRACKER_STOP_STATUSES.has(view.status)
      ? intentKeyboard(view, payoutAccepted)
      : withMenu(intentKeyboard(view, payoutAccepted));
    await refreshInPlace(
      ctx,
      intentStatusText(pair?.symbol ?? null, view, {
        sessionOffer: sessionOfferOf(view, payoutAccepted) !== undefined,
      }),
      keyboard,
    );
  });

  async function create(request: CreateTradeIntentRequest): Promise<CreateOutcome> {
    try {
      return { ok: true, intent: await backend.createIntent(request) };
    } catch (error) {
      return { ok: false, unknown: outcomeUnknown(error), error };
    }
  }

  // The stake, the broker's minimum it is checked against and the user's mode, or undefined once
  // the refusal was sent. The press is a write, so a refusal leads back to the analysis, never the press again.
  async function amountOf(
    ctx: Context,
    access: Settled<TradingAccessResponse>,
    stake: StakeData,
  ): Promise<
    { amount: DecimalString; minTradeAmount: DecimalString; mode: TradeMode } | undefined
  > {
    const back = () => backToAnalysisKeyboard(stake.assetId, stake.durationSec);
    if (!access.ok) {
      logger.warn(
        { ...errorLogFields(access.error), ...backendErrorFields(access.error) },
        'trading access not read',
      );
      await replyHtml(ctx, TEXTS.unavailable, { reply_markup: back() });
      return undefined;
    }
    const { status, broker, brokerUnavailable } = access.value;
    if (status === UserStatus.Blocked) {
      await replyHtml(ctx, TEXTS.blocked, { reply_markup: supportKeyboard() });
      return undefined;
    }
    const amount = effectiveStake(access.value);
    if (broker !== null && amount !== null) {
      return { amount, minTradeAmount: broker.minTradeAmount, mode: access.value.tradingMode };
    }
    if (brokerUnavailable === BrokerBalanceUnavailableReason.NoAccount) {
      await replyHtml(ctx, TEXTS.accountNone, { reply_markup: connectKeyboard() });
    } else if (brokerUnavailable === BrokerBalanceUnavailableReason.AmbiguousAccount) {
      await replyHtml(ctx, TEXTS.statusAmbiguous, { reply_markup: back() });
    } else {
      await replyHtml(ctx, TEXTS.stakeBalanceMissing, { reply_markup: back() });
    }
    return undefined;
  }

  async function replyCreateFailure(
    ctx: Context,
    failure: Extract<CreateOutcome, { ok: false }>,
    stake: StakeData,
    minTradeAmount: DecimalString,
  ): Promise<void> {
    const reason = failure.error instanceof BackendError ? failure.error.reason : undefined;
    const refusal: Refusal =
      !failure.unknown && isCreateRefusal(reason)
        ? CREATE_REFUSALS[reason]
        : { text: failure.unknown ? 'stakeOutcomeUnknown' : 'unavailable', log: true };
    if (refusal.log === true) {
      logger.warn(
        { ...errorLogFields(failure.error), ...backendErrorFields(failure.error) },
        'trade intent not created',
      );
    }
    const text =
      !failure.unknown && reason === TradeIntentErrorCode.StakeBelowMinimum
        ? TEXTS.stakeBelowMinimum({ minStake: minTradeAmount })
        : textOf(refusal.text);
    const reply_markup =
      refusal.text === 'blocked'
        ? supportKeyboard()
        : refusal.connect === true
          ? connectKeyboard()
          : refusal.stakeMenu === true
            ? new InlineKeyboard().text(
                LABELS.stakeMenuButton,
                stakeMenuCallbackData(stake.assetId, stake.durationSec),
              )
            : backToAnalysisKeyboard(stake.assetId, stake.durationSec);
    await replyHtml(ctx, text, { reply_markup });
  }

  // #125's texts as a new message under the analysis, with the way back only: a «🔄 Повторить»
  // carrying the stake data would be a second stake button
  async function replyTradeFailure(
    ctx: Context,
    read: Exclude<DemoTradeRead, { ok: true }>,
    assetId: number,
  ): Promise<void> {
    const backToGroups = new InlineKeyboard().text(
      LABELS.demoBackGroupsButton,
      DEMO_GROUPS_CALLBACK_DATA,
    );
    const backToDurations = new InlineKeyboard()
      .text(LABELS.demoBackDurationsButton, demoAssetCallbackData(assetId))
      .text(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA);
    switch (read.reason) {
      case 'catalog_unavailable':
        await replyHtml(ctx, TEXTS.demoCatalogUnavailable, { reply_markup: backToDurations });
        return;
      case 'catalog_stale':
        await replyHtml(ctx, TEXTS.demoCatalogStale, { reply_markup: backToDurations });
        return;
      case 'backend_failed':
        logger.warn(
          { ...errorLogFields(read.error), ...backendErrorFields(read.error) },
          'demo catalog not read',
        );
        await replyHtml(ctx, TEXTS.unavailable, { reply_markup: backToDurations });
        return;
      case 'pair_missing':
        await replyHtml(ctx, TEXTS.demoPairMissing, { reply_markup: backToGroups });
        return;
      case 'pair_closed':
        await replyHtml(ctx, TEXTS.demoPairClosed({ symbol: read.pair.symbol }), {
          reply_markup: backToGroups,
        });
        return;
      case 'duration_unsupported':
        await replyHtml(ctx, TEXTS.demoDurationUnsupported({ symbol: read.pair.symbol }), {
          reply_markup: backToDurations,
        });
        return;
    }
  }

  // The status message, then the tracker unless the intent already stands where tracking ends
  // (a replay of a finished trade). A replay of a live intent the tracker already follows sends
  // this message untracked: track() of a tracked id is a no-op.
  async function sendStatus(ctx: Context, pair: PairView, intent: TradeIntentView): Promise<void> {
    const payoutAccepted = pairPayoutAccepted(pair);
    const sent = await replyHtml(
      ctx,
      intentStatusText(pair.symbol, intent, {
        sessionOffer: sessionOfferOf(intent, payoutAccepted) !== undefined,
      }),
      {
        reply_markup: intentKeyboard(intent, payoutAccepted),
      },
    );
    if (TRACKER_STOP_STATUSES.has(intent.status)) return;
    intentTracker.track({
      intentId: intent.id,
      telegramUserId: intent.telegramUserId,
      symbol: pair.symbol,
      payoutAccepted,
      view: intent,
      edit: (text, view, end) =>
        editMessageTextByIdHtml(ctx.api, sent.chat.id, sent.message_id, text, {
          reply_markup:
            end === 'not_found'
              ? menuKeyboard()
              : end === 'deadline'
                ? withMenu(intentKeyboard(view, payoutAccepted))
                : intentKeyboard(view, payoutAccepted),
        }),
    });
  }

  // The refreshed status in place of the message the button is under. Already shown is done;
  // gone gets it anew; a transport failure leaves the edit unknown and sends nothing more; any
  // other refusal goes to bot.catch, the button on screen being the retry.
  async function refreshInPlace(
    ctx: Context,
    text: TelegramHtml,
    reply_markup: InlineKeyboard,
  ): Promise<void> {
    try {
      await editMessageTextHtml(ctx, text, { reply_markup });
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'shown') return;
      if (refusal === 'gone') {
        await replyHtml(ctx, text, { reply_markup });
        return;
      }
      if (error instanceof HttpError) {
        logger.warn(
          { ...errorLogFields(error), ...telegramErrorFields(error, 'editMessageText') },
          'trade intent message not edited',
        );
        return;
      }
      throw error;
    }
  }

  function logAnswerFailure(error: unknown): void {
    logger.warn(
      { ...errorLogFields(error), ...telegramErrorFields(error, 'answerCallbackQuery') },
      'answering the callback query failed',
    );
  }

  return composer;
}
