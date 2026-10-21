import { createHash, randomBytes } from 'node:crypto';
import { Composer, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import {
  deleteRefusal,
  editRefusal,
  BrokerRestErrorCode,
  checkStake,
  comparePairsByPayout,
  createTradeIntentRequestSchema,
  decimalLessThan,
  decimalStringSchema,
  DEFAULT_SESSION_CYCLES,
  STAKE_AMOUNT_PATTERN,
  errorLogFields,
  normalizeDecimal,
  pairLabel,
  sessionFitsDeadline,
  SessionStakeStrategy,
  intervalForDuration,
  pairPayoutAccepted,
  PAIR_TYPE_GROUPS,
  pairTypeGroupOf,
  SignalFeedOutcome,
  stakeIsRisky,
  stakePresets,
  telegramHtml,
  TradeAction,
  TradeMode,
  tradeAmountSchema,
  tradeModeSchema,
  type BrokerBalanceView,
  type DecimalString,
  type PairLabel,
  type PairsCatalogResponse,
  type PairTypeGroup,
  type PairView,
  type TelegramHtml,
  type TradingAccessResponse,
  type TradingSignalsResponse,
  DEMO_CALLBACK_DATA,
  DEMO_SIGNALS_CALLBACK_DATA,
  MENU_CALLBACK_DATA,
  demoAnalysisCallbackData,
  telegramErrorFields,
} from '@binarius/shared';
import {
  analysisScreen,
  analysisSubject,
  analysisUnavailableScreen,
  type AnalysisScreen,
} from './analysis';
import { backendErrorFields, type BackendClient } from './backend-client';
import {
  checkDemoTrade,
  DEMO_DURATION_SEC,
  DEMO_DURATIONS_SEC,
  LEGACY_DEMO_DURATIONS_SEC,
  openPairsOf,
  pageIndexOf,
  pageOf,
  pairsOf,
  readDemoCatalog,
  readDemoTrade,
  type DemoCatalogRead,
  type DemoDurationSec,
  type DemoTradeCheck,
  type DemoTradeRead,
} from './demo-catalog';
import type { Logger } from './logging';
import {
  editMessageTextByIdHtml,
  editMessageTextHtml,
  editMessageTextHtmlWithoutNextStep,
  NO_NEXT_STEP_REASONS,
  replyHtml,
  replyHtmlWithoutNextStep,
  replyWithPhotoHtml,
} from './send';
import type { SetupCardPhotos } from './setup-card';
import type { SignalWaiter, SignalWaitScreens } from './signal-wait';
import { currentLanguage } from './language';
import { stakeAccess } from './stake-access';
import {
  assetLabelOf,
  cycleStakeLabel,
  cycleStakeText,
  DEMO_DURATION_LABELS,
  demoPairsScreen,
  demoSummary,
  groupButtonLabel,
  LABELS,
  launchCycleButtonLabel,
  launchText,
  pairButtonLabel,
  sessionStartButtonLabel,
  signalButtonLabel,
  stakeButtonLabel,
  stakeSavedLine,
  TEXTS,
  DEMO_GROUP_LABELS,
} from './texts';

// The demo's screens (#125, docs/bot-demo.md): the pairs with a signal now at the demo's one
// duration, 5 s (#685), and the amount of a cycle on one (#476; the launch of #320 in real); the
// asset types, one type's pairs by page, a pair's summary, the analysis behind «📊 Анализ» (#126)
// and the single trade behind its «➕ Ещё» (#360). The bot keeps no state for them but the wait for
// a signal (#664, signal-wait.ts): what the user chose travels in the callback data, so a restart,
// an old message and a second device all lead to the same screen, and every screen reads the
// catalog anew.

// Bot API allows 1-64 bytes; the longest of the screens' data, `demo:t:cryptocurrency:9999`, is 26,
// `demo:l:2147483647:5:n` 21 and `demo:sig` 8 (DEMO_SIGNALS_CALLBACK_DATA, bot-navigation.ts).

// Where the amount screen of a demo cycle (#476) was opened: `l` the signal list (no token in the
// data, as before #476), `a` the analysis, `n` the offer under a finished trade or «🔁 Ещё сессия».
// `l` and `a` edit the pressed message; `n` sends the screen as a new message, so the trade's or
// the session's message stays, and the screen it draws carries `a`: its own presses edit it.
export type CycleOrigin = 'l' | 'a' | 'n';
// the way back of the amount screen: to the list, or to the pair's analysis
export type CycleBack = Exclude<CycleOrigin, 'n'>;
export const cycleBackOf = (origin: CycleOrigin): CycleBack => (origin === 'l' ? 'l' : 'a');
export const demoLaunchCallbackData = (
  assetId: number,
  durationSec: DemoDurationSec,
  origin: CycleOrigin = 'l',
): string => `demo:l:${assetId}:${durationSec}${origin === 'l' ? '' : `:${origin}`}`;
// An amount of the amount screen (#476): the press saves it as the demo stake, then starts the
// cycle (cycle-stake.ts). The amount in the data is the one saved, as the picker's preset: a stale
// button saves what it shows, bounded by the backend. The longest,
// `demo:sa:2147483647:5:999999999999.99999999:a`, is 44 bytes.
export const cycleStakeCallbackData = (
  assetId: number,
  durationSec: DemoDurationSec,
  amount: string,
  back: CycleBack,
): string => `demo:sa:${assetId}:${durationSec}:${amount}:${back}`;
// «✏️ Своя сумма» of the amount screen: the prompt, then the typed amount starts the cycle
export const cycleCustomCallbackData = (
  assetId: number,
  durationSec: DemoDurationSec,
  back: CycleBack,
): string => `demo:sc:${assetId}:${durationSec}:${back}`;
export const DEMO_GROUPS_CALLBACK_DATA = 'demo:g';
export const demoPageCallbackData = (group: PairTypeGroup, page: number): string =>
  `demo:t:${group}:${page}`;
// a pair of the manual path: its summary at the demo's duration (#685)
export const demoAssetCallbackData = (assetId: number): string => `demo:a:${assetId}`;
// «➕ Ещё» under the analysis on a signal (#360): the press draws the single trade's row in place
// of the collapsed keyboard. The direction and the mode the analysis text was drawn in (`d`/`r`,
// #121) are the render's: the expansion draws a stake button only in that mode, so a REAL button
// never sits under the demo disclaimer, nor a demo one under the real. The longest,
// `demo:more:2147483647:5:down:r`, is 29 bytes.
const ANALYSIS_MORE_PREFIX = 'demo:more:';
// also the stake picker's mode segment (#326, stake-picker.ts)
export const MODE_TOKENS = {
  [TradeMode.Demo]: 'd',
  [TradeMode.Real]: 'r',
} as const satisfies Record<TradeMode, string>;
export const analysisMoreCallbackData = (
  assetId: number,
  durationSec: DemoDurationSec,
  action: TradeAction,
  mode: TradeMode,
): string => `${ANALYSIS_MORE_PREFIX}${assetId}:${durationSec}:${action}:${MODE_TOKENS[mode]}`;
// The stake button behind «➕ Ещё» (#126, #360); the press opens the trade (#127, demo-trade.ts).
// The nonce is drawn once per expansion and is the trade's idempotency key: the same button
// pressed again replays its intent, a new expansion allows a new trade. The fingerprint is the amount the
// label shows (#297) and its mode (#121): the press refuses when the amount or the mode in effect
// now is another one. The longest,
// `demo:stake:2147483647:5:down:0123456789ab:0a1b2c`, is 48 bytes.
const STAKE_CALLBACK_PREFIX = 'demo:stake:';
export const stakeCallbackData = (
  assetId: number,
  durationSec: DemoDurationSec,
  action: TradeAction,
  nonce: string,
  fingerprint: string,
): string => `${STAKE_CALLBACK_PREFIX}${assetId}:${durationSec}:${action}:${nonce}:${fingerprint}`;
// 24 bits of the canonical amount, prefixed by the mode in real mode (#121), so a button drawn in
// one mode never matches a press in the other; a demo amount hashes as before #121, so a demo
// button drawn before it still trades. null (no amount to show) hashes '', so a button drawn
// without an amount never matches one with it.
export const stakeFingerprint = (amount: DecimalString | null, mode: TradeMode): string =>
  createHash('sha256')
    .update(
      amount === null
        ? ''
        : mode === TradeMode.Real
          ? `${TradeMode.Real}:${normalizeDecimal(amount)}`
          : normalizeDecimal(amount),
    )
    .digest('hex')
    .slice(0, 6);
// The amount a stake press trades in the user's mode: the saved stake of that mode, or the
// broker's minimum without one (#297 demo, #326 real). null when access has no broker snapshot
// to say it.
export const effectiveStake = (
  access: Pick<TradingAccessResponse, 'broker' | 'demoStake' | 'realStake' | 'tradingMode'>,
): DecimalString | null =>
  access.broker === null
    ? null
    : ((access.tradingMode === TradeMode.Real ? access.realStake : access.demoStake) ??
      access.broker.minTradeAmount);
// «💵 Сумма» beside the stake button, and under the stake refusals: the picker (stake-picker.ts)
// of that mode opened from the analysis, whose way back is that analysis
export const STAKE_PICKER_PREFIX = 'stk:';
export const stakeMenuCallbackData = (
  mode: TradeMode,
  assetId: number,
  durationSec: DemoDurationSec,
): string => `${STAKE_PICKER_PREFIX}o:${MODE_TOKENS[mode]}:a:${assetId}:${durationSec}`;
// the launch screen's «💵 Изменить ставку»: the picker whose way back is that launch screen
export const launchStakeCallbackData = (
  mode: TradeMode,
  assetId: number,
  durationSec: DemoDurationSec,
): string => `${STAKE_PICKER_PREFIX}o:${MODE_TOKENS[mode]}:p:${assetId}:${durationSec}`;
// The session button (#284, trading-session.ts) of the analysis screen, of a finished single trade
// (#360, demo-trade.ts), of the launch screen (#320) and «🔁 Ещё сессия», in real mode; in demo
// these doors open the amount screen since #476, and a demo datum is a button sent before it. It
// carries the mode it was drawn in (#327), which the backend compares with the user's: a demo
// button is byte for byte the one before #327. No nonce, by the owner's decision: an old button starts a new session once
// the previous one has ended, and while one is active the backend answers with it. The launch
// screen's adds SESSION_START_LAUNCH_TOKEN (#418): the bot keeps no state, so the token is how the
// start learns the pressed message is a launch screen, which it deletes once the session's status
// is sent. The longest, `real:sess:2147483647:5:l`, is 24 bytes.
export const SESSION_START_LAUNCH_TOKEN = 'l';
export const sessionStartCallbackData = (
  mode: TradeMode,
  assetId: number,
  durationSec: DemoDurationSec,
  launch = false,
): string =>
  `${mode}:sess:${assetId}:${durationSec}${launch ? `:${SESSION_START_LAUNCH_TOKEN}` : ''}`;
// The button shows only where a session of DEFAULT_SESSION_CYCLES fits the worker's deadline in
// its worst case (#552): the bot does not know the backend's strategy, so it counts martingale's,
// the default and the longer one (DEMO_DURATION_SEC: 5 × 4 × (5 + 120) s ≤ 1 h); the handler
// checks again, so an old or forged datum starts nothing. The count is a parameter so a test can
// reach the refusal: with today's duration a session fits.
export const sessionFits = (durationSec: number, cycles = DEFAULT_SESSION_CYCLES): boolean =>
  sessionFitsDeadline(cycles, durationSec, SessionStakeStrategy.Martingale);
// 48 bits: unique among one user's own renders is all it needs, since the key is per user
export const newStakeNonce = (): string => randomBytes(6).toString('hex');

// A group is matched loosely and checked against PAIR_TYPE_GROUPS in the handler, so a forged
// one stops the spinner like a forged id; a duration is one of DEMO_DURATIONS_SEC by the pattern.
// Each duration-carrying shape is built from an alternation, so the legacy patterns (#313, #685)
// are the same shapes over LEGACY_DEMO_DURATIONS_SEC.
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
  new RegExp(
    `^(${Object.values(TradeMode).join('|')}):sess:(\\d{1,10}):(${durations})(?::(${SESSION_START_LAUNCH_TOKEN}))?$`,
  );
// `demo:sig` and every `demo:sig:<sec>` an older bot drew (#382 to #685): the list in place
const DEMO_SIGNALS_PATTERN = new RegExp(`^demo:sig(?::(?:${DURATIONS}|${LEGACY_DURATIONS}))?$`);
const demoLaunchPattern = (durations: string) =>
  new RegExp(`^demo:l:(\\d{1,10}):(${durations})(?::(a|n))?$`);
const DEMO_LAUNCH_PATTERN = demoLaunchPattern(DURATIONS);
// the amount as the picker's preset (stake-picker.ts), parsed by tradeAmountSchema
const cycleStakePattern = (durations: string) =>
  new RegExp(`^demo:sa:(\\d{1,10}):(${durations}):(${STAKE_AMOUNT_PATTERN}):(l|a)$`);
export const CYCLE_STAKE_PATTERN = cycleStakePattern(DURATIONS);
const cycleCustomPattern = (durations: string) =>
  new RegExp(`^demo:sc:(\\d{1,10}):(${durations}):(l|a)$`);
export const CYCLE_CUSTOM_PATTERN = cycleCustomPattern(DURATIONS);
// both tokens are optional: a button #360 drew before #379 has neither, one #379 to #631 drew has
// the payout floor's verdict (`s`/`n`), ignored since the floor refuses nothing (#631)
const analysisMorePattern = (durations: string) =>
  new RegExp(
    `^${ANALYSIS_MORE_PREFIX}(\\d{1,10}):(${durations}):(${Object.values(TradeAction).join('|')})(?::(s|n))?(?::(d|r))?$`,
  );
export const ANALYSIS_MORE_PATTERN = analysisMorePattern(DURATIONS);
const DEMO_DURATION_PATTERN = demoDurationPattern(DURATIONS);
const DEMO_ANALYSIS_PATTERN = demoAnalysisPattern(DURATIONS);
export const STAKE_CALLBACK_PATTERN = stakeCallbackPattern(DURATIONS);
export const SESSION_START_PATTERN = sessionStartPattern(DURATIONS);
// Every shape with a duration the demo no longer offers (15 s until #685, the set before #313):
// the signals list as a new message (#685). Registered before the current patterns; the two sets
// of durations are disjoint (demo-catalog.test.ts).
export const LEGACY_DURATION_PATTERNS = [
  demoDurationPattern(LEGACY_DURATIONS),
  demoAnalysisPattern(LEGACY_DURATIONS),
  stakeCallbackPattern(LEGACY_DURATIONS),
  sessionStartPattern(LEGACY_DURATIONS),
  demoLaunchPattern(LEGACY_DURATIONS),
  cycleStakePattern(LEGACY_DURATIONS),
  cycleCustomPattern(LEGACY_DURATIONS),
  analysisMorePattern(LEGACY_DURATIONS),
  // a launch screen's button from before #382, which carried no duration
  /^demo:l:(\d{1,10})$/,
];

// A button drawn before #314 with the site sign-in, a session refresh or a mode-less picker form
// (#326): the spinner stops and the message loses its keyboard, so the old screen cannot be
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
const groupOfData = (raw: string | undefined): PairTypeGroup | undefined =>
  PAIR_TYPE_GROUPS.find((group) => group === raw);
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

// «➕ Ещё»'s data from an ANALYSIS_MORE_PATTERN match, undefined when forged. The floor's token
// (group 4) is read by nobody: every datum keeps its session row (#631). A datum without the mode
// token was drawn before #121, in demo.
export function analysisMoreDataOf(match: RegExpMatchArray | string):
  | {
      assetId: number;
      durationSec: DemoDurationSec;
      action: TradeAction;
      renderedMode: TradeMode;
    }
  | undefined {
  if (typeof match === 'string') return undefined;
  const assetId = assetIdOf(match[1]);
  const durationSec = durationOf(match[2]);
  const action = actionOf(match[3]);
  if (assetId === undefined || durationSec === undefined || action === undefined) return undefined;
  return {
    assetId,
    durationSec,
    action,
    renderedMode: match[5] === 'r' ? TradeMode.Real : TradeMode.Demo,
  };
}

// The session button's data from a SESSION_START_PATTERN match, undefined when forged or when
// the duration does not fit a session.
export function sessionStartDataOf(
  match: RegExpMatchArray | string,
  cycles = DEFAULT_SESSION_CYCLES,
): { mode: TradeMode; assetId: number; durationSec: DemoDurationSec; launch: boolean } | undefined {
  if (typeof match === 'string') return undefined;
  const mode = tradeModeSchema.safeParse(match[1]);
  const assetId = assetIdOf(match[2]);
  const durationSec = durationOf(match[3]);
  if (
    !mode.success ||
    assetId === undefined ||
    durationSec === undefined ||
    !sessionFits(durationSec, cycles)
  ) {
    return undefined;
  }
  return {
    mode: mode.data,
    assetId,
    durationSec,
    launch: match[4] === SESSION_START_LAUNCH_TOKEN,
  };
}

// What the amount screen's presses carry (#476), and the typed amount's dialog step
// (login-dialog.ts)
export interface CycleStakeStep {
  assetId: number;
  durationSec: DemoDurationSec;
  back: CycleBack;
}

const cycleBackOfData = (raw: string | undefined): CycleBack | undefined =>
  raw === 'l' || raw === 'a' ? raw : undefined;

// «✏️ Своя сумма»'s data from a CYCLE_CUSTOM_PATTERN match, undefined when forged
export function cycleCustomDataOf(match: RegExpMatchArray | string): CycleStakeStep | undefined {
  if (typeof match === 'string') return undefined;
  const assetId = assetIdOf(match[1]);
  const durationSec = durationOf(match[2]);
  const back = cycleBackOfData(match[3]);
  if (assetId === undefined || durationSec === undefined || back === undefined) return undefined;
  return { assetId, durationSec, back };
}

// An amount's data from a CYCLE_STAKE_PATTERN match, undefined when forged or when the duration
// does not fit a session
export function cycleStakeDataOf(
  match: RegExpMatchArray | string,
): (CycleStakeStep & { amount: DecimalString }) | undefined {
  if (typeof match === 'string') return undefined;
  const assetId = assetIdOf(match[1]);
  const durationSec = durationOf(match[2]);
  const amount = tradeAmountSchema.safeParse(match[3]);
  const back = cycleBackOfData(match[4]);
  if (
    assetId === undefined ||
    durationSec === undefined ||
    !amount.success ||
    back === undefined ||
    !sessionFits(durationSec)
  ) {
    return undefined;
  }
  return { assetId, durationSec, amount: amount.data, back };
}

// Up to SIGNALS_PER_GROUP pairs of every type with a signal, then the free places filled from the
// rest by payout (#460), so a list on a candle where currencies pay best still shows the other
// types. 12 places: two of each group. The list holds at least SIGNALS_MIN_SIZE pairs when that
// many have a signal (#631): the pairs paying less than MIN_CYCLE_PAYOUT_PCT fill it up to there.
export const SIGNALS_PER_GROUP = 2;
export const SIGNALS_LIST_SIZE = SIGNALS_PER_GROUP * PAIR_TYPE_GROUPS.length;
export const SIGNALS_MIN_SIZE = 5;

export interface ShownSignal {
  pair: PairView;
  action: TradeAction;
}

// The list of the signals screen (docs/bot-demo.md -> The signals screen): a pair the catalog does
// not list, that is closed now or that does not take the 5 s takes no place, since the launch
// would refuse it. The pairs paying at least MIN_CYCLE_PAYOUT_PCT come first, chosen by #460: the
// groups follow PAIR_TYPE_GROUPS, a fill sits in its own type's group, and inside a group the best
// payout comes first (comparePairsByPayout), so the route's order and the catalog's do not matter.
// Fewer than SIGNALS_MIN_SIZE of them, the pairs paying less follow as a tail, best payout first
// and with no quota by type, until the list reaches SIGNALS_MIN_SIZE (#631). #460 takes every pair
// while there are no more than SIGNALS_LIST_SIZE, so a tail stands only under fewer than five
// pairs at or above the key.
export function signalsShown(
  signals: readonly { assetId: number; action: TradeAction }[],
  catalog: PairsCatalogResponse,
  nowMs: number,
): ShownSignal[] {
  const checked: ShownSignal[] = [];
  for (const signal of signals) {
    const check = checkDemoTrade(catalog, signal.assetId, DEMO_DURATION_SEC, nowMs);
    if (check.ok) checked.push({ pair: check.pair, action: signal.action });
  }
  const byPayout = (a: ShownSignal, b: ShownSignal) => comparePairsByPayout(a.pair, b.pair);
  checked.sort(byPayout);
  const primary = checked.filter((item) => pairPayoutAccepted(item.pair));
  const taken = new Set<ShownSignal>();
  for (const group of PAIR_TYPE_GROUPS) {
    primary
      .filter((item) => pairTypeGroupOf(item.pair.type) === group)
      .slice(0, SIGNALS_PER_GROUP)
      .forEach((item) => taken.add(item));
  }
  for (const item of primary) {
    if (taken.size >= SIGNALS_LIST_SIZE) break;
    taken.add(item);
  }
  const shown = PAIR_TYPE_GROUPS.flatMap((group) =>
    primary.filter((item) => taken.has(item) && pairTypeGroupOf(item.pair.type) === group),
  );
  for (const item of checked) {
    if (shown.length >= SIGNALS_MIN_SIZE) break;
    if (!pairPayoutAccepted(item.pair)) shown.push(item);
  }
  return shown;
}

// The pairs with a signal on the last closed candle of the scanner of the demo's duration (#320,
// #685), chosen and ordered by signalsShown, each joined with the catalog for its symbol and
// payout. Two a row in signalsShown's order, across the types, the last alone when odd; the
// footer under the list (#419). No pair: the wait for the signals (#664), with the footer and no
// refresh — the bot edits the list into it once a pair has a signal. The list is a snapshot; the
// cycle checks the signal again before each trade. Undefined when the body has no list for the
// duration: a backend scanning other intervals.
export function signalsScreen(
  signals: TradingSignalsResponse,
  catalog: PairsCatalogResponse,
  nowMs: number,
): { screen: DemoScreen; listed: number } | undefined {
  const interval = intervalForDuration(DEMO_DURATION_SEC);
  const list = signals.lists.find((candidate) => candidate.interval === interval);
  if (list === undefined) return undefined;
  const shown = signalsShown(list.signals, catalog, nowMs);
  const keyboard = appendSignalButtons(new InlineKeyboard(), shown);
  const listed = shown.length;
  const label = DEMO_DURATION_LABELS[DEMO_DURATION_SEC];
  if (listed === 0) {
    return {
      screen: {
        text: TEXTS.signalsWaiting({ label }),
        keyboard: appendSignalsFooter(new InlineKeyboard()),
      },
      listed,
    };
  }
  return {
    screen: {
      text: TEXTS.demoSignalsHeader({ label }),
      keyboard: appendSignalsFooter(
        keyboard.text(LABELS.demoSignalsRefreshButton, DEMO_SIGNALS_CALLBACK_DATA),
      ),
    },
    listed,
  };
}

// The other pairs' buttons, two a row in the list's order, as the list draws them
function appendSignalButtons(
  keyboard: InlineKeyboard,
  shown: readonly ShownSignal[],
): InlineKeyboard {
  shown.forEach(({ pair, action }, index) => {
    if (index > 0 && index % 2 === 0) keyboard.row();
    keyboard.text(
      signalButtonLabel(pairLabel(pair), action, pair.payout),
      demoLaunchCallbackData(pair.id, DEMO_DURATION_SEC),
    );
  });
  // grammY's row() pushes an empty row: unguarded, a screen without them would lead with [].
  if (shown.length > 0) keyboard.row();
  return keyboard;
}

// The wait for a pair's signal (#664): its text, and while there are some the line and the
// buttons of the pairs with a signal now, then the manual path and the menu
export function pairWaitingScreen(
  base: TelegramHtml,
  alternatives: readonly ShownSignal[],
): DemoScreen {
  return {
    text: waitingText(base, alternatives.length > 0),
    keyboard: appendSignalsFooter(appendSignalButtons(new InlineKeyboard(), alternatives)),
  };
}

export const waitingText = (base: TelegramHtml, alternatives: boolean): TelegramHtml =>
  alternatives
    ? telegramHtml`${base}

${TEXTS.pairWaitingAlternatives}`
    : base;

export const pairWaitingText = (symbol: PairLabel | null, assetId: number): TelegramHtml =>
  TEXTS.pairWaiting({
    symbol: assetLabelOf(symbol, assetId),
    label: DEMO_DURATION_LABELS[DEMO_DURATION_SEC],
  });

// The start of trading (#664): the list after its 30 s, the wait past its bound or at the stop
export const expiredSignalsScreen = (): DemoScreen => ({
  text: TEXTS.signalsExpired({ label: DEMO_DURATION_LABELS[DEMO_DURATION_SEC] }),
  keyboard: new InlineKeyboard()
    .text(LABELS.showSignalsButton, DEMO_SIGNALS_CALLBACK_DATA)
    .text(LABELS.demoManualButton, DEMO_GROUPS_CALLBACK_DATA)
    .row()
    .text(LABELS.menuButton, MENU_CALLBACK_DATA),
});

// The list's footer (#685), also under its refusals: «🧭 Выбрать пару вручную» beside the first
// button of the row (refresh or retry), then «🏠 В меню» in a row of its own
export const appendSignalsFooter = (keyboard: InlineKeyboard): InlineKeyboard =>
  keyboard
    .text(LABELS.demoManualButton, DEMO_GROUPS_CALLBACK_DATA)
    .row()
    .text(LABELS.menuButton, MENU_CALLBACK_DATA);

// The launch of a session of DEFAULT_SESSION_CYCLES on a pair at the chosen duration (#320, #382):
// the session start of the analysis screen (#284), the picker with its way back here, the list.
// The picker draws it too, after a save (stake-picker.ts). Since #476 it is drawn in real mode only (#327): the cycle button is marked
// REAL and starts a real session, the picker is the real one; demo draws the amount screen.
export function launchScreen({
  assetId,
  durationSec,
  firstName,
  symbol,
  amount,
  saved,
  mode = TradeMode.Demo,
}: {
  assetId: number;
  durationSec: DemoDurationSec;
  firstName: string;
  symbol: PairLabel | null;
  amount: DecimalString | null;
  saved?: { amount: DecimalString | null; mode: TradeMode };
  mode?: TradeMode;
}): DemoScreen {
  const text = launchText({
    firstName,
    durationSec,
    symbol,
    amount,
    cycles: DEFAULT_SESSION_CYCLES,
    saved,
    mode,
  });
  return {
    text,
    keyboard: new InlineKeyboard()
      .text(
        launchCycleButtonLabel(mode),
        sessionStartCallbackData(mode, assetId, durationSec, true),
      )
      .row()
      .text(LABELS.stakeChangeButton, launchStakeCallbackData(mode, assetId, durationSec))
      .row()
      .text(LABELS.backToListButton, DEMO_SIGNALS_CALLBACK_DATA),
  };
}

// The amounts of the amount screen (#476): the picker's presets of the demo balance, plus the saved
// demo stake when it is within the bounds and not a preset, ascending. A saved stake out of the
// bounds now (above the balance) gets no button: the backend would refuse it.
export function cycleStakeAmounts({
  minTradeAmount,
  available,
  saved,
}: {
  minTradeAmount: DecimalString;
  available: DecimalString;
  saved: DecimalString | null;
}): DecimalString[] {
  const presets = stakePresets({ minTradeAmount, available });
  if (saved === null || checkStake(saved, { minTradeAmount, available }) !== null) return presets;
  const own = decimalStringSchema.parse(normalizeDecimal(saved));
  if (presets.includes(own)) return presets;
  return [...presets, own].sort((a, b) => (decimalLessThan(a, b) ? -1 : 1));
}

// small amounts three a row, the risky ones two a row below them, as the owner's example (#476)
const CALM_PER_ROW = 3;
const RISKY_PER_ROW = 2;

// The amounts of a demo cycle and the one in effect (the saved demo stake, or the broker's minimum
// without one), drawn by the amount screen and under the analysis card (#482).
export interface CycleAmounts {
  amounts: DecimalString[];
  current: DecimalString;
}

export const cycleAmountsOf = (
  access: Pick<TradingAccessResponse, 'demoStake'>,
  broker: BrokerBalanceView,
): CycleAmounts => ({
  amounts: cycleStakeAmounts({
    minTradeAmount: broker.minTradeAmount,
    available: broker.demo.available,
    saved: access.demoStake,
  }),
  current: decimalStringSchema.parse(normalizeDecimal(access.demoStake ?? broker.minTradeAmount)),
});

// The amount rows, ✅ on the one in effect, then «✏️ Своя сумма» with no row closed after it: the
// amount screen puts its way back beside it, the card closes the row itself. No amount, no button.
export function appendCycleAmounts(
  keyboard: InlineKeyboard,
  { assetId, durationSec, back }: CycleStakeStep,
  { amounts, current }: CycleAmounts,
): InlineKeyboard {
  const appendRows = (group: DecimalString[], perRow: number) => {
    group.forEach((amount, index) => {
      if (index > 0 && index % perRow === 0) keyboard.row();
      keyboard.text(
        cycleStakeLabel(amount, amount === current),
        cycleStakeCallbackData(assetId, durationSec, amount, back),
      );
    });
    if (group.length > 0) keyboard.row();
  };
  appendRows(
    amounts.filter((amount) => !stakeIsRisky(amount)),
    CALM_PER_ROW,
  );
  appendRows(amounts.filter(stakeIsRisky), RISKY_PER_ROW);
  if (amounts.length > 0) {
    keyboard.text(LABELS.stakeCustomButton, cycleCustomCallbackData(assetId, durationSec, back));
  }
  return keyboard;
}

// the amount screen's way back: to the signal list, or to the pair's analysis
export function appendCycleBack(
  keyboard: InlineKeyboard,
  { assetId, durationSec, back }: CycleStakeStep,
): InlineKeyboard {
  return back === 'l'
    ? keyboard.text(LABELS.backToListButton, DEMO_SIGNALS_CALLBACK_DATA)
    : keyboard.text(LABELS.stakeBackAnalysisButton, demoAnalysisCallbackData(assetId, durationSec));
}

// The amount screen of a demo session of DEFAULT_SESSION_CYCLES (#476, docs/bot-demo.md → The amount
// screen), in place of the launch screen in demo: the amounts, ✅ on the one in effect (the saved
// demo stake, or the broker's minimum without one), then «✏️ Своя сумма» and the way back. No
// amount (the balance is below the minimum): the picker's line and the way back only.
export function cycleStakeScreen({
  step,
  firstName,
  symbol,
  access,
  broker,
  saved,
}: {
  step: CycleStakeStep;
  firstName: string;
  symbol: PairLabel | null;
  access: Pick<TradingAccessResponse, 'tokens' | 'broker' | 'demoStake' | 'realStake'>;
  broker: BrokerBalanceView;
  saved?: { amount: DecimalString | null; mode: TradeMode };
}): DemoScreen {
  const shown = cycleAmountsOf(access, broker);
  return {
    text: cycleStakeText({
      firstName,
      durationSec: step.durationSec,
      symbol,
      stake: shown.current,
      access,
      broker,
      empty: shown.amounts.length === 0,
      ...(saved === undefined ? {} : { saved }),
    }),
    keyboard: appendCycleBack(appendCycleAmounts(new InlineKeyboard(), step, shown), step),
  };
}

// The amount screen from an access read (#476): its refusals (stake-access.ts) under the same way
// back, or the amounts. `access` null is a failed read: «🔄 Повторить» reads it again — the data
// opens a screen, nothing is written — and the way back. The press of a pair and a picker save
// from an old launch screen (stake-picker.ts) draw it; a user in real mode gets the launch
// screen instead, from both.
export function demoCycleScreen({
  step,
  firstName,
  symbol,
  access,
  connectKeyboard,
  saved,
}: {
  step: CycleStakeStep;
  firstName: string;
  symbol: PairLabel | null;
  access: TradingAccessResponse | null;
  connectKeyboard: () => InlineKeyboard;
  saved?: { amount: DecimalString | null; mode: TradeMode };
}): DemoScreen {
  const back = (keyboard: InlineKeyboard) => appendCycleBack(keyboard, step);
  const underSaved = (screen: DemoScreen): DemoScreen =>
    saved === undefined
      ? screen
      : {
          text: telegramHtml`${stakeSavedLine(saved.mode, { firstName, stake: saved.amount })}

${screen.text}`,
          keyboard: screen.keyboard,
        };
  if (access === null) {
    return underSaved({
      text: TEXTS.unavailable,
      keyboard: back(
        new InlineKeyboard()
          .text(
            LABELS.demoRetryButton,
            demoLaunchCallbackData(step.assetId, step.durationSec, step.back),
          )
          .row(),
      ),
    });
  }
  const checked = stakeAccess(access, back, connectKeyboard);
  if ('refusal' in checked) return underSaved(checked.refusal);
  return cycleStakeScreen({
    step,
    firstName,
    symbol,
    access,
    broker: checked.broker,
    ...(saved === undefined ? {} : { saved }),
  });
}

// The amounts under a signal's card and in its «➕ Ещё» (#482): in demo, with a broker snapshot
// to draw them from (stakeAccess: a blocked user gets none), on a duration a cycle may start on —
// the session row's condition. Otherwise null, and the session row stays: its press opens the
// amount screen, which says why.
export function cardAmountsOf(
  access: TradingAccessResponse | null,
  durationSec: DemoDurationSec,
  connectKeyboard: () => InlineKeyboard,
): CycleAmounts | null {
  if (access === null || access.tradingMode !== TradeMode.Demo) return null;
  if (!sessionFits(durationSec)) return null;
  const checked = stakeAccess(access, (keyboard) => keyboard, connectKeyboard);
  if (!('broker' in checked)) return null;
  const shown = cycleAmountsOf(access, checked.broker);
  return shown.amounts.length > 0 ? shown : null;
}

// The session row first on a signal (#360; never without one, #509) at any payout (#631),
// in the user's mode (#327) — under a signal's card in demo the amounts of #476 in its place (#482) — «➕ Ещё» on a signal, then
// «🔄 Повторить анализ» and the way back
export function analysisKeyboard(
  assetId: number,
  durationSec: DemoDurationSec,
  screen: AnalysisScreen,
  mode: TradeMode,
  amounts: CycleAmounts | null,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (screen.photo !== null && amounts !== null) {
    appendCycleAmounts(keyboard, { assetId, durationSec, back: 'a' }, amounts).row();
  } else if (screen.session) {
    appendSessionRow(keyboard, assetId, durationSec, mode);
  }
  if (screen.stake !== null) {
    keyboard
      .text(
        LABELS.analysisMoreButton,
        analysisMoreCallbackData(assetId, durationSec, screen.stake, mode),
      )
      .row();
  }
  return appendAnalysisTail(keyboard, assetId, durationSec);
}

// What «➕ Ещё» draws in place of the collapsed keyboard: the stake row joins it, with «💵 Сумма»
// opening the picker of the same mode (#326). In real mode (#121) the stake button and the
// session row (#327) are marked REAL; in demo the amounts stay above it where the card drew them
// (#482), read at this press.
export function expandedKeyboard(
  assetId: number,
  durationSec: DemoDurationSec,
  action: TradeAction,
  amount: DecimalString | null,
  mode: TradeMode,
  amounts: CycleAmounts | null,
): InlineKeyboard {
  const stakeData = stakeCallbackData(
    assetId,
    durationSec,
    action,
    newStakeNonce(),
    stakeFingerprint(amount, mode),
  );
  const label = stakeButtonLabel(action, amount, mode);
  const keyboard = (
    amounts === null
      ? appendSessionRow(new InlineKeyboard(), assetId, durationSec, mode)
      : appendCycleAmounts(new InlineKeyboard(), { assetId, durationSec, back: 'a' }, amounts).row()
  )
    .text(label, stakeData)
    .text(LABELS.stakeMenuButton, stakeMenuCallbackData(mode, assetId, durationSec))
    .row();
  return appendAnalysisTail(keyboard, assetId, durationSec);
}

// its own row: the session's trades follow the orchestrator's signal at each trade, not this
// screen's direction
function appendSessionRow(
  keyboard: InlineKeyboard,
  assetId: number,
  durationSec: DemoDurationSec,
  mode: TradeMode,
): InlineKeyboard {
  if (!sessionFits(durationSec)) return keyboard;
  // in demo the amount screen first (#476), edited in place of the analysis
  return keyboard
    .text(
      sessionStartButtonLabel(DEFAULT_SESSION_CYCLES, mode),
      mode === TradeMode.Demo
        ? demoLaunchCallbackData(assetId, durationSec, 'a')
        : sessionStartCallbackData(mode, assetId, durationSec),
    )
    .row();
}

export function appendAnalysisTail(
  keyboard: InlineKeyboard,
  assetId: number,
  durationSec: DemoDurationSec,
): InlineKeyboard {
  return keyboard
    .text(LABELS.repeatAnalysisButton, demoAnalysisCallbackData(assetId, durationSec))
    .row()
    .text(LABELS.demoBackPairButton, demoAssetCallbackData(assetId))
    .text(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA);
}

// A pair the catalog refuses: gone, closed by the schedule, or not taking the demo's duration
// (#685) - there is no other duration to choose, so the way back is to the pair's page
export function pairRefusalScreen(
  check: Exclude<DemoTradeCheck, { ok: true }>,
  catalog: PairsCatalogResponse,
  nowMs: number,
): DemoScreen {
  switch (check.reason) {
    case 'pair_missing':
      return { text: TEXTS.demoPairMissing, keyboard: backToGroups() };
    case 'pair_closed':
      return {
        text: TEXTS.demoPairClosed({ symbol: pairLabel(check.pair) }),
        keyboard: appendBackToPairs(new InlineKeyboard(), catalog, check.pair, nowMs),
      };
    case 'duration_unsupported':
      return {
        text: TEXTS.demoDurationUnsupported({
          symbol: pairLabel(check.pair),
          label: DEMO_DURATION_LABELS[DEMO_DURATION_SEC],
        }),
        keyboard: appendBackToPairs(new InlineKeyboard(), catalog, check.pair, nowMs),
      };
  }
}

const backToGroups = () =>
  new InlineKeyboard().text(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA);

// «↩️ Активы» leads to the page the pair is listed on (the first page when it is not listed),
// then «↩️ Типы»
function appendBackToPairs(
  keyboard: InlineKeyboard,
  catalog: PairsCatalogResponse,
  pair: PairView,
  nowMs: number,
): InlineKeyboard {
  const group = pairTypeGroupOf(pair.type);
  const page = pageIndexOf(openPairsOf(catalog, group, nowMs), pair.id);
  return keyboard
    .text(LABELS.demoBackPairsButton, demoPageCallbackData(group, page))
    .text(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA);
}

// The next step on a pair with a signal (#476, #327): the launch screen in real mode, the amount
// screen otherwise, its «недоступно» when access was not read
export function nextStepScreen(
  { assetId, back, firstName }: { assetId: number; back: CycleBack; firstName: string },
  pair: PairView,
  access: TradingAccessResponse | null,
  connectKeyboard: () => InlineKeyboard,
): DemoScreen {
  return access?.tradingMode === TradeMode.Real
    ? launchScreen({
        assetId,
        durationSec: DEMO_DURATION_SEC,
        firstName,
        symbol: pairLabel(pair),
        amount: effectiveStake(access),
        mode: TradeMode.Real,
      })
    : demoCycleScreen({
        step: { assetId, durationSec: DEMO_DURATION_SEC, back },
        firstName,
        symbol: pairLabel(pair),
        access,
        connectKeyboard,
      });
}

// What the wait for a signal draws (signal-wait.ts): the screens of this file
export function createSignalWaitScreens({
  connectKeyboard,
  setupCardPhotos,
}: {
  connectKeyboard: () => InlineKeyboard;
  setupCardPhotos: SetupCardPhotos;
}): SignalWaitScreens {
  return {
    list: signalsScreen,
    expired: expiredSignalsScreen,
    waiting: pairWaitingScreen,
    alternatives: signalsShown,
    nextStep: (step, pair, access) => nextStepScreen(step, pair, access, connectKeyboard),
    refusal: pairRefusalScreen,
    // the analysis's card as «📊 Анализ» draws it, in the mode access gives (demo when not read)
    card: (pair, response, access) => {
      const mode = access?.tradingMode ?? TradeMode.Demo;
      const amounts = cardAmountsOf(access, DEMO_DURATION_SEC, connectKeyboard);
      const screen = analysisScreen({
        pair,
        durationSec: DEMO_DURATION_SEC,
        response,
        mode,
        chooseAmount: amounts !== null,
      });
      if (screen.photo === null) return undefined;
      return {
        text: screen.text,
        keyboard: analysisKeyboard(pair.id, DEMO_DURATION_SEC, screen, mode, amounts),
        action: screen.photo,
      };
    },
    photos: setupCardPhotos,
  };
}

export interface DemoComposerDeps {
  backend: Pick<
    BackendClient,
    'readPairs' | 'readSignals' | 'evaluateSignal' | 'readTradingAccess'
  >;
  logger: Logger;
  now: () => number;
  // the welcome's connect button, for a user with no account to trade on
  connectKeyboard: () => InlineKeyboard;
  // the card's pictures, shared with the session message (#568)
  setupCardPhotos: SetupCardPhotos;
  // the wait for a signal (#664): the list without pairs, the list's 30 s, the pair without one
  signalWaiter: Pick<SignalWaiter, 'waitList' | 'waitPair'>;
}

export function createDemoComposer<C extends Context>({
  backend,
  logger,
  now,
  connectKeyboard,
  setupCardPhotos,
  signalWaiter,
}: DemoComposerDeps): Composer<C> {
  const composer = new Composer<C>();

  // An old button with a duration the demo no longer offers (#685): the signals list as a new
  // message, the pressed keyboard untouched, so a session's or a trade's summary under it stays.
  // Its refusals retry with `demo:sig`: the pressed datum can be a write (a stake, a session).
  composer.callbackQuery(LEGACY_DURATION_PATTERNS, async (ctx) => {
    logger.info({ callbackData: ctx.callbackQuery.data }, 'legacy duration button');
    const { screen, listed } = await answerAnd(
      ctx,
      readSignalsScreen(ctx, DEMO_SIGNALS_CALLBACK_DATA),
    );
    const sent = await replyHtml(ctx, screen.text, { reply_markup: screen.keyboard });
    waitList(ctx, placeOf(sent), screen, listed);
  });

  // the card's button is under a photo: the list goes as a new message
  composer.callbackQuery(DEMO_CALLBACK_DATA, async (ctx) => {
    const { screen, listed } = await answerAnd(ctx, readSignalsScreen(ctx, DEMO_CALLBACK_DATA));
    const sent = await replyHtml(ctx, screen.text, { reply_markup: screen.keyboard });
    waitList(ctx, placeOf(sent), screen, listed);
  });

  composer.callbackQuery(DEMO_SIGNALS_PATTERN, async (ctx) => {
    const { screen, listed } = await answerAnd(ctx, readSignalsScreen(ctx, ctx.callbackQuery.data));
    waitList(ctx, await editOrReply(ctx, screen.text, screen.keyboard), screen, listed);
  });

  // A list drawn with its pairs expires after SIGNALS_LIST_TTL_MS, one without pairs waits for
  // them (#664); a refusal of the reads, with its «🔄 Повторить», is not a wait.
  function waitList(
    ctx: Context,
    place: Place | undefined,
    drawn: DemoScreen,
    listed: number | undefined,
  ): void {
    const from = ctx.from;
    if (place === undefined || listed === undefined || from === undefined) return;
    signalWaiter.waitList({
      api: ctx.api,
      ...place,
      telegramUserId: from.id,
      language: currentLanguage(),
      drawn,
      shown: listed > 0,
    });
  }

  // A pair of the list, and since #476 every demo door of a cycle: the amount screen in demo, the
  // launch screen in real (#327). The pair is checked against the catalog read at this press, never
  // the one the list was drawn from, and its signal is the scanner's fresh list (#664): a pair not
  // in it — a door drawn without a signal («🔁 Ещё сессия», the offer under a single trade), an old
  // message — waits for one, with the other pairs that have a signal now (Rule 46). No session
  // opens on a pair without a signal (#509).
  composer.callbackQuery(DEMO_LAUNCH_PATTERN, async (ctx) => {
    const assetId = assetIdOf(ctx.match[1]);
    const durationSec = durationOf(ctx.match[2]);
    if (assetId === undefined || durationSec === undefined) {
      await answerOnly(ctx);
      return;
    }
    const origin: CycleOrigin = ctx.match[3] === 'a' ? 'a' : ctx.match[3] === 'n' ? 'n' : 'l';
    const [read, access, signals] = await answerAnd(
      ctx,
      Promise.all([
        readDemoTrade(backend, assetId, durationSec, now),
        readAccess(ctx.from.id),
        readSignals(),
      ]),
    );
    const firstName = ctx.from.first_name;
    const back = cycleBackOf(origin);
    let screen: DemoScreen;
    let wait: { base: TelegramHtml; alternatives: ShownSignal[] } | undefined;
    if (!read.ok) {
      screen = tradeFailure(read, ctx.callbackQuery.data);
    } else {
      const list = signals === null ? undefined : signalsListOf(signals);
      if (list?.signals.some((signal) => signal.assetId === assetId) === true) {
        screen = nextStepScreen({ assetId, back, firstName }, read.pair, access, connectKeyboard);
      } else {
        const alternatives =
          list === undefined ? [] : signalsShown(list.signals, read.catalog, now());
        const base = pairWaitingText(pairLabel(read.pair), assetId);
        screen = pairWaitingScreen(base, alternatives);
        wait = { base, alternatives };
      }
    }
    const place =
      origin === 'n'
        ? placeOf(await replyHtml(ctx, screen.text, { reply_markup: screen.keyboard }))
        : await editOrReply(ctx, screen.text, screen.keyboard);
    if (wait === undefined || place === undefined) return;
    signalWaiter.waitPair({
      api: ctx.api,
      ...place,
      telegramUserId: ctx.from.id,
      language: currentLanguage(),
      drawn: screen,
      firstName,
      assetId,
      back,
      origin: 'door',
      base: wait.base,
      alternatives: wait.alternatives.length > 0 ? 'shown' : 'done',
    });
  });

  // The demo's list of the signals body; a body without it is a deploy mismatch, not «no
  // signals»: one warn, and the caller reads it as unread.
  function signalsListOf(
    signals: TradingSignalsResponse,
  ): TradingSignalsResponse['lists'][number] | undefined {
    const interval = intervalForDuration(DEMO_DURATION_SEC);
    const list = signals.lists.find((candidate) => candidate.interval === interval);
    if (list === undefined) logger.warn({ interval }, 'trading signals list missing');
    return list;
  }

  composer.callbackQuery(DEMO_GROUPS_CALLBACK_DATA, async (ctx) => {
    const read = await answerAnd(ctx, readDemoCatalog(backend));
    const screen = read.ok
      ? groupsScreen(read.catalog)
      : catalogFailure(read, ctx.callbackQuery.data);
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
      : catalogFailure(read, ctx.callbackQuery.data);
    await editOrReply(ctx, screen.text, screen.keyboard);
  });

  // A pair of the manual path (#685): its summary at the demo's duration, checked on the catalog
  // read at this press. `demo:d:<id>:5`, the summary's data before #685, opens the same.
  async function showSummary(ctx: Context, assetId: number): Promise<void> {
    const read = await answerAnd(ctx, readDemoTrade(backend, assetId, DEMO_DURATION_SEC, now));
    const screen = read.ok
      ? {
          text: demoSummary(read.pair, DEMO_DURATION_SEC),
          keyboard: appendBackToPairs(
            new InlineKeyboard()
              .text(LABELS.demoAnalysisButton, demoAnalysisCallbackData(assetId, DEMO_DURATION_SEC))
              .row(),
            read.catalog,
            read.pair,
            now(),
          ),
        }
      : tradeFailure(read, ctx.callbackQuery?.data ?? demoAssetCallbackData(assetId));
    await editOrReply(ctx, screen.text, screen.keyboard);
  }

  composer.callbackQuery(DEMO_ASSET_PATTERN, async (ctx) => {
    const assetId = assetIdOf(ctx.match[1]);
    if (assetId === undefined) {
      await answerOnly(ctx);
      return;
    }
    await showSummary(ctx, assetId);
  });

  composer.callbackQuery(DEMO_DURATION_PATTERN, async (ctx) => {
    const assetId = assetIdOf(ctx.match[1]);
    if (assetId === undefined || durationOf(ctx.match[2]) === undefined) {
      await answerOnly(ctx);
      return;
    }
    await showSummary(ctx, assetId);
  });

  // The analysis (#126): the check on the catalog read at this press, never on the one the
  // summary was drawn from; then «⏳» (showWaiting), the signal, and the screen: a text in place
  // of «⏳», or a signal's card (#482) as a photo under it, «⏳» deleted after it. The signal is
  // asked for only once «⏳» was delivered or is known gone: after a send of unknown outcome
  // nothing more is sent, and a decision nobody sees would cost a broker call.
  composer.callbackQuery(DEMO_ANALYSIS_PATTERN, async (ctx) => {
    const assetId = assetIdOf(ctx.match[1]);
    const durationSec = durationOf(ctx.match[2]);
    if (assetId === undefined || durationSec === undefined) {
      await answerOnly(ctx);
      return;
    }
    // the mode decides the session row's data and label (#327); a failed access read draws the
    // demo keyboard, whose session press the backend refuses for a real-mode user
    // (mode_not_allowed)
    const [read, stake] = await answerAnd(
      ctx,
      Promise.all([readDemoTrade(backend, assetId, durationSec, now), stakeAmount(ctx.from.id)]),
    );
    if (!read.ok) {
      const screen = tradeFailure(read, ctx.callbackQuery.data);
      await editOrReply(ctx, screen.text, screen.keyboard);
      return;
    }
    const waiting = await showWaiting(
      ctx,
      TEXTS.analyzing({ subject: analysisSubject(read.pair, durationSec) }),
    );
    if (waiting === 'unknown') return;
    const amounts = cardAmountsOf(stake.access, durationSec, connectKeyboard);
    const screen = await evaluate(
      ctx.from.id,
      read.pair,
      durationSec,
      stake.mode,
      amounts !== null,
    );
    if (screen.wait) {
      // no signal now: the wait for one (#664), its card drawn in this message once it comes
      const drawn = pairWaitingScreen(screen.text, []);
      const place = await showResult(ctx, waiting, drawn.text, drawn.keyboard);
      if (place === undefined) return;
      signalWaiter.waitPair({
        api: ctx.api,
        ...place,
        telegramUserId: ctx.from.id,
        language: currentLanguage(),
        drawn,
        firstName: ctx.from.first_name,
        assetId,
        back: 'a',
        origin: 'analysis',
        base: screen.text,
        alternatives: 'pending',
      });
      return;
    }
    const keyboard = analysisKeyboard(assetId, durationSec, screen, stake.mode, amounts);
    if (screen.photo === null) await showResult(ctx, waiting, screen.text, keyboard);
    else await sendCard(ctx, waiting, screen.photo, screen.text, keyboard, read.pair, durationSec);
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
    const { access, amount, mode } = await answerAnd(ctx, stakeAmount(ctx.from.id));
    // the analysis was drawn in another mode than the user's now (or access was not read for a
    // real one): no button to trade under a text that names the other mode; the repeat redraws it
    await editKeyboard(
      ctx,
      mode === data.renderedMode
        ? expandedKeyboard(
            data.assetId,
            data.durationSec,
            data.action,
            amount,
            mode,
            cardAmountsOf(access, data.durationSec, connectKeyboard),
          )
        : appendAnalysisTail(new InlineKeyboard(), data.assetId, data.durationSec),
    );
  });

  // A thrown call (unreachable, a non-2xx, a broken body) and every fetch_failed but
  // rate_limited are logged: rate_limited is the broker's ordinary answer, told to the user. The
  // request names the user's analysis, which the backend records for the analysis reminder (#484).
  async function evaluate(
    telegramUserId: number,
    pair: PairView,
    durationSec: DemoDurationSec,
    mode: TradeMode,
    chooseAmount: boolean,
  ): Promise<AnalysisScreen> {
    let response;
    try {
      response = await backend.evaluateSignal(pair.id, intervalForDuration(durationSec), {
        telegramUserId: String(telegramUserId),
        durationSec,
      });
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
    return analysisScreen({ pair, durationSec, response, mode, chooseAmount });
  }

  // «⏳» before the signal is asked for. Under a photo (the analysis card, the session's summary
  // card #318) a caption cannot become this text, so «⏳» goes as a new message at once: an edit
  // tried first would make the longest path five Telegram calls, past SHUTDOWN_BUDGET_MS
  // (timing.ts). Elsewhere it is the pressed message edited; one gone is not replaced by a new
  // «⏳» — the result goes as a new message without one (null). A transport failure leaves «⏳»
  // unknown and sends nothing more; any other refusal goes to bot.catch.
  async function showWaiting(ctx: Context, text: TelegramHtml): Promise<Waiting | 'unknown'> {
    const pressed = ctx.callbackQuery?.message;
    if (pressed !== undefined && 'photo' in pressed && pressed.photo !== undefined) {
      try {
        const sent = await replyHtmlWithoutNextStep(ctx, text, NO_NEXT_STEP_REASONS.InProgress);
        return { pressed: false, chatId: sent.chat.id, messageId: sent.message_id };
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        logger.error(
          {
            ...errorLogFields(error),
            ...telegramErrorFields(error, 'sendMessage'),
            updateId: ctx.update.update_id,
          },
          'the analysis «⏳» failed in transport, sending nothing more',
        );
        return 'unknown';
      }
    }
    try {
      await editMessageTextHtmlWithoutNextStep(ctx, text, NO_NEXT_STEP_REASONS.InProgress);
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'gone') {
        logger.warn(
          { ...errorLogFields(error), ...telegramErrorFields(error) },
          'the demo screen was not edited, the analysis goes as a new message',
        );
        return null;
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
      } else if (refusal !== 'shown') {
        throw error;
      }
      logger.info({ ...telegramErrorFields(error) }, 'the demo screen already shows this');
    }
    const chatId = ctx.chat?.id;
    const messageId = pressed?.message_id;
    return chatId === undefined || messageId === undefined
      ? null
      : { pressed: true, chatId, messageId };
  }

  // A text result: in place of «⏳» — the pressed message as every demo screen is edited, a new
  // «⏳» by its id with the same classification — or as a new message where «⏳» is gone.
  async function showResult(
    ctx: Context,
    waiting: Waiting,
    text: TelegramHtml,
    keyboard: InlineKeyboard,
  ): Promise<Place | undefined> {
    if (waiting === null) return placeOf(await replyHtml(ctx, text, { reply_markup: keyboard }));
    if (waiting.pressed) return editOrReply(ctx, text, keyboard);
    return editByIdOrReply(ctx, waiting, text, keyboard);
  }

  async function editByIdOrReply(
    ctx: Context,
    { chatId, messageId }: Exclude<Waiting, null>,
    text: TelegramHtml,
    keyboard: InlineKeyboard,
  ): Promise<Place | undefined> {
    try {
      await editMessageTextByIdHtml(ctx.api, chatId, messageId, text, { reply_markup: keyboard });
      return { chatId, messageId };
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'shown') {
        logger.info({ ...telegramErrorFields(error) }, 'the demo screen already shows this');
        return { chatId, messageId };
      } else if (refusal === 'gone') {
        logger.warn(
          { ...errorLogFields(error), ...telegramErrorFields(error) },
          'the demo screen was not edited, sending it anew',
        );
        return placeOf(await replyHtml(ctx, text, { reply_markup: keyboard }));
      } else if (error instanceof HttpError) {
        logger.error(
          {
            ...errorLogFields(error),
            ...telegramErrorFields(error, 'editMessageText'),
            updateId: ctx.update.update_id,
          },
          'the demo screen edit failed in transport, sending nothing more',
        );
        return undefined;
      }
      throw error;
    }
  }

  // A signal's card (#482): the picture of its direction, by the file_id remembered for it or as
  // the file, under «⏳», which is deleted once the card is there. A photo Telegram refuses — a
  // stale file_id among them — forgets the id, and the same caption and keyboard go as text in
  // place of «⏳» (or new, where «⏳» is gone); the next press uploads the file. A transport failure
  // leaves the card unknown: «⏳» says the analysis is unavailable, with its repeat. Neither edit
  // is followed by anything: the budget has no call left (timing.ts).
  async function sendCard(
    ctx: Context,
    waiting: Waiting,
    action: TradeAction,
    text: TelegramHtml,
    keyboard: InlineKeyboard,
    pair: PairView,
    durationSec: DemoDurationSec,
  ): Promise<void> {
    const photo = setupCardPhotos.photo(action);
    let sent;
    try {
      sent = await replyWithPhotoHtml(ctx, photo, text, { reply_markup: keyboard });
    } catch (error) {
      if (error instanceof GrammyError) {
        setupCardPhotos.forget(action);
        logger.warn(
          {
            ...errorLogFields(error),
            ...telegramErrorFields(error),
            byFileId: typeof photo === 'string',
          },
          'the analysis card photo was refused, sending its text',
        );
        if (waiting === null) await replyHtml(ctx, text, { reply_markup: keyboard });
        else await editWaiting(ctx, waiting, text, keyboard);
      } else if (error instanceof HttpError) {
        logger.error(
          {
            ...errorLogFields(error),
            ...telegramErrorFields(error, 'sendPhoto'),
            updateId: ctx.update.update_id,
          },
          'the analysis card failed in transport',
        );
        if (waiting !== null) {
          await editWaiting(
            ctx,
            waiting,
            analysisUnavailableScreen(pair, durationSec).text,
            appendAnalysisTail(new InlineKeyboard(), pair.id, durationSec),
          );
        }
      } else {
        throw error;
      }
      return;
    }
    setupCardPhotos.remember(action, sent);
    if (waiting !== null) await deleteWaiting(ctx, waiting);
  }

  // «⏳» edited after the card could not go: any refusal or failure is logged, nothing more
  async function editWaiting(
    ctx: Context,
    { chatId, messageId }: Exclude<Waiting, null>,
    text: TelegramHtml,
    keyboard: InlineKeyboard,
  ): Promise<void> {
    try {
      await editMessageTextByIdHtml(ctx.api, chatId, messageId, text, { reply_markup: keyboard });
    } catch (error) {
      if (!(error instanceof GrammyError) && !(error instanceof HttpError)) throw error;
      logger.warn(
        {
          ...errorLogFields(error),
          ...telegramErrorFields(error, 'editMessageText'),
          updateId: ctx.update.update_id,
        },
        'the analysis «⏳» was not edited after the card',
      );
    }
  }

  // Telegram allows deleting a bot's own message under 48 h old in a private chat, so a refusal is
  // unexpected: a gone one is logged as info, anything else (a transport failure too) as a
  // warning, and nothing more — the card is already there.
  async function deleteWaiting(
    ctx: Context,
    { chatId, messageId }: Exclude<Waiting, null>,
  ): Promise<void> {
    try {
      await ctx.api.deleteMessage(chatId, messageId);
    } catch (error) {
      if (!(error instanceof GrammyError) && !(error instanceof HttpError)) throw error;
      if (error instanceof GrammyError && deleteRefusal(error) === 'gone') {
        logger.info({ ...telegramErrorFields(error) }, 'the analysis «⏳» was already gone');
        return;
      }
      logger.warn(
        {
          ...errorLogFields(error),
          ...telegramErrorFields(error, 'deleteMessage'),
          updateId: ctx.update.update_id,
        },
        'the analysis «⏳» was not deleted',
      );
    }
  }

  // The two reads together; a failed one is the screen's retry with `retryData` (a read: the
  // pressed data, or `demo:sig` under a legacy write datum) and the list's footer. A failed catalog
  // reads as the catalog's own failure. A body without the duration's list is a deploy mismatch,
  // not «no signals»: the same retry, and one warn.
  // `listed` is undefined on a refusal: it is not a list to wait on.
  async function readSignalsScreen(
    ctx: Context,
    retryData: string,
  ): Promise<{ screen: DemoScreen; listed: number | undefined }> {
    const [signals, read] = await Promise.all([readSignals(), readDemoCatalog(backend)]);
    const refusal = (screen: DemoScreen) => ({
      screen: { text: screen.text, keyboard: appendSignalsFooter(screen.keyboard) },
      listed: undefined,
    });
    if (!read.ok) return refusal(catalogFailure(read, retryData));
    const retry = () =>
      refusal({
        text: TEXTS.unavailable,
        keyboard: new InlineKeyboard().text(LABELS.demoRetryButton, retryData),
      });
    if (signals === null) return retry();
    const drawn = signalsScreen(signals, read.catalog, now());
    if (drawn !== undefined) return drawn;
    logger.warn(
      { interval: intervalForDuration(DEMO_DURATION_SEC) },
      'trading signals list missing',
    );
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

  // the amount screen's access read (#476): null when it failed, which that screen says
  async function readAccess(telegramUserId: number): Promise<TradingAccessResponse | null> {
    try {
      return await backend.readTradingAccess(String(telegramUserId));
    } catch (error) {
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error) },
        'trading access not read for the amount screen',
      );
      return null;
    }
  }

  // The amount for the stake button's label (#297) and the user's mode (#121), drawn by «➕ Ещё»
  // (#360) and the analysis (its session row). A failed read drops the
  // amount and reads as demo: the signal or the pair decides the screen, and the press reads
  // access again anyway.
  async function stakeAmount(telegramUserId: number): Promise<{
    access: TradingAccessResponse | null;
    amount: DecimalString | null;
    mode: TradeMode;
  }> {
    try {
      const access = await backend.readTradingAccess(String(telegramUserId));
      return { access, amount: effectiveStake(access), mode: access.tradingMode };
    } catch (error) {
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error) },
        'trading access not read for the stake label',
      );
      return { access: null, amount: null, mode: TradeMode.Demo };
    }
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

  // Every refusal of an edit is classified (telegram-refusals.ts in @binarius/shared): already
  // shown — the same screen pressed twice — is done; a message that is gone or cannot be edited
  // gets the screen anew; any other refusal goes to bot.catch with nothing sent, the keyboard on
  // screen being the retry. A transport failure leaves the edit unknown and sends nothing more;
  // anything else is a bug.
  // Where the screen landed, for the wait (#664): the pressed message or the new one; undefined
  // after a transport failure.
  async function editOrReply(
    ctx: Context,
    text: TelegramHtml,
    keyboard: InlineKeyboard,
  ): Promise<Place | undefined> {
    try {
      await editMessageTextHtml(ctx, text, { reply_markup: keyboard });
      return pressedPlace(ctx);
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'shown') {
        logger.info({ ...telegramErrorFields(error) }, 'the demo screen already shows this');
        return pressedPlace(ctx);
      } else if (refusal === 'gone') {
        logger.warn(
          { ...errorLogFields(error), ...telegramErrorFields(error) },
          'the demo screen was not edited, sending it anew',
        );
        return placeOf(await replyHtml(ctx, text, { reply_markup: keyboard }));
      } else if (error instanceof HttpError) {
        logger.error(
          {
            ...errorLogFields(error),
            ...telegramErrorFields(error, 'editMessageText'),
            updateId: ctx.update.update_id,
          },
          'the demo screen edit failed in transport, sending nothing more',
        );
        return undefined;
      }
      throw error;
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

  // A read that did not give a fresh catalog: the text and «🔄 Повторить» with `retryData`, a read
  // (the pressed data of a screen that writes nothing, or `demo:sig` under a legacy write datum).
  // Only backend_failed is logged: the backend logs each failed refresh behind a 503 or a stale
  // snapshot itself.
  function catalogFailure(
    read: Exclude<DemoCatalogRead, { ok: true }>,
    retryData: string,
  ): DemoScreen {
    const keyboard = new InlineKeyboard().text(LABELS.demoRetryButton, retryData);
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

  function tradeFailure(read: Exclude<DemoTradeRead, { ok: true }>, retryData: string): DemoScreen {
    switch (read.reason) {
      case 'catalog_unavailable':
      case 'catalog_stale':
      case 'backend_failed':
        return catalogFailure(read, retryData);
      case 'pair_missing':
      case 'pair_closed':
      case 'duration_unsupported':
        return pairRefusalScreen(read, read.catalog, now());
    }
  }

  // The types present in the catalog, each with its count of open pairs; a type with no pair
  // that accepts the demo duration has no button. An empty catalog has nothing to choose from, so
  // it reads as unavailable; a catalog whose pairs all refuse 5 s says so (#313, #685).
  function groupsScreen(catalog: PairsCatalogResponse): DemoScreen {
    const present = PAIR_TYPE_GROUPS.filter((group) => pairsOf(catalog, group).length > 0);
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
    group: PairTypeGroup,
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
      keyboard.text(pairButtonLabel(pairLabel(pair), pair.payout), demoAssetCallbackData(pair.id));
    });
    keyboard.row();
    if (page > 0) keyboard.text(LABELS.demoPrevButton, demoPageCallbackData(group, page - 1));
    keyboard.text(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA);
    if (page < pageCount - 1) {
      keyboard.text(LABELS.demoNextButton, demoPageCallbackData(group, page + 1));
    }
    return { text: demoPairsScreen(group, page, pageCount), keyboard };
  }

  return composer;
}

// A message a screen landed on, for the wait to edit (#664)
export interface Place {
  chatId: number;
  messageId: number;
}
export const placeOf = (sent: { chat: { id: number }; message_id: number }): Place => ({
  chatId: sent.chat.id,
  messageId: sent.message_id,
});
export const pressedPlace = (ctx: Context): Place | undefined => {
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  return chatId === undefined || messageId === undefined ? undefined : { chatId, messageId };
};

// Where the analysis's «⏳» is: the pressed message, or a new one under a photo; null when the
// pressed message was gone and no «⏳» stands
type Waiting = { pressed: boolean; chatId: number; messageId: number } | null;

export interface DemoScreen {
  text: TelegramHtml;
  keyboard: InlineKeyboard;
}
