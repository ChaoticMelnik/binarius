import { createHash, randomBytes } from 'node:crypto';
import { Composer, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import {
  BrokerRestErrorCode,
  createTradeIntentRequestSchema,
  DEFAULT_SESSION_TRADES,
  errorLogFields,
  normalizeDecimal,
  sessionFitsDeadline,
  intervalForDuration,
  MIN_CYCLE_PAYOUT_PCT,
  pairPayoutAccepted,
  SignalFeedOutcome,
  TradeAction,
  type DecimalString,
  type PairsCatalogResponse,
  type PairView,
  type TelegramHtml,
  type TradingAccessResponse,
  type TradingSignalsResponse,
  DEMO_CALLBACK_DATA,
} from '@binarius/shared';
import {
  analysisScreen,
  analysisSubject,
  analysisUnavailableScreen,
  type AnalysisScreen,
} from './analysis';
import { backendErrorFields, type BackendClient } from './backend-client';
import {
  checkDemoCycle,
  checkDemoPair,
  DEMO_ASSET_GROUPS,
  DEMO_DURATIONS_SEC,
  durationOptions,
  LEGACY_DEMO_DURATIONS_SEC,
  groupOf,
  openPairsOf,
  pageIndexOf,
  pageOf,
  pairsOf,
  readDemoCatalog,
  readDemoCycle,
  readDemoTrade,
  SIGNALS_DURATIONS_SEC,
  type DemoAssetGroup,
  type DemoCatalogRead,
  type DemoCycleRead,
  type DemoDurationSec,
  type DemoTradeRead,
} from './demo-catalog';
import { telegramErrorFields, type Logger } from './logging';
import { editRefusal } from './screen';
import {
  editMessageTextHtml,
  editMessageTextHtmlWithoutNextStep,
  NO_NEXT_STEP_REASONS,
  replyHtml,
  replyHtmlWithoutNextStep,
  type NoNextStepReason,
} from './send';
import {
  DEMO_DURATION_LABELS,
  demoDurationsScreen,
  demoPairsScreen,
  demoSummary,
  formatBreakEven,
  groupButtonLabel,
  LABELS,
  launchText,
  pairButtonLabel,
  sessionStartButtonLabel,
  signalButtonLabel,
  stakeButtonLabel,
  TEXTS,
  DEMO_GROUP_LABELS,
} from './texts';

// The demo's screens (#125, docs/bot-demo.md): the duration of the main path (#382), the pairs
// with a signal now for it and the launch of a cycle on one (#320); the asset types, one type's
// pairs by page, the durations of a pair, the summary, the analysis behind «📊 Анализ» (#126) and
// the single trade behind its «➕ Ещё» (#360). The bot keeps no state for them: what the user chose
// travels in the callback data, so a restart, an old message and a second device all lead to the
// same screen, and every screen reads the catalog anew.

// Bot API allows 1-64 bytes; the longest of the screens' data, `demo:t:cryptocurrency:9999`, is 26,
// `demo:l:2147483647:15` 20 and `demo:sig:15` 11. `demo:sig` is the main path's duration screen
// (#382): every old «🔄 Обновить», «↩️ К списку» and «📡 К сигналам» lands there.
export const DEMO_SIGNALS_CALLBACK_DATA = 'demo:sig';
export const demoSignalsCallbackData = (durationSec: DemoDurationSec): string =>
  `${DEMO_SIGNALS_CALLBACK_DATA}:${durationSec}`;
export const demoLaunchCallbackData = (assetId: number, durationSec: DemoDurationSec): string =>
  `demo:l:${assetId}:${durationSec}`;
export const DEMO_GROUPS_CALLBACK_DATA = 'demo:g';
export const demoPageCallbackData = (group: DemoAssetGroup, page: number): string =>
  `demo:t:${group}:${page}`;
export const demoAssetCallbackData = (assetId: number): string => `demo:a:${assetId}`;
export const demoDurationCallbackData = (assetId: number, durationSec: DemoDurationSec): string =>
  `demo:d:${assetId}:${durationSec}`;
export const demoAnalysisCallbackData = (assetId: number, durationSec: DemoDurationSec): string =>
  `demo:an:${assetId}:${durationSec}`;
// «➕ Ещё» under the analysis on a signal (#360): the press draws the single trade's row in place
// of the collapsed keyboard. The direction and the payout floor's verdict (`s` the session row
// was drawn, `n` withheld, #379) are the render's, so the expansion asks for nothing again. The
// longest, `demo:more:2147483647:15:down:n`, is 30 bytes.
const ANALYSIS_MORE_PREFIX = 'demo:more:';
export const analysisMoreCallbackData = (
  assetId: number,
  durationSec: DemoDurationSec,
  action: TradeAction,
  payoutAccepted: boolean,
): string =>
  `${ANALYSIS_MORE_PREFIX}${assetId}:${durationSec}:${action}:${payoutAccepted ? 's' : 'n'}`;
// The stake button behind «➕ Ещё» (#126, #360); the press opens the trade (#127, demo-trade.ts).
// The nonce is drawn once per expansion and is the trade's idempotency key: the same button
// pressed again replays its intent, a new expansion allows a new trade. The fingerprint is the amount the
// label shows (#297): the press refuses when the amount in effect now is another one. The longest,
// `demo:stake:2147483647:15:down:0123456789ab:0a1b2c`, is 49 bytes.
const STAKE_CALLBACK_PREFIX = 'demo:stake:';
export const stakeCallbackData = (
  assetId: number,
  durationSec: DemoDurationSec,
  action: TradeAction,
  nonce: string,
  fingerprint: string,
): string => `${STAKE_CALLBACK_PREFIX}${assetId}:${durationSec}:${action}:${nonce}:${fingerprint}`;
// 24 bits of the canonical amount; null (no amount to show) hashes '', so a button drawn without
// an amount never matches one with it
export const stakeFingerprint = (amount: DecimalString | null): string =>
  createHash('sha256')
    .update(amount === null ? '' : normalizeDecimal(amount))
    .digest('hex')
    .slice(0, 6);
// The amount a stake press trades (#297): the saved demo stake, or the broker's minimum without
// one; null when access has no broker snapshot to say it.
export const effectiveStake = (
  access: Pick<TradingAccessResponse, 'broker' | 'demoStake'>,
): DecimalString | null =>
  access.broker === null ? null : (access.demoStake ?? access.broker.minTradeAmount);
// «💵 Сумма» beside the stake button, and under the stake refusals: the picker (stake-picker.ts)
// opened from the analysis, whose way back is that analysis
export const STAKE_PICKER_PREFIX = 'stk:';
export const stakeMenuCallbackData = (assetId: number, durationSec: DemoDurationSec): string =>
  `${STAKE_PICKER_PREFIX}o:a:${assetId}:${durationSec}`;
// the launch screen's «💵 Изменить ставку»: the picker whose way back is that launch screen
export const launchStakeCallbackData = (assetId: number, durationSec: DemoDurationSec): string =>
  `${STAKE_PICKER_PREFIX}o:p:${assetId}:${durationSec}`;
// The session button (#284, trading-session.ts) of the analysis screen, of a finished single trade
// (#360, demo-trade.ts) and of the launch screen (#320). No nonce, by the owner's
// decision: an old button starts a new session once the previous one has ended, and while one is
// active the backend answers with it. The longest, `demo:sess:2147483647:15`, is 23 bytes.
const SESSION_START_PREFIX = 'demo:sess:';
export const sessionStartCallbackData = (assetId: number, durationSec: DemoDurationSec): string =>
  `${SESSION_START_PREFIX}${assetId}:${durationSec}`;
// The button shows only where a session of DEFAULT_SESSION_TRADES fits the worker's deadline
// (after #313 every duration of DEMO_DURATIONS_SEC: 5 × (15 + 120) s ≤ 1 h); the handler checks
// again, so an old or forged datum starts nothing. The count is a parameter so a test can reach
// the refusal: with today's set every duration fits.
export const sessionFits = (durationSec: number, trades = DEFAULT_SESSION_TRADES): boolean =>
  sessionFitsDeadline(trades, durationSec);
// 48 bits: unique among one user's own renders is all it needs, since the key is per user
export const newStakeNonce = (): string => randomBytes(6).toString('hex');

// A group is matched loosely and checked against DEMO_ASSET_GROUPS in the handler, so a forged
// one stops the spinner like a forged id; a duration is one of DEMO_DURATIONS_SEC by the pattern.
// Each duration-carrying shape is built from an alternation, so the legacy patterns (#313) are
// the same shapes over LEGACY_DEMO_DURATIONS_SEC.
const DURATIONS = DEMO_DURATIONS_SEC.join('|');
const LEGACY_DURATIONS = LEGACY_DEMO_DURATIONS_SEC.join('|');
const DEMO_PAGE_PATTERN = /^demo:t:([a-z]{1,16}):(\d{1,4})$/;
const DEMO_ASSET_PATTERN = /^demo:a:(\d{1,10})$/;
const demoDurationPattern = (durations: string) =>
  new RegExp(`^demo:d:(\\d{1,10}):(${durations})$`);
const demoAnalysisPattern = (durations: string) =>
  new RegExp(`^demo:an:(\\d{1,10}):(${durations})$`);
// the fingerprint is optional: a button from before #297 has none and is refused as changed,
// not left spinning
const stakeCallbackPattern = (durations: string) =>
  new RegExp(
    `^${STAKE_CALLBACK_PREFIX}(\\d{1,10}):(${durations}):(${Object.values(TradeAction).join('|')}):([0-9a-f]{12})(?::([0-9a-f]{6}))?$`,
  );
const sessionStartPattern = (durations: string) =>
  new RegExp(`^${SESSION_START_PREFIX}(\\d{1,10}):(${durations})$`);
const DEMO_SIGNALS_PATTERN = new RegExp(`^demo:sig:(${DURATIONS})$`);
const DEMO_LAUNCH_PATTERN = new RegExp(`^demo:l:(\\d{1,10}):(${DURATIONS})$`);
// the floor's token is optional: a button #360 drew before #379 has none
export const ANALYSIS_MORE_PATTERN = new RegExp(
  `^${ANALYSIS_MORE_PREFIX}(\\d{1,10}):(${DURATIONS}):(${Object.values(TradeAction).join('|')})(?::(s|n))?$`,
);
const DEMO_DURATION_PATTERN = demoDurationPattern(DURATIONS);
const DEMO_ANALYSIS_PATTERN = demoAnalysisPattern(DURATIONS);
export const STAKE_CALLBACK_PATTERN = stakeCallbackPattern(DURATIONS);
export const SESSION_START_PATTERN = sessionStartPattern(DURATIONS);
const LEGACY_DURATION_PATTERNS = [
  demoDurationPattern(LEGACY_DURATIONS),
  demoAnalysisPattern(LEGACY_DURATIONS),
  stakeCallbackPattern(LEGACY_DURATIONS),
  sessionStartPattern(LEGACY_DURATIONS),
  // a launch screen's button from before #382, which carried no duration
  /^demo:l:(\d{1,10})$/,
];

// A button drawn before #313 with a duration the demo no longer offers, or before #314 with the
// site sign-in: the spinner stops and the message loses its keyboard, so the old screen cannot be
// pressed again; nothing is sent. A refusal of the edit (not modified, the message gone) changes
// nothing for the user.
export async function removeLegacyKeyboard(ctx: Context, logger: Logger): Promise<void> {
  // the three callers share the lines, so the pressed data says which old button it was
  const callbackData = ctx.callbackQuery?.data;
  await ctx.answerCallbackQuery().catch((error: unknown) => {
    logger.warn(
      {
        ...errorLogFields(error),
        ...telegramErrorFields(error, 'answerCallbackQuery'),
        callbackData,
      },
      'answering the callback query failed',
    );
  });
  try {
    await ctx.editMessageReplyMarkup();
  } catch (error) {
    if (!(error instanceof GrammyError) && !(error instanceof HttpError)) throw error;
    logger.info(
      {
        ...errorLogFields(error),
        ...telegramErrorFields(error, 'editMessageReplyMarkup'),
        callbackData,
      },
      'the keyboard of an old button was not removed',
    );
  }
}

// The shape #127 sends, so what the bot carries is what the backend accepts.
export const assetIdOf = (raw: string | undefined): number | undefined => {
  const parsed = createTradeIntentRequestSchema.shape.assetId.safeParse(Number(raw));
  return parsed.success ? parsed.data : undefined;
};
export const durationOf = (raw: string | undefined): DemoDurationSec | undefined =>
  DEMO_DURATIONS_SEC.find((sec) => String(sec) === raw);
const groupOfData = (raw: string | undefined): DemoAssetGroup | undefined =>
  DEMO_ASSET_GROUPS.find((group) => group === raw);
const actionOf = (raw: string | undefined): TradeAction | undefined =>
  Object.values(TradeAction).find((action) => action === raw);

export interface StakeData {
  assetId: number;
  durationSec: DemoDurationSec;
  action: TradeAction;
  nonce: string;
  fingerprint: string | undefined;
}

// The stake button's data from a STAKE_CALLBACK_PATTERN match, undefined when forged.
export function stakeDataOf(match: RegExpMatchArray | string): StakeData | undefined {
  if (typeof match === 'string') return undefined;
  const assetId = assetIdOf(match[1]);
  const durationSec = durationOf(match[2]);
  const action = actionOf(match[3]);
  const nonce = match[4];
  if (
    assetId === undefined ||
    durationSec === undefined ||
    action === undefined ||
    nonce === undefined
  ) {
    return undefined;
  }
  return { assetId, durationSec, action, nonce, fingerprint: match[5] };
}

// «➕ Ещё»'s data from an ANALYSIS_MORE_PATTERN match, undefined when forged. A datum without
// the floor's token was drawn before #379 and keeps its session row: that press meets the route's
// 409 payout_too_low, as every pre-#379 session button does.
export function analysisMoreDataOf(match: RegExpMatchArray | string):
  | {
      assetId: number;
      durationSec: DemoDurationSec;
      action: TradeAction;
      payoutAccepted: boolean;
    }
  | undefined {
  if (typeof match === 'string') return undefined;
  const assetId = assetIdOf(match[1]);
  const durationSec = durationOf(match[2]);
  const action = actionOf(match[3]);
  if (assetId === undefined || durationSec === undefined || action === undefined) return undefined;
  return { assetId, durationSec, action, payoutAccepted: match[4] !== 'n' };
}

// The session button's data from a SESSION_START_PATTERN match, undefined when forged or when
// the duration does not fit a session.
export function sessionStartDataOf(
  match: RegExpMatchArray | string,
  trades = DEFAULT_SESSION_TRADES,
): { assetId: number; durationSec: DemoDurationSec } | undefined {
  if (typeof match === 'string') return undefined;
  const assetId = assetIdOf(match[1]);
  const durationSec = durationOf(match[2]);
  if (assetId === undefined || durationSec === undefined || !sessionFits(durationSec, trades)) {
    return undefined;
  }
  return { assetId, durationSec };
}

// The main path's first screen (#382): the durations of SIGNALS_DURATIONS_SEC in one row, then the
// manual choice. It reads nothing: the list behind each button reads anew.
export function durationsScreen(): DemoScreen {
  const keyboard = new InlineKeyboard();
  for (const sec of SIGNALS_DURATIONS_SEC) {
    keyboard.text(DEMO_DURATION_LABELS[sec], demoSignalsCallbackData(sec));
  }
  return {
    text: TEXTS.demoChooseDurationMain,
    keyboard: keyboard.row().text(LABELS.demoManualButton, DEMO_GROUPS_CALLBACK_DATA),
  };
}

// The pairs with a signal on the last closed candle of the chosen duration's scanner (#320,
// #382), in the route's order, each joined with the catalog for its symbol and payout. A pair the
// catalog does not list, that is closed now, that does not take the duration or that pays less
// than the cycle floor (#379) has no button: the launch would refuse it. The list is a snapshot;
// the cycle checks the signal again before each trade. Undefined when the body has no list for the
// duration: a backend scanning other intervals.
export function signalsScreen(
  signals: TradingSignalsResponse,
  catalog: PairsCatalogResponse,
  durationSec: DemoDurationSec,
  nowMs: number,
): DemoScreen | undefined {
  const interval = intervalForDuration(durationSec);
  const list = signals.lists.find((candidate) => candidate.interval === interval);
  if (list === undefined) return undefined;
  const keyboard = new InlineKeyboard();
  let listed = 0;
  for (const signal of list.signals) {
    const checked = checkDemoCycle(catalog, signal.assetId, durationSec, nowMs);
    if (!checked.ok) continue;
    const { pair } = checked;
    keyboard
      .text(
        signalButtonLabel(pair.symbol, signal.action, pair.payout),
        demoLaunchCallbackData(pair.id, durationSec),
      )
      .row();
    listed += 1;
  }
  const label = DEMO_DURATION_LABELS[durationSec];
  return {
    text: listed === 0 ? TEXTS.demoSignalsEmpty({ label }) : TEXTS.demoSignalsHeader({ label }),
    keyboard: keyboard
      .text(LABELS.demoSignalsRefreshButton, demoSignalsCallbackData(durationSec))
      .row()
      .text(LABELS.demoBackDurationsButton, DEMO_SIGNALS_CALLBACK_DATA)
      .row()
      .text(LABELS.demoManualButton, DEMO_GROUPS_CALLBACK_DATA),
  };
}

// The launch of a cycle of DEFAULT_SESSION_TRADES on a pair at the chosen duration (#320, #382):
// the session start of the analysis screen (#284), the picker with its way back here, the list.
// The picker draws it too, after a save (stake-picker.ts).
export function launchScreen({
  assetId,
  durationSec,
  firstName,
  symbol,
  amount,
  saved,
}: {
  assetId: number;
  durationSec: DemoDurationSec;
  firstName: string;
  symbol: string | null;
  amount: DecimalString | null;
  saved?: { amount: DecimalString | null };
}): DemoScreen {
  return {
    text: launchText({
      firstName,
      durationSec,
      symbol,
      amount,
      trades: DEFAULT_SESSION_TRADES,
      saved,
    }),
    keyboard: new InlineKeyboard()
      .text(LABELS.launchCycleButton, sessionStartCallbackData(assetId, durationSec))
      .row()
      .text(LABELS.stakeChangeButton, launchStakeCallbackData(assetId, durationSec))
      .row()
      .text(LABELS.backToListButton, demoSignalsCallbackData(durationSec)),
  };
}

export interface DemoComposerDeps {
  backend: Pick<
    BackendClient,
    'readPairs' | 'readSignals' | 'evaluateSignal' | 'readTradingAccess'
  >;
  logger: Logger;
  now: () => number;
}

export function createDemoComposer<C extends Context>({
  backend,
  logger,
  now,
}: DemoComposerDeps): Composer<C> {
  const composer = new Composer<C>();

  composer.callbackQuery(LEGACY_DURATION_PATTERNS, (ctx) => removeLegacyKeyboard(ctx, logger));

  // the card's button is under a photo: the duration screen goes as a new message
  composer.callbackQuery(DEMO_CALLBACK_DATA, async (ctx) => {
    const screen = durationsScreen();
    await answerOnly(ctx);
    await replyHtml(ctx, screen.text, { reply_markup: screen.keyboard });
  });

  composer.callbackQuery(DEMO_SIGNALS_CALLBACK_DATA, async (ctx) => {
    const screen = durationsScreen();
    await answerOnly(ctx);
    await editOrReply(ctx, screen.text, screen.keyboard);
  });

  composer.callbackQuery(DEMO_SIGNALS_PATTERN, async (ctx) => {
    const durationSec = durationOf(ctx.match[1]);
    if (durationSec === undefined) {
      await answerOnly(ctx);
      return;
    }
    const screen = await answerAnd(ctx, readSignalsScreen(ctx, durationSec));
    await editOrReply(ctx, screen.text, screen.keyboard);
  });

  // The pair is checked against the catalog read at this press, never the one the list was drawn
  // from; the signal is not read again, the cycle asks for it before each trade.
  composer.callbackQuery(DEMO_LAUNCH_PATTERN, async (ctx) => {
    const assetId = assetIdOf(ctx.match[1]);
    const durationSec = durationOf(ctx.match[2]);
    if (assetId === undefined || durationSec === undefined) {
      await answerOnly(ctx);
      return;
    }
    const [read, amount] = await answerAnd(
      ctx,
      Promise.all([readDemoCycle(backend, assetId, durationSec, now), stakeAmount(ctx.from.id)]),
    );
    const screen = read.ok
      ? launchScreen({
          assetId,
          durationSec,
          firstName: ctx.from.first_name,
          symbol: read.pair.symbol,
          amount,
        })
      : launchFailure(ctx, read, assetId, durationSec);
    await editOrReply(ctx, screen.text, screen.keyboard);
  });

  composer.callbackQuery(DEMO_GROUPS_CALLBACK_DATA, async (ctx) => {
    const read = await answerAnd(ctx, readDemoCatalog(backend));
    const screen = read.ok ? groupsScreen(read.catalog) : catalogFailure(ctx, read);
    await editOrReply(ctx, screen.text, screen.keyboard);
  });

  composer.callbackQuery(DEMO_PAGE_PATTERN, async (ctx) => {
    const group = groupOfData(ctx.match[1]);
    if (group === undefined) {
      await answerOnly(ctx);
      return;
    }
    const read = await answerAnd(ctx, readDemoCatalog(backend));
    const screen = read.ok
      ? pageScreen(read.catalog, group, Number(ctx.match[2]))
      : catalogFailure(ctx, read);
    await editOrReply(ctx, screen.text, screen.keyboard);
  });

  composer.callbackQuery(DEMO_ASSET_PATTERN, async (ctx) => {
    const assetId = assetIdOf(ctx.match[1]);
    if (assetId === undefined) {
      await answerOnly(ctx);
      return;
    }
    const read = await answerAnd(ctx, readDemoCatalog(backend));
    const screen = read.ok ? assetScreen(read.catalog, assetId) : catalogFailure(ctx, read);
    await editOrReply(ctx, screen.text, screen.keyboard);
  });

  composer.callbackQuery(DEMO_DURATION_PATTERN, async (ctx) => {
    const assetId = assetIdOf(ctx.match[1]);
    const durationSec = durationOf(ctx.match[2]);
    if (assetId === undefined || durationSec === undefined) {
      await answerOnly(ctx);
      return;
    }
    const read = await answerAnd(ctx, readDemoTrade(backend, assetId, durationSec, now));
    const screen = read.ok
      ? {
          text: demoSummary(read.pair, durationSec),
          keyboard: new InlineKeyboard()
            .text(LABELS.demoAnalysisButton, demoAnalysisCallbackData(assetId, durationSec))
            .row()
            .text(LABELS.demoBackDurationsButton, demoAssetCallbackData(assetId))
            .text(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA),
        }
      : tradeFailure(ctx, read, assetId);
    await editOrReply(ctx, screen.text, screen.keyboard);
  });

  // The analysis (#126): the check on the catalog read at this press, never on the one the
  // summary was drawn from; then «⏳» in place of the summary, the signal, and the screen in place
  // of «⏳». The signal is asked for only once «⏳» was delivered: after an edit of unknown outcome
  // nothing more is sent, and a decision nobody sees would cost a broker call.
  composer.callbackQuery(DEMO_ANALYSIS_PATTERN, async (ctx) => {
    const assetId = assetIdOf(ctx.match[1]);
    const durationSec = durationOf(ctx.match[2]);
    if (assetId === undefined || durationSec === undefined) {
      await answerOnly(ctx);
      return;
    }
    const read = await answerAnd(ctx, readDemoTrade(backend, assetId, durationSec, now));
    if (!read.ok) {
      const screen = tradeFailure(ctx, read, assetId);
      await editOrReply(ctx, screen.text, screen.keyboard);
      return;
    }
    const waiting = await editOrReply(
      ctx,
      TEXTS.analyzing({ subject: analysisSubject(read.pair, durationSec) }),
      NO_NEXT_STEP_REASONS.InProgress,
    );
    if (waiting === 'unknown') return;
    const screen = await evaluate(read.pair, durationSec);
    const keyboard = analysisKeyboard(assetId, durationSec, screen, read.pair);
    // «⏳» went as a new message: the result follows it rather than editing the summary again
    if (waiting === 'sent') await replyHtml(ctx, screen.text, { reply_markup: keyboard });
    else await editOrReply(ctx, screen.text, keyboard);
  });

  // «➕ Ещё» (#360): only the keyboard of the pressed analysis changes. The amount is read at this
  // press, and the stake button gets a fresh nonce, as a render of the analysis gives. The catalog
  // is not read: the stake press reads it and refuses a pair closed since.
  composer.callbackQuery(ANALYSIS_MORE_PATTERN, async (ctx) => {
    const data = analysisMoreDataOf(ctx.match);
    if (data === undefined) {
      await answerOnly(ctx);
      return;
    }
    const amount = await answerAnd(ctx, stakeAmount(ctx.from.id));
    await editKeyboard(
      ctx,
      expandedKeyboard(data.assetId, data.durationSec, data.action, amount, data.payoutAccepted),
    );
  });

  // A thrown call (unreachable, a non-2xx, a broken body) and every fetch_failed but
  // rate_limited are logged: rate_limited is the broker's ordinary answer, told to the user.
  async function evaluate(pair: PairView, durationSec: DemoDurationSec): Promise<AnalysisScreen> {
    let response;
    try {
      response = await backend.evaluateSignal(pair.id, intervalForDuration(durationSec));
    } catch (error) {
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error) },
        'signal not evaluated',
      );
      return analysisUnavailableScreen(pair, durationSec);
    }
    if (
      response.outcome === SignalFeedOutcome.FetchFailed &&
      response.code !== BrokerRestErrorCode.RateLimited
    ) {
      logger.warn({ signalCode: response.code }, 'signal not evaluated');
    }
    return analysisScreen({ pair, durationSec, response });
  }

  // The two reads together; a failed one is the screen's retry with the pressed data and the way
  // to the manual choice. A failed catalog reads as the catalog's own failure. A body without the
  // duration's list is a deploy mismatch, not «no signals»: the same retry, and one warn.
  async function readSignalsScreen(
    ctx: Context,
    durationSec: DemoDurationSec,
  ): Promise<DemoScreen> {
    const [signals, read] = await Promise.all([readSignals(), readDemoCatalog(backend)]);
    if (!read.ok) return withManual(catalogFailure(ctx, read));
    const retry = (): DemoScreen =>
      withManual({
        text: TEXTS.unavailable,
        keyboard: new InlineKeyboard().text(
          LABELS.demoRetryButton,
          ctx.callbackQuery?.data ?? demoSignalsCallbackData(durationSec),
        ),
      });
    if (signals === null) return retry();
    const screen = signalsScreen(signals, read.catalog, durationSec, now());
    if (screen !== undefined) return screen;
    logger.warn({ interval: intervalForDuration(durationSec) }, 'trading signals list missing');
    return retry();
  }

  async function readSignals(): Promise<TradingSignalsResponse | null> {
    try {
      return await backend.readSignals();
    } catch (error) {
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error) },
        'trading signals not read',
      );
      return null;
    }
  }

  // The amount for the stake button's label (#297), drawn by «➕ Ещё» (#360), and the launch
  // screen (#320). A failed read only drops the amount: the signal or the pair decides the screen,
  // and the press reads access again anyway.
  async function stakeAmount(telegramUserId: number): Promise<DecimalString | null> {
    try {
      return effectiveStake(await backend.readTradingAccess(String(telegramUserId)));
    } catch (error) {
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error) },
        'trading access not read for the stake label',
      );
      return null;
    }
  }

  // The session row first on every `decided` answer (#360) of a pair paying at least the cycle
  // floor (#379, the screen says why otherwise), «➕ Ещё» on a signal, then «🔄 Повторить анализ»
  // and the way back
  function analysisKeyboard(
    assetId: number,
    durationSec: DemoDurationSec,
    screen: AnalysisScreen,
    pair: PairView,
  ): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    const payoutAccepted = pairPayoutAccepted(pair);
    if (screen.session) appendSessionRow(keyboard, assetId, durationSec, payoutAccepted);
    if (screen.stake !== null) {
      keyboard
        .text(
          LABELS.analysisMoreButton,
          analysisMoreCallbackData(assetId, durationSec, screen.stake, payoutAccepted),
        )
        .row();
    }
    return appendAnalysisTail(keyboard, assetId, durationSec);
  }

  // what «➕ Ещё» draws in place of the collapsed keyboard: the stake row joins it
  function expandedKeyboard(
    assetId: number,
    durationSec: DemoDurationSec,
    action: TradeAction,
    amount: DecimalString | null,
    payoutAccepted: boolean,
  ): InlineKeyboard {
    const keyboard = appendSessionRow(new InlineKeyboard(), assetId, durationSec, payoutAccepted)
      .text(
        stakeButtonLabel(action, amount),
        stakeCallbackData(assetId, durationSec, action, newStakeNonce(), stakeFingerprint(amount)),
      )
      .text(LABELS.stakeMenuButton, stakeMenuCallbackData(assetId, durationSec))
      .row();
    return appendAnalysisTail(keyboard, assetId, durationSec);
  }

  // its own row: the session's trades follow the orchestrator's signal at each trade, not this
  // screen's direction
  function appendSessionRow(
    keyboard: InlineKeyboard,
    assetId: number,
    durationSec: DemoDurationSec,
    payoutAccepted: boolean,
  ): InlineKeyboard {
    if (!sessionFits(durationSec) || !payoutAccepted) return keyboard;
    return keyboard
      .text(
        sessionStartButtonLabel(DEFAULT_SESSION_TRADES),
        sessionStartCallbackData(assetId, durationSec),
      )
      .row();
  }

  function appendAnalysisTail(
    keyboard: InlineKeyboard,
    assetId: number,
    durationSec: DemoDurationSec,
  ): InlineKeyboard {
    return keyboard
      .text(LABELS.repeatAnalysisButton, demoAnalysisCallbackData(assetId, durationSec))
      .row()
      .text(LABELS.demoBackDurationsButton, demoAssetCallbackData(assetId))
      .text(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA);
  }

  // The spinner is worth less than the screen: a refused answer ("query is too old") is logged
  // and the screen still goes. The two calls are independent, so they run together.
  async function answerAnd<T>(ctx: Context, work: Promise<T>): Promise<T> {
    const [, result] = await Promise.all([ctx.answerCallbackQuery().catch(logAnswerFailure), work]);
    return result;
  }

  // forged or stale data: stop the spinner, say nothing
  async function answerOnly(ctx: Context): Promise<void> {
    await ctx.answerCallbackQuery().catch(logAnswerFailure);
  }

  function logAnswerFailure(error: unknown): void {
    logger.warn(
      { ...errorLogFields(error), ...telegramErrorFields(error, 'answerCallbackQuery') },
      'answering the callback query failed',
    );
  }

  // Every refusal of an edit is classified (screen.ts): already shown — the same screen pressed
  // twice — is done; a message that is gone or cannot be edited gets the screen anew; any other
  // refusal goes to bot.catch with nothing sent, the keyboard on screen being the retry. A
  // transport failure leaves the edit unknown and sends nothing more; anything else is a bug.
  // The outcome tells the analysis where its result goes. With a reason in place of a keyboard
  // the edit removes the one on screen (send.ts).
  async function editOrReply(
    ctx: Context,
    text: TelegramHtml,
    next: InlineKeyboard | NoNextStepReason,
  ): Promise<EditOutcome> {
    try {
      if (typeof next === 'string') await editMessageTextHtmlWithoutNextStep(ctx, text, next);
      else await editMessageTextHtml(ctx, text, { reply_markup: next });
      return 'edited';
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'shown') {
        logger.info({ ...telegramErrorFields(error) }, 'the demo screen already shows this');
        return 'shown';
      } else if (refusal === 'gone') {
        logger.warn(
          { ...errorLogFields(error), ...telegramErrorFields(error) },
          'the demo screen was not edited, sending it anew',
        );
        if (typeof next === 'string') await replyHtmlWithoutNextStep(ctx, text, next);
        else await replyHtml(ctx, text, { reply_markup: next });
        return 'sent';
      } else if (error instanceof HttpError) {
        logger.error(
          {
            ...errorLogFields(error),
            ...telegramErrorFields(error, 'editMessageText'),
            updateId: ctx.update.update_id,
          },
          'the demo screen edit failed in transport, sending nothing more',
        );
        return 'unknown';
      } else {
        throw error;
      }
    }
  }

  // «➕ Ещё»'s edit: only the keyboard, so there is no text to send anew. Already shown is done; a
  // message gone or not editable gets nothing — the analysis the button sat under is not on
  // screen; a transport failure sends nothing more; any other refusal goes to bot.catch.
  async function editKeyboard(ctx: Context, reply_markup: InlineKeyboard): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup });
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'shown') {
        logger.info(
          { ...telegramErrorFields(error, 'editMessageReplyMarkup') },
          'the analysis keyboard already shows this',
        );
      } else if (refusal === 'gone') {
        logger.warn(
          { ...errorLogFields(error), ...telegramErrorFields(error, 'editMessageReplyMarkup') },
          'the analysis keyboard was not expanded',
        );
      } else if (error instanceof HttpError) {
        logger.error(
          {
            ...errorLogFields(error),
            ...telegramErrorFields(error, 'editMessageReplyMarkup'),
            updateId: ctx.update.update_id,
          },
          'the analysis keyboard edit failed in transport, sending nothing more',
        );
      } else {
        throw error;
      }
    }
  }

  // A read that did not give a fresh catalog: the text and «🔄 Повторить» with the pressed data,
  // which is always safe since nothing here writes anything. Only backend_failed is logged: the
  // backend logs each failed refresh behind a 503 or a stale snapshot itself.
  function catalogFailure(ctx: Context, read: Exclude<DemoCatalogRead, { ok: true }>): DemoScreen {
    const keyboard = new InlineKeyboard().text(
      LABELS.demoRetryButton,
      ctx.callbackQuery?.data ?? DEMO_CALLBACK_DATA,
    );
    switch (read.reason) {
      case 'catalog_unavailable':
        return { text: TEXTS.demoCatalogUnavailable, keyboard };
      case 'catalog_stale':
        return { text: TEXTS.demoCatalogStale, keyboard };
      case 'backend_failed':
        logger.warn(
          { ...errorLogFields(read.error), ...backendErrorFields(read.error) },
          'demo catalog not read',
        );
        return { text: TEXTS.unavailable, keyboard };
    }
  }

  function tradeFailure(
    ctx: Context,
    read: Exclude<DemoTradeRead, { ok: true }>,
    assetId: number,
  ): DemoScreen {
    switch (read.reason) {
      case 'catalog_unavailable':
      case 'catalog_stale':
      case 'backend_failed':
        return catalogFailure(ctx, read);
      case 'pair_missing':
        return pairMissingScreen();
      case 'pair_closed':
        return pairClosedScreen(read.catalog, read.pair);
      case 'duration_unsupported':
        return {
          text: TEXTS.demoDurationUnsupported({ symbol: read.pair.symbol }),
          keyboard: new InlineKeyboard()
            .text(LABELS.demoBackDurationsButton, demoAssetCallbackData(assetId))
            .text(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA),
        };
    }
  }

  // The launch press refuses a pair below the cycle floor with the way back to the list and to the
  // manual path, whose single trade the floor does not restrict (#379)
  function launchFailure(
    ctx: Context,
    read: Exclude<DemoCycleRead, { ok: true }>,
    assetId: number,
    durationSec: DemoDurationSec,
  ): DemoScreen {
    if (read.reason !== 'payout_too_low') return tradeFailure(ctx, read, assetId);
    const { pair } = read;
    return {
      text: TEXTS.demoPayoutTooLow({
        symbol: pair.symbol,
        payout: String(pair.payout),
        payoutFloor: String(MIN_CYCLE_PAYOUT_PCT),
        breakEven: formatBreakEven(pair.payout),
      }),
      keyboard: new InlineKeyboard()
        .text(LABELS.backToListButton, demoSignalsCallbackData(durationSec))
        .row()
        .text(LABELS.demoManualButton, DEMO_GROUPS_CALLBACK_DATA),
    };
  }

  // The types present in the catalog, each with its count of open pairs; a type with no pair
  // that accepts a demo duration has no button. An empty catalog has nothing to choose from, so it
  // reads as unavailable; a catalog whose pairs all refuse 5 and 15 s says so (#313).
  function groupsScreen(catalog: PairsCatalogResponse): DemoScreen {
    const present = DEMO_ASSET_GROUPS.filter((group) => pairsOf(catalog, group).length > 0);
    if (present.length === 0) {
      return {
        text: catalog.pairs.length === 0 ? TEXTS.demoCatalogUnavailable : TEXTS.demoNoShortPairs,
        keyboard: new InlineKeyboard().text(LABELS.demoRetryButton, DEMO_GROUPS_CALLBACK_DATA),
      };
    }
    const nowMs = now();
    const keyboard = new InlineKeyboard();
    present.forEach((group, index) => {
      if (index > 0 && index % 2 === 0) keyboard.row();
      const open = openPairsOf(catalog, group, nowMs).length;
      keyboard.text(groupButtonLabel(group, open), demoPageCallbackData(group, 0));
    });
    return { text: TEXTS.demoGroups, keyboard };
  }

  // DEMO_PAGE_SIZE pairs in two columns, then «◀️» where a page before exists, «↩️ Типы», «▶️»
  // where a page after exists. A type with no open pair says it is closed by the schedule; one
  // with no listed pair - an old «💱 …» button, or «↩️ Активы» from a pair that admits none -
  // says there is no pair for short trades (#329).
  function pageScreen(
    catalog: PairsCatalogResponse,
    group: DemoAssetGroup,
    requested: number,
  ): DemoScreen {
    if (pairsOf(catalog, group).length === 0) {
      return {
        text: catalog.pairs.length === 0 ? TEXTS.demoCatalogUnavailable : TEXTS.demoNoShortPairs,
        keyboard: backToGroups(),
      };
    }
    const open = openPairsOf(catalog, group, now());
    if (open.length === 0) {
      return {
        text: TEXTS.demoGroupClosed({ group: DEMO_GROUP_LABELS[group] }),
        keyboard: backToGroups(),
      };
    }
    const { pairs, page, pageCount } = pageOf(open, requested);
    const keyboard = new InlineKeyboard();
    pairs.forEach((pair, index) => {
      if (index > 0 && index % 2 === 0) keyboard.row();
      keyboard.text(pairButtonLabel(pair.symbol, pair.payout), demoAssetCallbackData(pair.id));
    });
    keyboard.row();
    if (page > 0) keyboard.text(LABELS.demoPrevButton, demoPageCallbackData(group, page - 1));
    keyboard.text(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA);
    if (page < pageCount - 1) {
      keyboard.text(LABELS.demoNextButton, demoPageCallbackData(group, page + 1));
    }
    return { text: demoPairsScreen(group, page, pageCount), keyboard };
  }

  // The durations the pair admits, in one row, then the way back to its page and to the
  // types. The pair is checked again here: it can close between two presses.
  function assetScreen(catalog: PairsCatalogResponse, assetId: number): DemoScreen {
    const checked = checkDemoPair(catalog, assetId, now());
    if (!checked.ok) {
      return checked.reason === 'pair_missing'
        ? pairMissingScreen()
        : pairClosedScreen(catalog, checked.pair);
    }
    const { pair } = checked;
    const options = durationOptions(pair);
    if (options.length === 0) {
      return {
        text: TEXTS.demoNoDuration({ symbol: pair.symbol }),
        keyboard: backToPairs(catalog, pair),
      };
    }
    const keyboard = new InlineKeyboard();
    options.forEach((sec) => {
      keyboard.text(DEMO_DURATION_LABELS[sec], demoDurationCallbackData(pair.id, sec));
    });
    keyboard.row();
    return {
      text: demoDurationsScreen(pair),
      keyboard: appendBackToPairs(keyboard, catalog, pair),
    };
  }

  function pairMissingScreen(): DemoScreen {
    return { text: TEXTS.demoPairMissing, keyboard: backToGroups() };
  }

  function pairClosedScreen(catalog: PairsCatalogResponse, pair: PairView): DemoScreen {
    return {
      text: TEXTS.demoPairClosed({ symbol: pair.symbol }),
      keyboard: backToPairs(catalog, pair),
    };
  }

  const withManual = (screen: DemoScreen): DemoScreen => ({
    text: screen.text,
    keyboard: screen.keyboard.row().text(LABELS.demoManualButton, DEMO_GROUPS_CALLBACK_DATA),
  });

  const backToGroups = () =>
    new InlineKeyboard().text(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA);

  const backToPairs = (catalog: PairsCatalogResponse, pair: PairView) =>
    appendBackToPairs(new InlineKeyboard(), catalog, pair);

  // «↩️ Активы» leads to the page the pair is listed on (the first page when it is not listed),
  // then «↩️ Типы»
  function appendBackToPairs(
    keyboard: InlineKeyboard,
    catalog: PairsCatalogResponse,
    pair: PairView,
  ): InlineKeyboard {
    const group = groupOf(pair.type);
    const page = pageIndexOf(openPairsOf(catalog, group, now()), pair.id);
    return keyboard
      .text(LABELS.demoBackPairsButton, demoPageCallbackData(group, page))
      .text(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA);
  }

  return composer;
}

type EditOutcome = 'edited' | 'shown' | 'sent' | 'unknown';

export interface DemoScreen {
  text: TelegramHtml;
  keyboard: InlineKeyboard;
}
