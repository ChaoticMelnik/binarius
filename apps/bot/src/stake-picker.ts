import { Composer, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import {
  BrokerBalanceUnavailableReason,
  DemoStakeErrorCode,
  DemoStakeRefusal,
  demoStakePresets,
  errorLogFields,
  formatStake,
  normalizeDecimal,
  pairPayoutAccepted,
  parseDemoStakeInput,
  tradeAmountSchema,
  TradeMode,
  UserStatus,
  telegramHtml,
  type DecimalString,
  type TelegramHtml,
  type TradingAccessResponse,
} from '@binarius/shared';
import {
  BackendError,
  BackendErrorCode,
  backendErrorFields,
  type BackendClient,
  type SetDemoStakeResult,
} from './backend-client';
import {
  assetIdOf,
  demoAnalysisCallbackData,
  demoLaunchCallbackData,
  durationOf,
  effectiveStake,
  launchScreen,
  payoutTooLowScreen,
  removeLegacyKeyboard,
  STAKE_PICKER_PREFIX,
} from './demo';
import {
  DEMO_DURATIONS_SEC,
  LEGACY_DEMO_DURATIONS_SEC,
  type DemoDurationSec,
} from './demo-catalog';
import type { LoginDialog } from './login-dialog';
import { telegramErrorFields, type Logger } from './logging';
import { supportKeyboard } from './keyboards';
import { editRefusal } from './screen';
import { editMessageTextHtml, replyHtml } from './send';
import { LABELS, stakePickerText, TEXTS, userContextOf } from './texts';

// The demo stake picker (#297, docs/bot-demo-trade.md -> The stake): presets from the broker's
// minimum, a typed amount, a reset to the minimum, and the way back to where it was opened from —
// /settings, an analysis screen or a launch screen (#320). The bounds are the backend's (POST
// /trading/demo-stake): the bot sends a preset or a parsed input and shows the answer, so a forged
// amount gets the same refusal as a typed one.

// Where the picker was opened, carried in every callback as `s`, `a:<assetId>:<durationSec>` or
// `p:<assetId>:<durationSec>` (the launch screen's duration since #382).
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

// Bot API allows 1-64 bytes; the longest, `stk:s:999999999999.99999999:a:2147483647:15`, is 43.
export const stakeOpenCallbackData = (origin: StakeOrigin): string =>
  `${STAKE_PICKER_PREFIX}o:${originData(origin)}`;
export const stakePresetCallbackData = (amount: string, origin: StakeOrigin): string =>
  `${STAKE_PICKER_PREFIX}s:${amount}:${originData(origin)}`;
export const stakeResetCallbackData = (origin: StakeOrigin): string =>
  `${STAKE_PICKER_PREFIX}z:${originData(origin)}`;
export const stakeCustomCallbackData = (origin: StakeOrigin): string =>
  `${STAKE_PICKER_PREFIX}c:${originData(origin)}`;

// The four shapes over an origin. The legacy origins: an analysis of a duration from before #313
// (/settings carries none), and a launch screen from before #382, which carried no duration.
const pickerPatterns = (origin: string) => ({
  open: new RegExp(`^${STAKE_PICKER_PREFIX}o:${origin}$`),
  preset: new RegExp(`^${STAKE_PICKER_PREFIX}s:(\\d{1,12}(?:\\.\\d{1,8})?):${origin}$`),
  reset: new RegExp(`^${STAKE_PICKER_PREFIX}z:${origin}$`),
  custom: new RegExp(`^${STAKE_PICKER_PREFIX}c:${origin}$`),
});
const PICKER = pickerPatterns(`(s|[ap]:\\d{1,10}:(?:${DEMO_DURATIONS_SEC.join('|')}))`);
const LEGACY_PICKER_PATTERNS = [
  ...Object.values(pickerPatterns(`(a:\\d{1,10}:(?:${LEGACY_DEMO_DURATIONS_SEC.join('|')}))`)),
  ...Object.values(pickerPatterns('(p:\\d{1,10})')),
];

// undefined when forged: the asset id the backend would refuse, or a malformed origin
export function stakeOriginOf(raw: string | undefined): StakeOrigin | undefined {
  if (raw === 's') return { kind: 'settings' };
  const [kind, asset, duration] = raw?.split(':') ?? [];
  const assetId = assetIdOf(asset);
  if (assetId === undefined) return undefined;
  const durationSec = durationOf(duration);
  if (durationSec === undefined) return undefined;
  if (kind === 'p') return { kind: 'pair', assetId, durationSec };
  if (kind === 'a') return { kind: 'analysis', assetId, durationSec };
  return undefined;
}

export interface StakePickerDeps {
  // readPairs: the symbol of the launch screen a save returns to (#320)
  backend: Pick<BackendClient, 'readTradingAccess' | 'setDemoStake' | 'readPairs'>;
  logger: Logger;
  dialog: LoginDialog;
  // the welcome's connect button, for a user with no account to trade on
  connectKeyboard: () => InlineKeyboard;
}

interface Screen {
  text: TelegramHtml;
  keyboard: InlineKeyboard;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );

function backTo(keyboard: InlineKeyboard, origin: StakeOrigin): InlineKeyboard {
  switch (origin.kind) {
    case 'settings':
      return keyboard.text(LABELS.stakeBackSettingsButton, SETTINGS_CALLBACK_DATA);
    case 'analysis':
      return keyboard.text(
        LABELS.stakeBackAnalysisButton,
        demoAnalysisCallbackData(origin.assetId, origin.durationSec),
      );
    case 'pair':
      return keyboard.text(
        LABELS.stakeBackLaunchButton,
        demoLaunchCallbackData(origin.assetId, origin.durationSec),
      );
    default:
      return origin satisfies never;
  }
}
const backKeyboard = (origin: StakeOrigin) => backTo(new InlineKeyboard(), origin);
// «💵 Сумма» to try again, then the way back
const retryKeyboard = (origin: StakeOrigin) =>
  backTo(
    new InlineKeyboard().text(LABELS.stakeMenuButton, stakeOpenCallbackData(origin)).row(),
    origin,
  );

export function createStakePicker<C extends Context>({
  backend,
  logger,
  dialog,
  connectKeyboard,
}: StakePickerDeps): {
  composer: Composer<C>;
  onStakeText: (ctx: Context, origin: StakeOrigin, text: string) => Promise<void>;
} {
  const composer = new Composer<C>();

  composer.callbackQuery(LEGACY_PICKER_PATTERNS, (ctx) => removeLegacyKeyboard(ctx, logger));

  // also the custom input's «↩️ Назад», so it ends a stake step left open
  composer.callbackQuery(PICKER.open, async (ctx) => {
    const origin = stakeOriginOf(ctx.match[1]);
    if (origin === undefined) {
      await answer(ctx);
      return;
    }
    endStakeStep(ctx.from.id);
    const [, access] = await Promise.all([
      answer(ctx),
      settle(backend.readTradingAccess(String(ctx.from.id))),
    ]);
    const screen = pickerScreen(access, origin, ctx.from.first_name);
    await editOrReply(ctx, screen.text, screen.keyboard);
  });

  composer.callbackQuery(PICKER.preset, async (ctx) => {
    const amount = tradeAmountSchema.safeParse(ctx.match[1]);
    const origin = stakeOriginOf(ctx.match[2]);
    if (!amount.success || origin === undefined) {
      await answer(ctx);
      return;
    }
    await saveInPlace(ctx, amount.data, origin);
  });

  composer.callbackQuery(PICKER.reset, async (ctx) => {
    const origin = stakeOriginOf(ctx.match[1]);
    if (origin === undefined) {
      await answer(ctx);
      return;
    }
    await saveInPlace(ctx, null, origin);
  });

  // The prompt in place of the picker; the typed amount comes to onStakeText through bot.ts's
  // text handler. Setting the step replaces a login step the user had open.
  composer.callbackQuery(PICKER.custom, async (ctx) => {
    const origin = stakeOriginOf(ctx.match[1]);
    if (origin === undefined) {
      await answer(ctx);
      return;
    }
    dialog.set(ctx.from.id, { step: 'stake', origin });
    await answer(ctx);
    await editOrReply(
      ctx,
      TEXTS.stakeInputPrompt,
      new InlineKeyboard().text(LABELS.stakeBackButton, stakeOpenCallbackData(origin)),
    );
  });

  // A typed amount: a new reply, the picker message stays as it was (the bot keeps no message id).
  async function onStakeText(ctx: Context, origin: StakeOrigin, text: string): Promise<void> {
    const from = ctx.from;
    if (from === undefined) return;
    const amount = parseDemoStakeInput(text);
    if (amount === undefined) {
      keepStakeStep(from.id);
      await replyHtml(ctx, TEXTS.stakeInputInvalid, { reply_markup: backKeyboard(origin) });
      return;
    }
    const screen = await savedScreen(
      from,
      await settle(backend.setDemoStake(String(from.id), amount)),
      origin,
    );
    await replyHtml(ctx, screen.text, { reply_markup: screen.keyboard });
  }

  async function saveInPlace(
    ctx: Context & { from: { id: number; first_name: string } },
    amount: DecimalString | null,
    origin: StakeOrigin,
  ): Promise<void> {
    const [, saved] = await Promise.all([
      answer(ctx),
      settle(backend.setDemoStake(String(ctx.from.id), amount)),
    ]);
    const screen = await savedScreen(ctx.from, saved, origin);
    await editOrReply(ctx, screen.text, screen.keyboard);
  }

  // The access read's refusals say what the stake press would say (demo-trade.ts amountOf).
  function pickerScreen(
    access: Settled<TradingAccessResponse>,
    origin: StakeOrigin,
    firstName: string,
  ): Screen {
    if (!access.ok) {
      logger.warn(
        { ...errorLogFields(access.error), ...backendErrorFields(access.error) },
        'trading access not read for the stake picker',
      );
      return { text: TEXTS.unavailable, keyboard: backKeyboard(origin) };
    }
    const { status, broker, brokerUnavailable, demoStake } = access.value;
    if (status === UserStatus.Blocked) {
      // the support link, as for every blocked user (#350), then the picker's way back
      return { text: TEXTS.blocked, keyboard: backTo(supportKeyboard().row(), origin) };
    }
    if (broker === null) {
      if (brokerUnavailable === BrokerBalanceUnavailableReason.NoAccount) {
        return { text: TEXTS.accountNone, keyboard: backTo(connectKeyboard().row(), origin) };
      }
      return {
        text:
          brokerUnavailable === BrokerBalanceUnavailableReason.AmbiguousAccount
            ? TEXTS.statusAmbiguous
            : TEXTS.stakeBalanceMissing,
        keyboard: backKeyboard(origin),
      };
    }
    const limits = { minTradeAmount: broker.minTradeAmount, demoAvailable: broker.demo.available };
    const presets = demoStakePresets(limits);
    const current = normalizeDecimal(demoStake ?? broker.minTradeAmount);
    const keyboard = new InlineKeyboard();
    for (const preset of presets) {
      const label = preset === current ? `${formatStake(preset)} ✅` : formatStake(preset);
      keyboard.text(label, stakePresetCallbackData(preset, origin));
    }
    if (presets.length > 0) keyboard.row();
    keyboard.text(LABELS.stakeCustomButton, stakeCustomCallbackData(origin)).row();
    if (demoStake !== null) {
      keyboard.text(LABELS.stakeResetButton, stakeResetCallbackData(origin)).row();
    }
    return {
      text: stakePickerText({
        user: userContextOf(firstName, TradeMode.Demo, access.value),
        ...limits,
        presets: presets.length,
      }),
      keyboard: backTo(keyboard, origin),
    };
  }

  // What a save answered, by where the answer came from (docs/bot-demo-trade.md -> The stake).
  // A typed amount's step stays open for a refusal before the write and an unknown outcome,
  // so the user can type again; it ends on a save and on a refusal the bot cannot act on. A save
  // opened from a launch screen returns to it with the saved amount (#320).
  async function savedScreen(
    from: { id: number; first_name: string },
    saved: Settled<SetDemoStakeResult>,
    origin: StakeOrigin,
  ): Promise<Screen> {
    const { id, first_name: firstName } = from;
    if (saved.ok && 'saved' in saved.value) {
      endStakeStep(id);
      switch (origin.kind) {
        case 'settings':
        case 'analysis':
          return {
            text: TEXTS.stakeSaved({ stake: saved.value.saved, firstName }),
            keyboard: backKeyboard(origin),
          };
        case 'pair':
          return savedLaunchScreen(origin, saved.value.saved, from);
        default:
          return origin satisfies never;
      }
    }
    if (saved.ok && 'refused' in saved.value) {
      keepStakeStep(id);
      const { error, limits } = saved.value.refused;
      const text =
        error === DemoStakeRefusal.Precision
          ? TEXTS.stakePrecisionDigits({
              digits: String(limits.scale),
              minStake: limits.minTradeAmount,
              demoAvailable: limits.demoAvailable,
            })
          : error === DemoStakeRefusal.BelowMinimum
            ? TEXTS.stakeBelowMinimum({ minStake: limits.minTradeAmount })
            : TEXTS.stakeAboveAvailableAmount({
                demoAvailable: limits.demoAvailable,
                minStake: limits.minTradeAmount,
              });
      return { text, keyboard: retryKeyboard(origin) };
    }
    if (saved.ok) throw new Error('unreachable: a save result is saved or refused');
    const { error } = saved;
    const fields = { ...errorLogFields(error), ...backendErrorFields(error) };
    const http = error instanceof BackendError && error.code === BackendErrorCode.HttpStatus;
    if (http && error.reason === DemoStakeErrorCode.BalanceUnavailable) {
      keepStakeStep(id);
      return { text: TEXTS.stakeBalanceMissing, keyboard: backKeyboard(origin) };
    }
    // no answer, a 5xx or a broken body: the UPDATE may have committed; saving the same amount
    // again is harmless, and the picker's «Сейчас:» line shows what is saved
    if (error instanceof BackendError && (!http || (error.status ?? 0) >= 500)) {
      keepStakeStep(id);
      logger.warn(fields, 'demo stake save outcome unknown');
      return { text: TEXTS.stakeSaveUnknown, keyboard: retryKeyboard(origin) };
    }
    endStakeStep(id);
    // no users row: before the first /start; anything else here is the bot's own bug
    if (http && error.reason === DemoStakeErrorCode.UserNotFound)
      logger.warn(fields, 'demo stake not saved');
    else logger.error(fields, 'demo stake not saved');
    return { text: TEXTS.unavailable, keyboard: backKeyboard(origin) };
  }

  // Any catalog will do, a stale one included: the symbol, and the payout, so a pair below the
  // cycle floor gets the launch press's refusal under the saved line rather than a cycle button
  // the session start would refuse (#379). Without a catalog, or without the pair in it, the
  // screen drops its symbol line and the launch stays, since the session start checks the pair.
  // The access read gives the user's mode (#121): a save from a launch screen drawn before a switch
  // to real draws the real launch screen; a failed read draws the demo one, whose cycle press the
  // backend refuses for a real-mode user (mode_not_allowed).
  async function savedLaunchScreen(
    { assetId, durationSec }: { assetId: number; durationSec: DemoDurationSec },
    amount: DecimalString | null,
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
    // the cycle floor is a demo cycle's: real mode has no cycle (#121)
    if (real === undefined && pair !== undefined && !pairPayoutAccepted(pair)) {
      const refusal = payoutTooLowScreen(pair, durationSec);
      return {
        text: telegramHtml`${TEXTS.stakeSavedLine({ firstName, stake: amount })}

${refusal.text}`,
        keyboard: refusal.keyboard,
      };
    }
    return launchScreen({
      assetId,
      durationSec,
      firstName,
      symbol: pair?.symbol ?? null,
      // in real mode the launch names the broker's minimum the real trade stakes (decision 22)
      amount: real === undefined ? amount : effectiveStake(real),
      saved: { amount },
      mode: real === undefined ? TradeMode.Demo : TradeMode.Real,
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
  // screen anew, a transport failure sends nothing more, anything else goes to bot.catch.
  async function editOrReply(ctx: Context, text: TelegramHtml, reply_markup: InlineKeyboard) {
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

  async function answer(ctx: Context): Promise<void> {
    await ctx.answerCallbackQuery().catch((error: unknown) => {
      logger.warn(
        { ...errorLogFields(error), ...telegramErrorFields(error, 'answerCallbackQuery') },
        'answering the callback query failed',
      );
    });
  }

  return { composer, onStakeText };
}
