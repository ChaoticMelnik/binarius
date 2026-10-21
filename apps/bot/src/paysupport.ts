import { Composer, type Context } from 'grammy';
import {
  ButtonRole,
  callbackButton,
  errorLogFields,
  PAYSUPPORT_LIST_CALLBACK,
  PAYSUPPORT_REFUND_PATTERN,
  paysupportRefundCallbackData,
  StarPaymentStatus,
  StarsRefundErrorCode,
  StarsRefundRequestOutcome,
  UUID_PATTERN,
  type BotKeyboard,
  type StarPaymentView,
  type TelegramHtml,
  telegramErrorFields,
} from '@binarius/shared';
import { BackendError, backendErrorFields, type BackendClient } from './backend-client';
import { retryKeyboard, supportButton, withMenu } from './keyboards';
import type { Logger } from './logging';
import { replyHtml } from './send';
import { paysupportListLabel, paysupportRefundLabel, paysupportText, TEXTS } from './texts';

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
      await replyHtml(ctx, TEXTS.paysupportEmpty, { reply_markup: withMenu([supportButton()]) });
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
export const backToListKeyboard = (): BotKeyboard =>
  withMenu([callbackButton(ButtonRole.Nav, paysupportListLabel(), PAYSUPPORT_LIST_CALLBACK)]);

// A refund button for each payment that can still be asked about, each on its own row (#475: a
// step forward), then the support chat and the menu in one row.
export const paymentsKeyboard = (payments: readonly StarPaymentView[]): BotKeyboard =>
  withMenu([
    ...payments
      .filter((payment) => payment.status !== StarPaymentStatus.Refunded && !payment.requested)
      .map((payment) =>
        callbackButton(
          ButtonRole.Forward,
          paysupportRefundLabel(payment.paidAt),
          paysupportRefundCallbackData(payment.id),
        ),
      ),
    supportButton(),
  ]);

function logAnswerFailure(logger: Logger, error: unknown): void {
  logger.warn(
    { ...errorLogFields(error), ...telegramErrorFields(error, 'answerCallbackQuery') },
    'answering the callback query failed',
  );
}
