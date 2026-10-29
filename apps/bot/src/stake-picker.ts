import { Composer, GrammyError, HttpError, type Context } from 'grammy';
import {
  ButtonRole,
  callbackButton,
  editRefusal,
  errorLogFields,
  keyboardOf,
  normalizeDecimal,
  pairLabel,
  parseStakeInput,
  StakeErrorCode,
  StakeRefusal,
  stakePresets,
  STAKE_AMOUNT_PATTERN,
  tradeAmountSchema,
  TradeMode,
  type BotButton,
  type BotKeyboard,
  type DecimalString,
  type TelegramHtml,
  type TradingAccessResponse,
  demoAnalysisCallbackData,
  telegramErrorFields,
} from '@binarius/shared';
import {
  BackendError,
  BackendErrorCode,
  backendErrorFields,
  type BackendClient,
  type SetStakeResult,
} from './backend-client';
import {
  assetIdOf,
  demoCycleScreen,
  demoLaunchCallbackData,
  effectiveStake,
  launchScreen,
  MODE_TOKENS,
  pressedUnderMedia,
  removeLegacyKeyboard,
  STAKE_PICKER_PREFIX,
} from './demo';
import {
  DEMO_DURATION_SEC,
  DEMO_DURATIONS_SEC,
  LEGACY_DEMO_DURATIONS_SEC,
  type DemoDurationSec,
} from './demo-catalog';
import type { LoginDialog } from './login-dialog';
import { answerCallback } from './answer-callback';
import { settle, type Settled } from './settled';
import type { Logger } from './logging';
import { stakeAccess } from './stake-access';
import { stakeGroups } from './stake-rows';
import { editMessageTextHtml, replyHtml } from './send';
import { LABELS, stakePickerText, TEXTS, userContextOf } from './texts';

// The stake picker of one mode (#297 demo, #326 real; docs/bot-demo-trade.md -> The stake):
// presets from the broker's minimum, a typed amount, a reset to the minimum, and the way back to
// where it was opened from — /settings, an analysis screen or a launch screen (#320). The mode is
// the picker's, carried in every callback, not the user's trading mode: either stake is a
// preference saved in any mode. The bounds are the backend's (POST /trading/stake): the bot sends
// a preset or a parsed input and shows the answer, so a forged amount gets the same refusal as a
// typed one.

// Where the picker was opened, carried in every callback as `s`, `a:<assetId>:<durationSec>` or
// `p:<assetId>:<durationSec>` (the launch screen's duration since #382). An origin drawn with a
// duration the demo no longer offers (15 s, #685) reads as the same pair's screen at 5 s.
export type StakeOrigin =
  | { kind: 'settings' }
  | { kind: 'analysis'; assetId: number; durationSec: DemoDurationSec }
  | { kind: 'pair'; assetId: number; durationSec: DemoDurationSec };

// /settings re-rendered in place: the picker's way back when it was opened there (bot.ts)
export const SETTINGS_CALLBACK_DATA = 'settings';

function originData(origin: StakeOrigin): string {
  switch (origin.kind) {
    case 'settings':
      return 's';
    case 'analysis':
      return `a:${origin.assetId}:${origin.durationSec}`;
    case 'pair':
      return `p:${origin.assetId}:${origin.durationSec}`;
    default:
      return origin satisfies never;
  }
}

// The picker's mode after the action letter (#326): `<action>:<d|r>:<origin>`, the tokens of
// demo.ts's MODE_TOKENS. Bot API allows 1-64 bytes; the longest drawn,
// `stk:s:999999999999.99999999:r:a:2147483647:5`, is 44 (one with 15, still accepted, 45).
const pickerData = (action: string, mode: TradeMode, origin: StakeOrigin): string =>
  `${STAKE_PICKER_PREFIX}${action}:${MODE_TOKENS[mode]}:${originData(origin)}`;
export const stakeOpenCallbackData = (mode: TradeMode, origin: StakeOrigin): string =>
  pickerData('o', mode, origin);
export const stakePresetCallbackData = (
  amount: string,
  mode: TradeMode,
  origin: StakeOrigin,
): string => pickerData(`s:${amount}`, mode, origin);
export const stakeResetCallbackData = (mode: TradeMode, origin: StakeOrigin): string =>
  pickerData('z', mode, origin);
export const stakeCustomCallbackData = (mode: TradeMode, origin: StakeOrigin): string =>
  pickerData('c', mode, origin);

