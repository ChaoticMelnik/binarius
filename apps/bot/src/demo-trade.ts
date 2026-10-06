import { Composer, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import {
  BrokerBalanceUnavailableReason,
  errorLogFields,
  TradeIntentErrorCode,
  TradeMode,
  UserStatus,
  type CreateTradeIntentRequest,
  type DecimalString,
  type PairView,
  type TelegramHtml,
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
  demoAssetCallbackData,
  STAKE_CALLBACK_PATTERN,
  stakeDataOf,
} from './demo';
import { readDemoTrade, type DemoTradeRead } from './demo-catalog';
import { INTENT_NOT_FOUND, TRACKER_STOP_STATUSES, type IntentTracker } from './intent-tracker';
import { telegramErrorFields, type Logger } from './logging';
import { editRefusal } from './screen';
import { editMessageTextByIdHtml, editMessageTextHtml, replyHtml } from './send';
import { intentStatusText, LABELS, TEXTS } from './texts';

// The demo trade (#127, docs/bot-demo-trade.md): the stake button under the analysis screen
// creates an intent through POST /trading/intents, one status message follows it (the tracker),
// and «🔄 Обновить статус» under that message reads the intent again.

// `intent:<uuid>` is 43 bytes, inside the Bot API 64.
export const intentCallbackData = (intentId: string): string => `intent:${intentId}`;
export const INTENT_CALLBACK_PATTERN =
  /^intent:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const intentKeyboard = (intentId: string): InlineKeyboard =>
  new InlineKeyboard().text(LABELS.refreshIntentButton, intentCallbackData(intentId));

export interface DemoTradeDeps {
  backend: Pick<BackendClient, 'readPairs' | 'readTradingAccess' | 'createIntent' | 'readIntent'>;
  logger: Logger;
  now: () => number;
  intentTracker: Pick<IntentTracker, 'track'>;
  // the welcome's two ways in, for a press with no account to trade on
  connectKeyboard: () => InlineKeyboard;
}

interface Refusal {
  text: TelegramHtml;
  connect?: true;
  // a refusal the bot never provokes: a bug, or a backend this bot does not know
  log?: true;
}

// Every refusal of POST /trading/intents, by its code. Each is answered before a row is
// committed (docs/trade-intent-transport.md → Creation transaction), so nothing was created.
// Exhaustive: a code added to the contract fails tsc here.
const CREATE_REFUSALS = {
  // the access read a moment ago found the users row: a backend that contradicts itself
  [TradeIntentErrorCode.UserNotFound]: { text: TEXTS.unavailable, log: true },
  [TradeIntentErrorCode.UserBlocked]: { text: TEXTS.blocked },
  [TradeIntentErrorCode.BrokerAccountNotFound]: { text: TEXTS.accountNone, connect: true },
  [TradeIntentErrorCode.AmbiguousBrokerAccount]: { text: TEXTS.statusAmbiguous },
  [TradeIntentErrorCode.AccountRevoked]: { text: TEXTS.accountRevoked, connect: true },
  [TradeIntentErrorCode.AccountNotConfirmed]: { text: TEXTS.stakeAccountNotConfirmed },
  [TradeIntentErrorCode.AccountHalted]: { text: TEXTS.stakeAccountHalted },
  [TradeIntentErrorCode.InsufficientTokens]: { text: TEXTS.stakeInsufficientTokens },
  [TradeIntentErrorCode.ActiveIntentExists]: { text: TEXTS.stakeActiveIntent },
  // the same button pressed with other parameters: minTradeAmount changed between two presses
  [TradeIntentErrorCode.ClientRequestIdConflict]: { text: TEXTS.stakeButtonUsed },
  // demo never reaches the real-mode gate
  [TradeIntentErrorCode.RealTradingDisabled]: { text: TEXTS.unavailable, log: true },
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
  // between the analysis and the press), the access (the amount is the broker's minimum stake
  // from its snapshot, a string as the backend sent it — never computed, Rule 2), then the POST.
  // The key is the button's own nonce: the same button pressed again — a double tap, an old
  // message, a press after a restart — replays the same intent and never opens a second trade
  // (trade_intents_user_request_idx), while every analysis render draws a new nonce.
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
    const amount = await amountOf(ctx, access);
    if (amount === undefined) return;

    const request: CreateTradeIntentRequest = {
      telegramUserId,
      mode: TradeMode.Demo,
      assetId: stake.assetId,
      amount,
      action: stake.action,
      durationSec: stake.durationSec,
      clientRequestId: `demo:${telegramUserId}:${stake.nonce}`,
    };
    // one more ask with the same key on an unknown outcome: a replay returns the row if it
    // exists and creates it once if not — the user pressed once and meant it
    let created = await create(request);
    if (!created.ok && created.unknown) created = await create(request);
    if (!created.ok) {
      await replyCreateFailure(ctx, created);
      return;
    }
    await sendStatus(ctx, trade.pair, created.intent);
  });

  composer.callbackQuery(INTENT_CALLBACK_PATTERN, async (ctx) => {
    const intentId = ctx.match[1] ?? '';
    const [, read, catalog] = await Promise.all([
      ctx.answerCallbackQuery().catch(logAnswerFailure),
      settle(backend.readIntent(intentId, String(ctx.from.id))),
      // the symbol only, so any catalog will do, a stale one included
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
      await replyHtml(ctx, notFound ? TEXTS.intentStatusUnavailable : TEXTS.unavailable);
      return;
    }
    const view = read.value;
    const symbol = catalog.ok
      ? (catalog.value.pairs.find((pair) => pair.id === view.assetId)?.symbol ?? null)
      : null;
    await refreshInPlace(ctx, intentStatusText(symbol, view), intentKeyboard(view.id));
  });

  async function create(request: CreateTradeIntentRequest): Promise<CreateOutcome> {
    try {
      const { intent } = await backend.createIntent(request);
      return { ok: true, intent };
    } catch (error) {
      return { ok: false, unknown: outcomeUnknown(error), error };
    }
  }

  // the stake as the broker's snapshot gives it, or undefined once the refusal was sent
  async function amountOf(
    ctx: Context,
    access: Settled<TradingAccessResponse>,
  ): Promise<DecimalString | undefined> {
    if (!access.ok) {
      logger.warn(
        { ...errorLogFields(access.error), ...backendErrorFields(access.error) },
        'trading access not read',
      );
      await replyHtml(ctx, TEXTS.unavailable);
      return undefined;
    }
    const { status, broker, brokerUnavailable } = access.value;
    if (status === UserStatus.Blocked) {
      await replyHtml(ctx, TEXTS.blocked);
      return undefined;
    }
    if (broker !== null) return broker.minTradeAmount;
    if (brokerUnavailable === BrokerBalanceUnavailableReason.NoAccount) {
      await replyHtml(ctx, TEXTS.accountNone, { reply_markup: connectKeyboard() });
    } else if (brokerUnavailable === BrokerBalanceUnavailableReason.AmbiguousAccount) {
      await replyHtml(ctx, TEXTS.statusAmbiguous);
    } else {
      await replyHtml(ctx, TEXTS.stakeBalanceMissing);
    }
    return undefined;
  }

  async function replyCreateFailure(
    ctx: Context,
    failure: Extract<CreateOutcome, { ok: false }>,
  ): Promise<void> {
    const reason = failure.error instanceof BackendError ? failure.error.reason : undefined;
    const refusal: Refusal =
      !failure.unknown && isCreateRefusal(reason)
        ? CREATE_REFUSALS[reason]
        : { text: failure.unknown ? TEXTS.stakeOutcomeUnknown : TEXTS.unavailable, log: true };
    if (refusal.log === true) {
      logger.warn(
        { ...errorLogFields(failure.error), ...backendErrorFields(failure.error) },
        'trade intent not created',
      );
    }
    await replyHtml(
      ctx,
      refusal.text,
      refusal.connect === true ? { reply_markup: connectKeyboard() } : {},
    );
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
        await replyHtml(ctx, TEXTS.demoPairClosed(read.pair.symbol), {
          reply_markup: backToGroups,
        });
        return;
      case 'duration_unsupported':
        await replyHtml(ctx, TEXTS.demoDurationUnsupported(read.pair.symbol), {
          reply_markup: backToDurations,
        });
        return;
    }
  }

  // The status message, then the tracker unless the intent already stands where tracking ends
  // (a replay of a finished trade). A replay of a live intent the tracker already follows sends
  // this message untracked: track() of a tracked id is a no-op.
  async function sendStatus(ctx: Context, pair: PairView, intent: TradeIntentView): Promise<void> {
    const reply_markup = intentKeyboard(intent.id);
    const sent = await replyHtml(ctx, intentStatusText(pair.symbol, intent), { reply_markup });
    if (TRACKER_STOP_STATUSES.has(intent.status)) return;
    intentTracker.track({
      intentId: intent.id,
      telegramUserId: intent.telegramUserId,
      symbol: pair.symbol,
      view: intent,
      edit: (text) =>
        editMessageTextByIdHtml(ctx.api, sent.chat.id, sent.message_id, text, { reply_markup }),
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
