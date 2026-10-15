import { Composer, InlineKeyboard, type Context } from 'grammy';
import {
  errorLogFields,
  MENU_CALLBACK_DATA,
  PAYSUPPORT_LIST_CALLBACK,
  PAYSUPPORT_REFUND_PATTERN,
  paysupportRefundCallbackData,
  StarPaymentStatus,
  StarsRefundErrorCode,
  StarsRefundRequestOutcome,
  supportUrl,
  UUID_PATTERN,
  type StarPaymentView,
  type TelegramHtml,
} from '@binarius/shared';
import { BackendError, backendErrorFields, type BackendClient } from './backend-client';
import { retryKeyboard, supportKeyboard, withMenu } from './keyboards';
import { telegramErrorFields, type Logger } from './logging';
import { replyHtml } from './send';
import { LABELS, paysupportListLabel, paysupportRefundLabel, paysupportText, TEXTS } from './texts';

export interface PaysupportDeps {
  backend: Pick<BackendClient, 'listStarsPayments' | 'requestStarsRefund'>;
  logger: Logger;
}

// /paysupport (#118, docs/stars.md → /paysupport), the command the Stars rules require: the payer's
// last payments, «Нужен возврат» under each one that can still be refunded, and the support chat.
// The press records a request for a staff member, who refunds with `stars refund`; nothing here
// refunds. The bot mounts this on its private-chat composer, ahead of the text handler that
// swallows unknown commands.
export function createPaysupportComposer({ backend, logger }: PaysupportDeps): Composer<Context> {
  const privateChats = new Composer<Context>();

  privateChats.command('paysupport', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) return;
    await showPayments(ctx, String(from.id));
  });

  // a read: «🔄 Повторить» carries it, and «↩️ К списку оплат» leads here after a request
  privateChats.callbackQuery(PAYSUPPORT_LIST_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery().catch((error: unknown) => logAnswerFailure(logger, error));
    await showPayments(ctx, String(ctx.from.id));
  });

  async function showPayments(ctx: Context, telegramUserId: string): Promise<void> {
    let payments: StarPaymentView[];
    try {
      payments = await backend.listStarsPayments(telegramUserId);
    } catch (error) {
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error) },
        '/paysupport not read',
      );
      await replyHtml(ctx, TEXTS.unavailable, {
        reply_markup: retryKeyboard(PAYSUPPORT_LIST_CALLBACK),
      });
      return;
    }
    if (payments.length === 0) {
      await replyHtml(ctx, TEXTS.paysupportEmpty, { reply_markup: withMenu(supportKeyboard()) });
      return;
    }
    await replyHtml(ctx, paysupportText(payments), { reply_markup: paymentsKeyboard(payments) });
  }

  // A write. Every answer leads back to the list, never to the press again (Rule 31): a request
  // whose outcome is unknown may be recorded, and the list shows it on the re-read.
  privateChats.callbackQuery(PAYSUPPORT_REFUND_PATTERN, async (ctx) => {
    const paymentId = ctx.match[1] ?? '';
    if (!UUID_PATTERN.test(paymentId)) {
      await ctx.answerCallbackQuery().catch((error: unknown) => logAnswerFailure(logger, error));
      await reply(ctx, TEXTS.paysupportNotFound);
      return;
    }
    const [answered, requested] = await Promise.allSettled([
      ctx.answerCallbackQuery(),
      backend.requestStarsRefund(String(ctx.from.id), paymentId),
    ]);
    if (answered.status === 'rejected') logAnswerFailure(logger, answered.reason);
    if (requested.status === 'fulfilled') {
      await reply(
        ctx,
        requested.value === StarsRefundRequestOutcome.Requested
          ? TEXTS.paysupportRequested
          : TEXTS.paysupportAlreadyRequested,
      );
      return;
    }
    const error: unknown = requested.reason;
    const reason = error instanceof BackendError ? error.reason : undefined;
    switch (reason) {
      case StarsRefundErrorCode.AlreadyRefunded:
        await reply(ctx, TEXTS.paysupportAlreadyRefunded);
        return;
      case StarsRefundErrorCode.PaymentNotFound:
        await reply(ctx, TEXTS.paysupportNotFound);
        return;
      default:
        logger.warn(
          { ...errorLogFields(error), ...backendErrorFields(error) },
          'stars refund request not recorded',
        );
        await reply(ctx, TEXTS.unavailable);
    }
  });

  return privateChats;
}

const reply = (ctx: Context, text: TelegramHtml) =>
  replyHtml(ctx, text, { reply_markup: backToListKeyboard() });

// «↩️ К списку оплат», then the menu
export const backToListKeyboard = (): InlineKeyboard =>
  withMenu(new InlineKeyboard().text(paysupportListLabel(), PAYSUPPORT_LIST_CALLBACK));

// A refund button for each payment that can still be asked about, then the support chat and the
// menu.
export function paymentsKeyboard(payments: readonly StarPaymentView[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const payment of payments) {
    if (payment.status === StarPaymentStatus.Refunded || payment.requested) continue;
    keyboard
      .text(paysupportRefundLabel(payment.paidAt), paysupportRefundCallbackData(payment.id))
      .row();
  }
  return keyboard
    .url(LABELS.supportButton, supportUrl())
    .row()
    .text(LABELS.menuButton, MENU_CALLBACK_DATA);
}

function logAnswerFailure(logger: Logger, error: unknown): void {
  logger.warn(
    { ...errorLogFields(error), ...telegramErrorFields(error, 'answerCallbackQuery') },
    'answering the callback query failed',
  );
}