// The four shapes over an optional mode group and an origin. The legacy shapes: every action
// without a mode, from before #326 (a demo picker), over every origin with a duration (today's,
// 15 s until #685 and the set before #313; /settings carries none), and a launch screen from before
// #382, which carried no duration.
const pickerPatterns = (mode: string, origin: string) => ({
  open: new RegExp(`^${STAKE_PICKER_PREFIX}o:${mode}${origin}$`),
  preset: new RegExp(`^${STAKE_PICKER_PREFIX}s:(${STAKE_AMOUNT_PATTERN}):${mode}${origin}$`),
  reset: new RegExp(`^${STAKE_PICKER_PREFIX}z:${mode}${origin}$`),
  custom: new RegExp(`^${STAKE_PICKER_PREFIX}c:${mode}${origin}$`),
});
const ORIGIN_DURATIONS = [...DEMO_DURATIONS_SEC, ...LEGACY_DEMO_DURATIONS_SEC];
const ORIGIN_PATTERN = `(s|[ap]:\\d{1,10}:(?:${ORIGIN_DURATIONS.join('|')}))`;
const PICKER = pickerPatterns(`(${Object.values(MODE_TOKENS).join('|')}):`, ORIGIN_PATTERN);
const LEGACY_PICKER_PATTERNS = [
  ...Object.values(pickerPatterns('', ORIGIN_PATTERN)),
  ...Object.values(pickerPatterns('', '(p:\\d{1,10})')),
];

// undefined for anything but a token of MODE_TOKENS: a forged datum gets only the answer
export function stakeModeOf(raw: string | undefined): TradeMode | undefined {
  return Object.values(TradeMode).find((mode) => MODE_TOKENS[mode] === raw);
}

// undefined when forged: the asset id the backend would refuse, or a malformed origin
export function stakeOriginOf(raw: string | undefined): StakeOrigin | undefined {
  if (raw === 's') return { kind: 'settings' };
  const [kind, asset, duration] = raw?.split(':') ?? [];
  const assetId = assetIdOf(asset);
  if (assetId === undefined) return undefined;
  // the duration is one (#685): an accepted older token names the same pair's screen today
  if (!ORIGIN_DURATIONS.some((sec) => String(sec) === duration)) return undefined;
  const durationSec = DEMO_DURATION_SEC;
  if (kind === 'p') return { kind: 'pair', assetId, durationSec };
  if (kind === 'a') return { kind: 'analysis', assetId, durationSec };
  return undefined;
}

// what every picker callback carries, and the typed amount's dialog step (login-dialog.ts)
export interface StakeStep {
  mode: TradeMode;
  origin: StakeOrigin;
}

const stepOf = (mode: string | undefined, origin: string | undefined): StakeStep | undefined => {
  const stakeMode = stakeModeOf(mode);
  const stakeOrigin = stakeOriginOf(origin);
  return stakeMode === undefined || stakeOrigin === undefined
    ? undefined
    : { mode: stakeMode, origin: stakeOrigin };
};

// A bounds refusal of a save, in the save's mode: only that mode's balance is in the limits. The
// amount screen of a demo cycle (#476, cycle-stake.ts) says the same.
export function refusalText(
  mode: TradeMode,
  { error, limits }: Extract<SetStakeResult, { refused: unknown }>['refused'],
): TelegramHtml {
  const real = mode === TradeMode.Real;
  const minStake = limits.minTradeAmount;
  const digits = String(limits.scale);
  switch (error) {
    case StakeRefusal.Precision:
      return real
        ? TEXTS.stakePrecisionDigitsReal({ digits, minStake, realAvailable: limits.available })
        : TEXTS.stakePrecisionDigits({ digits, minStake, demoAvailable: limits.available });
    case StakeRefusal.BelowMinimum:
      return TEXTS.stakeBelowMinimum({ minStake });
    case StakeRefusal.AboveAvailable:
      return real
        ? TEXTS.stakeAboveAvailableAmountReal({ realAvailable: limits.available, minStake })
        : TEXTS.stakeAboveAvailableAmount({ demoAvailable: limits.available, minStake });
    default:
      return error satisfies never;
  }
}

export interface StakePickerDeps {
  // readPairs: the symbol of the launch screen a save returns to (#320)
  backend: Pick<BackendClient, 'readTradingAccess' | 'setStake' | 'readPairs'>;
  logger: Logger;
  dialog: LoginDialog;
  // the welcome's connect button, for a user with no account to trade on
  connectButtons: () => BotButton[];
}

