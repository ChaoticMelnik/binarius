import { Composer, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import {
  editRefusal,
  BrokerBalanceUnavailableReason,
  checkStake,
  decimalLessThan,
  errorLogFields,
  TradeMode,
  TradingModeErrorCode,
  UserStatus,
  type BrokerBalanceView,
  type SetTradingModeResponse,
  type TelegramHtml,
  type TradingAccessResponse,
  telegramErrorFields,
} from '@binarius/shared';
import {
  BackendError,
  BackendErrorCode,
  backendErrorFields,
  type BackendClient,
} from './backend-client';
import { MODE_CALLBACK_DATA, menuKeyboard, supportKeyboard, withMenu } from './keyboards';
import type { Logger } from './logging';
import { answerCallback } from './answer-callback';
import { settle, type Settled } from './settled';
import { editMessageTextHtml, replyHtml } from './send';
import {
  LABELS,
  TEXTS,
  textOf,
  tradingModeConfirm,
  tradingModeResult,
  tradingModeScreen,
} from './texts';

// The mode screen (#474, docs/trading-mode.md → The mode screen): the user's trading mode, switched
// in the bot only here. `mode` opens it from the status card — a photo, or text by the fallback,
// never edited — as a new message; `mode:x` redraws it in place under the screen's own messages
// («↩️ Отмена» of the confirm, «⚙️ Режим» under a refusal), so a cancelled confirm loses its
// «✅ Подтверждаю»; `mode:r` asks to confirm real, `mode:r:ok` switches to real, `mode:d` back to
// demo; all but `mode` edit in place. The two switches are writes (WRITE_CALLBACK_PREFIXES): no
// «🔄 Повторить» ever carries them, every failure leads to «⚙️ Режим» and the menu; `mode:x` and
// `mode:r` are reads.
export const MODE_SCREEN_CALLBACK_DATA = 'mode:x';
export const MODE_CONFIRM_CALLBACK_DATA = 'mode:r';
export const MODE_REAL_CALLBACK_DATA = 'mode:r:ok';
export const MODE_DEMO_CALLBACK_DATA = 'mode:d';

export interface TradingModeDeps {
  backend: Pick<BackendClient, 'readTradingAccess' | 'setTradingMode'>;
  logger: Logger;
  // the welcome's connect button, for a user with no account to trade on
  connectKeyboard: () => InlineKeyboard;
}

interface Screen {
  text: TelegramHtml;
  keyboard: InlineKeyboard;
}

// the way back to the screen, then the menu: under every refusal and every unknown outcome
const backToScreen = (): InlineKeyboard =>
  withMenu(new InlineKeyboard().text(LABELS.modeScreenButton, MODE_SCREEN_CALLBACK_DATA));

// A switch the backend refused before its write, by code: the text, and «⚙️ Режим» under it.
// Exhaustive, so a code added to the contract fails tsc here; user_not_found is logged (the access
// read that drew the screen found the row).
export const SWITCH_REFUSALS = {
  [TradingModeErrorCode.RealBalanceBelowMinimum]: 'modeBelowMinimum',
  [TradingModeErrorCode.BalanceUnavailable]: 'stakeBalanceMissing',
  [TradingModeErrorCode.DemoOnly]: 'tradingDemoOnly',
  [TradingModeErrorCode.UserNotFound]: 'unavailable',
} as const satisfies Record<TradingModeErrorCode, Parameters<typeof textOf>[0]>;

const isSwitchRefusal = (reason: string | undefined): reason is TradingModeErrorCode =>
  reason !== undefined && Object.hasOwn(SWITCH_REFUSALS, reason);

// A 5xx, no answer, or a 2xx that is not the contract's: the UPDATE may have committed.
const outcomeUnknown = (error: unknown): boolean =>
  error instanceof BackendError &&
  (error.code !== BackendErrorCode.HttpStatus || (error.status ?? 0) >= 500);

export function createTradingModeComposer<C extends Context>({
  backend,
  logger,
  connectKeyboard,
}: TradingModeDeps): Composer<C> {
  const composer = new Composer<C>();

  composer.callbackQuery(MODE_CALLBACK_DATA, async (ctx) => {
    const [, access] = await Promise.all([answerCallback(ctx, logger), readAccess(ctx.from.id)]);
    const screen = accessScreen(access, modeScreen);
    await replyHtml(ctx, screen.text, { reply_markup: screen.keyboard });
  });

  composer.callbackQuery(MODE_SCREEN_CALLBACK_DATA, async (ctx) => {
    const [, access] = await Promise.all([answerCallback(ctx, logger), readAccess(ctx.from.id)]);
    await editOrReply(ctx, accessScreen(access, modeScreen));
  });

  // the confirm names the amount a real trade stakes, so access is read again for it
  composer.callbackQuery(MODE_CONFIRM_CALLBACK_DATA, async (ctx) => {
    const [, access] = await Promise.all([answerCallback(ctx, logger), readAccess(ctx.from.id)]);
    await editOrReply(ctx, accessScreen(access, confirmScreen));
  });

  composer.callbackQuery(MODE_REAL_CALLBACK_DATA, async (ctx) => {
    await switchTo(ctx, TradeMode.Real);
  });

  composer.callbackQuery(MODE_DEMO_CALLBACK_DATA, async (ctx) => {
    await switchTo(ctx, TradeMode.Demo);
  });

  async function switchTo(ctx: Context & { from: { id: number } }, mode: TradeMode): Promise<void> {
    const [, result] = await Promise.all([
      answerCallback(ctx, logger),
      settle(backend.setTradingMode(String(ctx.from.id), mode)),
    ]);
    await editOrReply(ctx, await switchScreen(ctx.from.id, result));
  }

  async function switchScreen(
    telegramUserId: number,
    result: Settled<SetTradingModeResponse>,
  ): Promise<Screen> {
    if (result.ok) {
      // the mode the server answered: a switch between the screen's read and this press wins
      return {
        text: tradingModeResult({
          tradingMode: result.value.tradingMode,
          stoppedSessions: result.value.stoppedSessions,
        }),
        keyboard: menuKeyboard(),
      };
    }
    const { error } = result;
    const fields = { ...errorLogFields(error), ...backendErrorFields(error) };
    if (outcomeUnknown(error)) {
      // the bot does not infer: the screen with the mode the backend has now
      logger.warn(fields, 'trading mode outcome unknown');
      const access = await readAccess(telegramUserId);
      if (!access.ok) return { text: TEXTS.modeOutcomeUnknown, keyboard: backToScreen() };
      return accessScreen(access, modeScreen);
    }
    const reason = error instanceof BackendError ? error.reason : undefined;
    if (isSwitchRefusal(reason)) {
      if (reason === TradingModeErrorCode.UserNotFound) {
        logger.warn(fields, 'trading mode not changed');
      }
      return { text: textOf(SWITCH_REFUSALS[reason]), keyboard: backToScreen() };
    }
    logger.error(fields, 'trading mode not changed');
    return { text: TEXTS.unavailable, keyboard: backToScreen() };
  }

  async function readAccess(telegramUserId: number): Promise<Settled<TradingAccessResponse>> {
    const access = await settle(backend.readTradingAccess(String(telegramUserId)));
    if (!access.ok) {
      logger.warn(
        { ...errorLogFields(access.error), ...backendErrorFields(access.error) },
        'trading access not read for the mode screen',
      );
    }
    return access;
  }

  // The access read's refusals, as the stake picker words them. A user in real mode always gets the
  // screen, so the way back to demo stays open with no account or no balance; one in demo mode
  // with no balance to check gets the reason and no enable button (the route would refuse).
  function accessScreen(
    access: Settled<TradingAccessResponse>,
    screen: (value: TradingAccessResponse) => Screen,
  ): Screen {
    if (!access.ok) return { text: TEXTS.unavailable, keyboard: backToScreen() };
    const { status, broker, brokerUnavailable, tradingMode } = access.value;
    if (status === UserStatus.Blocked) {
      return { text: TEXTS.blocked, keyboard: supportKeyboard() };
    }
    if (broker === null && tradingMode === TradeMode.Demo) {
      if (brokerUnavailable === BrokerBalanceUnavailableReason.NoAccount) {
        return { text: TEXTS.accountNone, keyboard: withMenu(connectKeyboard()) };
      }
      return {
        text:
          brokerUnavailable === BrokerBalanceUnavailableReason.AmbiguousAccount
            ? TEXTS.statusAmbiguous
            : TEXTS.stakeBalanceMissing,
        keyboard: menuKeyboard(),
      };
    }
    return screen(access.value);
  }

  function modeScreen({
    tradingMode,
    broker,
    realStake,
    tradingOpen,
  }: TradingAccessResponse): Screen {
    const keyboard =
      tradingMode === TradeMode.Real
        ? new InlineKeyboard().text(LABELS.modeBackDemoButton, MODE_DEMO_CALLBACK_DATA)
        : new InlineKeyboard().text(LABELS.modeEnableButton, MODE_CONFIRM_CALLBACK_DATA);
    return {
      text: tradingModeScreen({ mode: tradingMode, broker, realStake, tradingOpen }),
      keyboard: withMenu(keyboard),
    };
  }

  // A user in real mode already gets the screen. The real balance is checked against the broker's
  // minimum on the snapshot of any age, as the route does (it checks again): below it the refusal
  // at once, with no confirm button. The amount is the real stake whatever the mode now; a stake
  // that fails checkStake only adds a line, the switch stays open (#474 clarify 2).
  function confirmScreen(access: TradingAccessResponse): Screen {
    const { broker } = access;
    if (access.tradingMode === TradeMode.Real || broker === null) return modeScreen(access);
    if (realBelowMinimum(broker)) {
      return { text: TEXTS.modeBelowMinimum, keyboard: backToScreen() };
    }
    const stake = access.realStake ?? broker.minTradeAmount;
    const limits = { minTradeAmount: broker.minTradeAmount, available: broker.real.available };
    return {
      text: tradingModeConfirm({
        stake,
        minTradeAmount: broker.minTradeAmount,
        realAvailable: broker.real.available,
        outOfBounds: checkStake(stake, limits) !== null,
      }),
      keyboard: new InlineKeyboard()
        .text(LABELS.modeConfirmButton, MODE_REAL_CALLBACK_DATA)
        .text(LABELS.modeCancelButton, MODE_SCREEN_CALLBACK_DATA),
    };
  }

  // Every refusal of an edit is classified as in demo.ts: already shown is done, gone gets the
  // screen anew, a transport failure sends nothing more, anything else goes to bot.catch.
  async function editOrReply(ctx: Context, { text, keyboard }: Screen): Promise<void> {
    try {
      await editMessageTextHtml(ctx, text, { reply_markup: keyboard });
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'shown') return;
      if (refusal === 'gone') {
        await replyHtml(ctx, text, { reply_markup: keyboard });
        return;
      }
      if (!(error instanceof HttpError)) throw error;
      logger.error(
        { ...errorLogFields(error), ...telegramErrorFields(error, 'editMessageText') },
        'the mode screen edit failed in transport, sending nothing more',
      );
    }
  }

  return composer;
}

const realBelowMinimum = (broker: BrokerBalanceView): boolean =>
  decimalLessThan(broker.real.available, broker.minTradeAmount);
