import { Composer, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import {
  BrokerBalanceUnavailableReason,
  errorLogFields,
  TradeMode,
  TradingModeErrorCode,
  UserStatus,
  type TelegramHtml,
  type TradingAccessResponse,
} from '@binarius/shared';
import {
  BackendError,
  BackendErrorCode,
  backendErrorFields,
  type BackendClient,
} from './backend-client';
import { MODE_CALLBACK_DATA, menuKeyboard, supportKeyboard, withMenu } from './keyboards';
import { telegramErrorFields, type Logger } from './logging';
import { editRefusal } from './screen';
import { editMessageTextHtml, replyHtml } from './send';
import { LABELS, TEXTS, tradingModeConfirm, tradingModeScreen } from './texts';

// The mode screen (#121, docs/trading-mode.md): the user's trading mode, switched only here (/stop
// returning the user to demo is #121's follow-up). `mode` opens it from the status card — a photo, or text by the fallback,
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

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );

// the way back to the screen, then the menu: under every refusal and every unknown outcome
const backToScreen = (): InlineKeyboard =>
  withMenu(new InlineKeyboard().text(LABELS.modeScreenButton, MODE_SCREEN_CALLBACK_DATA));

// A switch the backend refused before its write, by code: the text and «⚙️ Режим». Exhaustive, so
// a code added to the contract fails tsc here; user_not_found is logged (the access read that drew
// the screen found the row).
const SWITCH_REFUSALS = {
  [TradingModeErrorCode.RealBalanceBelowMinimum]: () => TEXTS.modeBelowMinimum,
  [TradingModeErrorCode.BalanceUnavailable]: () => TEXTS.stakeBalanceMissing,
  [TradingModeErrorCode.DemoOnly]: () => TEXTS.tradingDemoOnly,
  [TradingModeErrorCode.UserNotFound]: () => TEXTS.unavailable,
} as const satisfies Record<TradingModeErrorCode, () => TelegramHtml>;

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
    const [, access] = await Promise.all([answer(ctx), readAccess(ctx.from.id)]);
    const screen = accessScreen(access, (value) => modeScreen(value));
    await replyHtml(ctx, screen.text, { reply_markup: screen.keyboard });
  });

  composer.callbackQuery(MODE_SCREEN_CALLBACK_DATA, async (ctx) => {
    const [, access] = await Promise.all([answer(ctx), readAccess(ctx.from.id)]);
    await editOrReply(
      ctx,
      accessScreen(access, (value) => modeScreen(value)),
    );
  });

  // the confirm names the amount the first real trade stakes, so access is read again for it
  composer.callbackQuery(MODE_CONFIRM_CALLBACK_DATA, async (ctx) => {
    const [, access] = await Promise.all([answer(ctx), readAccess(ctx.from.id)]);
    const screen = accessScreen(access, (value) =>
      value.tradingMode === TradeMode.Real || value.broker === null
        ? modeScreen(value)
        : {
            text: tradingModeConfirm(value.broker.minTradeAmount),
            keyboard: new InlineKeyboard()
              .text(LABELS.modeConfirmButton, MODE_REAL_CALLBACK_DATA)
              .text(LABELS.modeCancelButton, MODE_SCREEN_CALLBACK_DATA),
          },
    );
    await editOrReply(ctx, screen);
  });

  composer.callbackQuery(MODE_REAL_CALLBACK_DATA, async (ctx) => {
    await switchTo(ctx, TradeMode.Real);
  });

  composer.callbackQuery(MODE_DEMO_CALLBACK_DATA, async (ctx) => {
    await switchTo(ctx, TradeMode.Demo);
  });

  async function switchTo(ctx: Context & { from: { id: number } }, mode: TradeMode): Promise<void> {
    const [, result] = await Promise.all([
      answer(ctx),
      settle(backend.setTradingMode(String(ctx.from.id), mode)),
    ]);
    await editOrReply(ctx, await switchScreen(ctx.from.id, result));
  }

  async function switchScreen(
    telegramUserId: number,
    result: Settled<Awaited<ReturnType<BackendClient['setTradingMode']>>>,
  ): Promise<Screen> {
    if (result.ok) {
      // the mode the server answered: a switch between the screen's read and this press wins
      return {
        text: result.value.tradingMode === TradeMode.Real ? TEXTS.modeEnabled : TEXTS.modeDisabled,
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
      return accessScreen(access, (value) => modeScreen(value));
    }
    const reason = error instanceof BackendError ? error.reason : undefined;
    if (isSwitchRefusal(reason)) {
      if (reason === TradingModeErrorCode.UserNotFound)
        logger.warn(fields, 'trading mode not changed');
      return { text: SWITCH_REFUSALS[reason](), keyboard: backToScreen() };
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

  function modeScreen({ tradingMode, broker, tradingOpen }: TradingAccessResponse): Screen {
    const keyboard =
      tradingMode === TradeMode.Real
        ? new InlineKeyboard().text(LABELS.modeBackDemoButton, MODE_DEMO_CALLBACK_DATA)
        : new InlineKeyboard().text(LABELS.modeEnableButton, MODE_CONFIRM_CALLBACK_DATA);
    return {
      text: tradingModeScreen({ mode: tradingMode, broker, tradingOpen }),
      keyboard: withMenu(keyboard),
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
