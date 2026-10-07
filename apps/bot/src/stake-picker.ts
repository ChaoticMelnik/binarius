import { Composer, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import {
  BrokerBalanceUnavailableReason,
  DemoStakeErrorCode,
  DemoStakeRefusal,
  demoStakePresets,
  errorLogFields,
  normalizeDecimal,
  parseDemoStakeInput,
  tradeAmountSchema,
  UserStatus,
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
  durationAlternation,
  durationOf,
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
import { editRefusal } from './screen';
import { editMessageTextHtml, replyHtml } from './send';
import { formatStake } from './format';
import { LABELS, stakeLabel, stakePickerText, TEXTS } from './texts';

// The demo stake picker (#297, docs/bot-demo-trade.md -> The stake): presets from the broker's
// minimum, a typed amount, a reset to the minimum, and the way back to where it was opened from —
// /settings or an analysis screen. The bounds are the backend's (POST /trading/demo-stake): the
// bot sends a preset or a parsed input and shows the answer, so a forged amount gets the same
// refusal as a typed one.

// Where the picker was opened, carried in every callback as `s` or `a:<assetId>:<durationSec>`.
export type StakeOrigin =
  { kind: 'settings' } | { kind: 'analysis'; assetId: number; durationSec: DemoDurationSec };

// /settings re-rendered in place: the picker's way back when it was opened there (bot.ts)
export const SETTINGS_CALLBACK_DATA = 'settings';

const originData = (origin: StakeOrigin): string =>
  origin.kind === 'settings' ? 's' : `a:${origin.assetId}:${origin.durationSec}`;

// Bot API allows 1-64 bytes; the longest, `stk:s:999999999999.99999999:a:2147483647:15`, is 43.
export const stakeOpenCallbackData = (origin: StakeOrigin): string =>
  `${STAKE_PICKER_PREFIX}o:${originData(origin)}`;
export const stakePresetCallbackData = (amount: string, origin: StakeOrigin): string =>
  `${STAKE_PICKER_PREFIX}s:${amount}:${originData(origin)}`;
export const stakeResetCallbackData = (origin: StakeOrigin): string =>
  `${STAKE_PICKER_PREFIX}z:${originData(origin)}`;
export const stakeCustomCallbackData = (origin: StakeOrigin): string =>
  `${STAKE_PICKER_PREFIX}c:${originData(origin)}`;

// The four shapes over an origin; the legacy origin (#313) is an analysis of a duration from
// before #313 only, since /settings carries none.
const pickerPatterns = (origin: string) => ({
  open: new RegExp(`^${STAKE_PICKER_PREFIX}o:${origin}$`),
  preset: new RegExp(`^${STAKE_PICKER_PREFIX}s:(\\d{1,12}(?:\\.\\d{1,8})?):${origin}$`),
  reset: new RegExp(`^${STAKE_PICKER_PREFIX}z:${origin}$`),
  custom: new RegExp(`^${STAKE_PICKER_PREFIX}c:${origin}$`),
});
const PICKER = pickerPatterns(`(s|a:\\d{1,10}:(?:${durationAlternation(DEMO_DURATIONS_SEC)}))`);
const STAKE_OPEN_PATTERN = PICKER.open;
const STAKE_PRESET_PATTERN = PICKER.preset;
const STAKE_RESET_PATTERN = PICKER.reset;
const STAKE_CUSTOM_PATTERN = PICKER.custom;
const LEGACY_PICKER_PATTERNS = Object.values(
  pickerPatterns(`(a:\\d{1,10}:(?:${durationAlternation(LEGACY_DEMO_DURATIONS_SEC)}))`),
);

// undefined when forged: the asset id the backend would refuse, or a malformed origin
export function stakeOriginOf(raw: string | undefined): StakeOrigin | undefined {
  if (raw === 's') return { kind: 'settings' };
  const [kind, asset, duration] = raw?.split(':') ?? [];
  const assetId = assetIdOf(asset);
  const durationSec = durationOf(duration);
  if (kind !== 'a' || assetId === undefined || durationSec === undefined) return undefined;
  return { kind: 'analysis', assetId, durationSec };
}

export interface StakePickerDeps {
  backend: Pick<BackendClient, 'readTradingAccess' | 'setDemoStake'>;
  logger: Logger;
  dialog: LoginDialog;
  // the welcome's two ways in, for a user with no account to trade on
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

const backTo = (keyboard: InlineKeyboard, origin: StakeOrigin): InlineKeyboard =>
  origin.kind === 'settings'
    ? keyboard.text(LABELS.stakeBackSettingsButton, SETTINGS_CALLBACK_DATA)
    : keyboard.text(
        LABELS.stakeBackAnalysisButton,
        demoAnalysisCallbackData(origin.assetId, origin.durationSec),
      );
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
  composer.callbackQuery(STAKE_OPEN_PATTERN, async (ctx) => {
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
    const screen = pickerScreen(access, origin);
    await editOrReply(ctx, screen.text, screen.keyboard);
  });

  composer.callbackQuery(STAKE_PRESET_PATTERN, async (ctx) => {
    const amount = tradeAmountSchema.safeParse(ctx.match[1]);
    const origin = stakeOriginOf(ctx.match[2]);
    if (!amount.success || origin === undefined) {
      await answer(ctx);
      return;
    }
    await saveInPlace(ctx, amount.data, origin);
  });

  composer.callbackQuery(STAKE_RESET_PATTERN, async (ctx) => {
    const origin = stakeOriginOf(ctx.match[1]);
    if (origin === undefined) {
      await answer(ctx);
      return;
    }
    await saveInPlace(ctx, null, origin);
  });

  // The prompt in place of the picker; the typed amount comes to onStakeText through bot.ts's
  // text handler. Setting the step replaces a login step the user had open.
  composer.callbackQuery(STAKE_CUSTOM_PATTERN, async (ctx) => {
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
    const id = ctx.from?.id;
    if (id === undefined) return;
    const amount = parseDemoStakeInput(text);
    if (amount === undefined) {
      keepStakeStep(id);
      await replyHtml(ctx, TEXTS.stakeInputInvalid);
      return;
    }
    const screen = savedScreen(id, await settle(backend.setDemoStake(String(id), amount)), origin);
    await replyHtml(ctx, screen.text, { reply_markup: screen.keyboard });
  }

  async function saveInPlace(
    ctx: Context & { from: { id: number } },
    amount: DecimalString | null,
    origin: StakeOrigin,
  ): Promise<void> {
    const [, saved] = await Promise.all([
      answer(ctx),
      settle(backend.setDemoStake(String(ctx.from.id), amount)),
    ]);
    const screen = savedScreen(ctx.from.id, saved, origin);
    await editOrReply(ctx, screen.text, screen.keyboard);
  }

  // The access read's refusals say what the stake press would say (demo-trade.ts amountOf).
  function pickerScreen(access: Settled<TradingAccessResponse>, origin: StakeOrigin): Screen {
    if (!access.ok) {
      logger.warn(
        { ...errorLogFields(access.error), ...backendErrorFields(access.error) },
        'trading access not read for the stake picker',
      );
      return { text: TEXTS.unavailable, keyboard: backKeyboard(origin) };
    }
    const { status, broker, brokerUnavailable, demoStake } = access.value;
    if (status === UserStatus.Blocked) {
      return { text: TEXTS.blocked, keyboard: backKeyboard(origin) };
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
      text: stakePickerText({ stake: demoStake, ...limits, presets: presets.length }),
      keyboard: backTo(keyboard, origin),
    };
  }

  // What a save answered, by where the answer came from (docs/bot-demo-trade.md -> The stake).
  // A typed amount's step stays open for a refusal before the write and an unknown outcome,
  // so the user can type again; it ends on a save and on a refusal the bot cannot act on.
  function savedScreen(
    id: number,
    saved: Settled<SetDemoStakeResult>,
    origin: StakeOrigin,
  ): Screen {
    if (saved.ok && 'saved' in saved.value) {
      endStakeStep(id);
      return {
        text: TEXTS.stakeSaved(stakeLabel(saved.value.saved)),
        keyboard: backKeyboard(origin),
      };
    }
    if (saved.ok && 'refused' in saved.value) {
      keepStakeStep(id);
      const { error, limits } = saved.value.refused;
      const text =
        error === DemoStakeRefusal.Precision
          ? TEXTS.stakePrecisionDigits(String(limits.scale))
          : error === DemoStakeRefusal.BelowMinimum
            ? TEXTS.stakeBelowMinimum(formatStake(limits.minTradeAmount))
            : TEXTS.stakeAboveAvailableAmount(formatStake(limits.demoAvailable));
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