interface Screen {
  text: TelegramHtml;
  keyboard: BotKeyboard;
}

function backButton(origin: StakeOrigin): BotButton {
  switch (origin.kind) {
    case 'settings':
      return callbackButton(ButtonRole.Nav, LABELS.stakeBackSettingsButton, SETTINGS_CALLBACK_DATA);
    case 'analysis':
      return callbackButton(
        ButtonRole.Nav,
        LABELS.stakeBackAnalysisButton,
        demoAnalysisCallbackData(origin.assetId, origin.durationSec),
      );
    case 'pair':
      return callbackButton(
        ButtonRole.Nav,
        LABELS.stakeBackLaunchButton,
        demoLaunchCallbackData(origin.assetId, origin.durationSec),
      );
    default:
      return origin satisfies never;
  }
}
// `actions`, then the way back in their row
const backTo = (actions: readonly BotButton[], origin: StakeOrigin) =>
  keyboardOf([...actions, backButton(origin)]);
const backKeyboard = (origin: StakeOrigin) => backTo([], origin);
// «💵 Сумма» of the same mode to try again, then the way back
const retryKeyboard = (mode: TradeMode, origin: StakeOrigin) =>
  backTo(
    [
      callbackButton(
        ButtonRole.Secondary,
        LABELS.stakeMenuButton,
        stakeOpenCallbackData(mode, origin),
      ),
    ],
    origin,
  );

export function createStakePicker<C extends Context>({
  backend,
  logger,
  dialog,
  connectButtons,
}: StakePickerDeps): {
  composer: Composer<C>;
  onStakeText: (ctx: Context, step: StakeStep, text: string) => Promise<void>;
} {
  const composer = new Composer<C>();

  composer.callbackQuery(LEGACY_PICKER_PATTERNS, (ctx) => removeLegacyKeyboard(ctx, logger));

  composer.callbackQuery(PICKER.open, async (ctx) => {
    const step = stepOf(ctx.match[1], ctx.match[2]);
    if (step === undefined) {
      await answerCallback(ctx, logger);
      return;
    }
    const [, access] = await Promise.all([
      answerCallback(ctx, logger),
      settle(backend.readTradingAccess(String(ctx.from.id))),
    ]);
    const screen = pickerScreen(access, step, ctx.from.first_name);
    await editOrReply(ctx, screen.text, screen.keyboard);
  });

  composer.callbackQuery(PICKER.preset, async (ctx) => {
    const amount = tradeAmountSchema.safeParse(ctx.match[1]);
    const step = stepOf(ctx.match[2], ctx.match[3]);
    if (!amount.success || step === undefined) {
      await answerCallback(ctx, logger);
      return;
    }
    await saveInPlace(ctx, amount.data, step);
  });

  composer.callbackQuery(PICKER.reset, async (ctx) => {
    const step = stepOf(ctx.match[1], ctx.match[2]);
    if (step === undefined) {
      await answerCallback(ctx, logger);
      return;
    }
    await saveInPlace(ctx, null, step);
  });

  // The prompt in place of the picker; the typed amount comes to onStakeText through bot.ts's
  // text handler. Setting the step replaces a login step the user had open.
  composer.callbackQuery(PICKER.custom, async (ctx) => {
    const step = stepOf(ctx.match[1], ctx.match[2]);
    if (step === undefined) {
      await answerCallback(ctx, logger);
      return;
    }
    dialog.set(ctx.from.id, { step: 'stake', ...step });
    await answerCallback(ctx, logger);
    await editOrReply(
      ctx,
      step.mode === TradeMode.Real ? TEXTS.stakeInputPromptReal : TEXTS.stakeInputPrompt,
      keyboardOf([
        callbackButton(
          ButtonRole.Nav,
          LABELS.stakeBackButton,
          stakeOpenCallbackData(step.mode, step.origin),
        ),
      ]),
    );
  });

  // A typed amount: a new reply, the picker message stays as it was (the bot keeps no message id).
  // It is saved in the step's mode.
  async function onStakeText(ctx: Context, step: StakeStep, text: string): Promise<void> {
    const from = ctx.from;
    if (from === undefined) return;
    const amount = parseStakeInput(text);
    if (amount === undefined) {
      keepStakeStep(from.id);
      await replyHtml(ctx, TEXTS.stakeInputInvalid, { reply_markup: backKeyboard(step.origin) });
      return;
    }
    const screen = await savedScreen(
      from,
      await settle(backend.setStake(String(from.id), step.mode, amount)),
      step,
    );
    await replyHtml(ctx, screen.text, { reply_markup: screen.keyboard });
  }

  async function saveInPlace(
    ctx: Context & { from: { id: number; first_name: string } },
    amount: DecimalString | null,
    step: StakeStep,
  ): Promise<void> {
    const [, saved] = await Promise.all([
      answerCallback(ctx, logger),
      settle(backend.setStake(String(ctx.from.id), step.mode, amount)),
    ]);
    const screen = await savedScreen(ctx.from, saved, step);
    await editOrReply(ctx, screen.text, screen.keyboard);
  }

  // The access read's refusals say what the stake press would say (demo-trade.ts amountOf), the
  // same in both modes.
  function pickerScreen(
    access: Settled<TradingAccessResponse>,
    { mode, origin }: StakeStep,
    firstName: string,
  ): Screen {
    if (!access.ok) {
      logger.warn(
        { ...errorLogFields(access.error), ...backendErrorFields(access.error) },
        'trading access not read for the stake picker',
      );
      return { text: TEXTS.unavailable, keyboard: backKeyboard(origin) };
    }
    const checked = stakeAccess(access.value, (actions) => backTo(actions, origin), connectButtons);
    if ('refusal' in checked) return checked.refusal;
    const { broker } = checked;
    const real = mode === TradeMode.Real;
    const saved = real ? access.value.realStake : access.value.demoStake;
    const presets = stakePresets({
      minTradeAmount: broker.minTradeAmount,
      available: real ? broker.real.available : broker.demo.available,
    });
    const current = normalizeDecimal(saved ?? broker.minTradeAmount);
    // the presets as the amount screen draws them (#475): ✅ on the one in effect, «· риск» and red
    // from STAKE_RISK_THRESHOLD
    const lists = stakeGroups(presets, current, (preset) =>
      stakePresetCallbackData(preset, mode, origin),
    );
    const actions = [
      callbackButton(
        ButtonRole.Secondary,
        LABELS.stakeCustomButton,
        stakeCustomCallbackData(mode, origin),
      ),
      ...(saved === null
        ? []
        : [
            callbackButton(
              ButtonRole.Secondary,
              LABELS.stakeResetButton,
              stakeResetCallbackData(mode, origin),
            ),
          ]),
      backButton(origin),
    ];
    return {
      text: stakePickerText({
        // the saved stake of the picker's mode, null without one: «Сейчас:» names the minimum
        user: { ...userContextOf(firstName, mode, access.value), stake: saved },
        mode,
        minTradeAmount: broker.minTradeAmount,
        demoAvailable: broker.demo.available,
        realAvailable: broker.real.available,
        presets: presets.length,
      }),
      keyboard: keyboardOf(...lists, actions),
    };
  }

  // What a save answered, by where the answer came from (docs/bot-demo-trade.md -> The stake).
  // A typed amount's step stays open for a refusal before the write and an unknown outcome,
  // so the user can type again, until the next button press or command (bot.ts, #319); it ends on
  // a save and on a refusal the bot cannot act on. A save opened from a launch screen returns to
  // it with the saved amount (#320).
  async function savedScreen(
    from: { id: number; first_name: string },
    saved: Settled<SetStakeResult>,
    { mode, origin }: StakeStep,
  ): Promise<Screen> {
    const { id, first_name: firstName } = from;
    const real = mode === TradeMode.Real;
    if (!saved.ok) {
      const { error } = saved;
      const fields = { ...errorLogFields(error), ...backendErrorFields(error), mode };
      const http = error instanceof BackendError && error.code === BackendErrorCode.HttpStatus;
      if (http && error.reason === StakeErrorCode.BalanceUnavailable) {
        keepStakeStep(id);
        return { text: TEXTS.stakeBalanceMissing, keyboard: backKeyboard(origin) };
      }
      // no answer, a 5xx or a broken body: the UPDATE may have committed; saving the same amount
      // again is harmless, and the picker's «Сейчас:» line shows what is saved
      if (error instanceof BackendError && (!http || (error.status ?? 0) >= 500)) {
        keepStakeStep(id);
        logger.warn(fields, 'stake save outcome unknown');
        return { text: TEXTS.stakeSaveUnknown, keyboard: retryKeyboard(mode, origin) };
      }
      endStakeStep(id);
      // no users row: before the first /start; anything else here is the bot's own bug
      if (http && error.reason === StakeErrorCode.UserNotFound)
        logger.warn(fields, 'stake not saved');
      else logger.error(fields, 'stake not saved');
      return { text: TEXTS.unavailable, keyboard: backKeyboard(origin) };
    }
    const result = saved.value;
    if ('saved' in result) {
      endStakeStep(id);
      switch (origin.kind) {
        case 'settings':
        case 'analysis': {
          const context = { stake: result.saved, firstName };
          return {
            text: real ? TEXTS.stakeSavedReal(context) : TEXTS.stakeSaved(context),
            keyboard: backKeyboard(origin),
          };
        }
        case 'pair':
          return savedLaunchScreen(origin, { amount: result.saved, mode }, from);
        default:
          return origin satisfies never;
      }
    }
    keepStakeStep(id);
    return { text: refusalText(mode, result.refused), keyboard: retryKeyboard(mode, origin) };
  }

  // Any catalog will do, a stale one included: only the symbol is read, at any payout (#631).
  // Without a catalog, or without the pair in it, the screen drops its symbol line and the launch
  // stays, since the session start checks the pair.
  // The access read gives the user's mode (#121): a save from a launch screen drawn before a switch
  // draws the screen of the mode now (#327) — in real the launch screen, in demo the amount screen
  // (#476), whose amounts come from that read; a failed read draws the amount screen's refusal.
  async function savedLaunchScreen(
    { assetId, durationSec }: { assetId: number; durationSec: DemoDurationSec },
    saved: { amount: DecimalString | null; mode: TradeMode },
    { id, first_name: firstName }: { id: number; first_name: string },
  ): Promise<Screen> {
    const [catalog, access] = await Promise.all([
      settle(backend.readPairs()),
      settle(backend.readTradingAccess(String(id))),
    ]);
    if (!access.ok) {
      logger.warn(
        { ...errorLogFields(access.error), ...backendErrorFields(access.error) },
        'trading access not read for the launch screen',
      );
    }
    const real =
      access.ok && access.value.tradingMode === TradeMode.Real ? access.value : undefined;
    if (!catalog.ok) {
      logger.warn(
        { ...errorLogFields(catalog.error), ...backendErrorFields(catalog.error) },
        'pairs not read for the launch screen',
      );
    }
    const pair = catalog.ok
      ? catalog.value.pairs.find((listed) => listed.id === assetId)
      : undefined;
    if (real !== undefined) {
      return launchScreen({
        assetId,
        durationSec,
        firstName,
        symbol: pair === undefined ? null : pairLabel(pair),
        amount: effectiveStake(real),
        saved,
        mode: TradeMode.Real,
      });
    }
    return demoCycleScreen({
      step: { assetId, durationSec, back: 'l' },
      firstName,
      symbol: pair === undefined ? null : pairLabel(pair),
      access: access.ok ? access.value : null,
      connectButtons,
      saved,
    });
  }

  // only the stake step: a login the user has open is left alone
  function endStakeStep(id: number): void {
    if (dialog.get(id)?.step === 'stake') dialog.delete(id);
  }
  // set again, so its TTL starts over
  function keepStakeStep(id: number): void {
    const state = dialog.get(id);
    if (state?.step === 'stake') dialog.set(id, state);
  }

  // Every refusal of an edit is classified as in demo.ts: already shown is done, gone gets the
  // screen anew, a transport failure sends nothing more, anything else goes to bot.catch. Under
  // a photo (the analysis card, #482, the wait's still) or the wait's animation (#859) no edit is
  // tried: the screen goes as a new message (#761).
  async function editOrReply(ctx: Context, text: TelegramHtml, reply_markup: BotKeyboard) {
    if (pressedUnderMedia(ctx)) {
      await replyHtml(ctx, text, { reply_markup });
      return;
    }
    try {
      await editMessageTextHtml(ctx, text, { reply_markup });
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'shown') return;
      if (refusal === 'gone') {
        await replyHtml(ctx, text, { reply_markup });
        return;
      }
      if (!(error instanceof HttpError)) throw error;
      logger.error(
        { ...errorLogFields(error), ...telegramErrorFields(error, 'editMessageText') },
        'the stake screen edit failed in transport, sending nothing more',
      );
    }
  }

  return { composer, onStakeText };
}
