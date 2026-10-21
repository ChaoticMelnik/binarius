import { Composer, GrammyError, HttpError, type Context } from 'grammy';
import type { User } from 'grammy/types';
import {
  BrokerAccountStatus,
  BUY_CALLBACK_DATA,
  BUY_PACKAGE_PATTERN,
  errorLogFields,
  keyboardOf,
  StarsCreditOutcome,
  StarsErrorCode,
  UserErrorCode,
  UserStatus,
  telegramErrorFields,
  type BotButton,
} from '@binarius/shared';
import { BackendError, backendErrorFields, type BackendClient } from './backend-client';
import {
  buyPackagesKeyboard,
  menuKeyboard,
  retryKeyboard,
  supportButton,
  supportKeyboard,
  withMenu,
} from './keyboards';
import type { Logger } from './logging';
import { replyHtml, replyWithInvoiceStars } from './send';
import {
  starsInvoiceDescription,
  starsInvoiceTitle,
  starsPayLabel,
  starsPreCheckoutError,
  TEXTS,
} from './texts';

export interface StarsDeps {
  backend: Pick<
    BackendClient,
    'readAccount' | 'createStarsInvoice' | 'checkStarsPreCheckout' | 'reportStarsPaid'
  >;
  logger: Logger;
  // the welcome's connect button, for a user with no account to buy for
  connectButtons: () => BotButton[];
}

// Buying tokens for Telegram Stars (#117, docs/stars.md): /buy and «⭐ Купить» show the
// packages, a package's button sends the invoice, and successful_payment is reported for the
// credit. The bot mounts this on its private-chat composer, ahead of the text handler that swallows
// unknown commands; the pre-checkout query, which has no chat, is createPreCheckoutComposer's.
export function createStarsComposer({
  backend,
  logger,
  connectButtons,
}: StarsDeps): Composer<Context> {
  const privateChats = new Composer<Context>();

  privateChats.command('buy', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) return;
    await showPackages(ctx, from);
  });

  privateChats.callbackQuery(BUY_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery().catch((error: unknown) => logAnswerFailure(logger, error));
    await showPackages(ctx, ctx.from);
  });

  // Only a user with an active account sees the packages (the owner's answer of 2026-10-08): the
  // read is /account's.
  async function showPackages(ctx: Context, from: User): Promise<void> {
    let user;
    try {
      user = await backend.readAccount(String(from.id));
    } catch (error) {
      // no users row yet: nothing is connected, which is an answer, as in /account
      if (error instanceof BackendError && error.reason === UserErrorCode.UserNotFound) {
        await replyHtml(ctx, TEXTS.buyNeedsAccount, { reply_markup: keyboardOf(connectButtons()) });
        return;
      }
      logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, '/buy not read');
      await replyHtml(ctx, TEXTS.unavailable, { reply_markup: retryKeyboard(BUY_CALLBACK_DATA) });
      return;
    }
    if (user.status === UserStatus.Blocked) {
      await replyHtml(ctx, TEXTS.blocked, { reply_markup: supportKeyboard() });
      return;
    }
    if (!user.accounts.some((account) => account.status === BrokerAccountStatus.Active)) {
      await replyHtml(ctx, TEXTS.buyNeedsAccount, { reply_markup: keyboardOf(connectButtons()) });
      return;
    }
    await replyHtml(ctx, TEXTS.buyScreen, { reply_markup: buyPackagesKeyboard() });
  }

  // A read: the backend writes nothing for an invoice, so «🔄 Повторить» may carry the press.
  privateChats.callbackQuery(BUY_PACKAGE_PATTERN, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [answered, invoice] = await Promise.allSettled([
      ctx.answerCallbackQuery(),
      backend.createStarsInvoice(String(ctx.from.id), ctx.match[1] ?? ''),
    ]);
    if (answered.status === 'rejected') logAnswerFailure(logger, answered.reason);
    if (invoice.status === 'fulfilled') {
      const { payload, package: pack } = invoice.value;
      await replyWithInvoiceStars(
        ctx,
        {
          title: starsInvoiceTitle(),
          description: starsInvoiceDescription(pack.tokens),
          payload,
          label: starsInvoiceTitle(),
          stars: pack.stars,
        },
        { pay: starsPayLabel(pack.stars), then: menuKeyboard() },
      );
      return;
    }
    const error: unknown = invoice.reason;
    const reason = error instanceof BackendError ? error.reason : undefined;
    switch (reason) {
      case StarsErrorCode.UserBlocked:
        await replyHtml(ctx, TEXTS.blocked, { reply_markup: supportKeyboard() });
        return;
      case StarsErrorCode.UserNotFound:
      case StarsErrorCode.NoActiveAccount:
        await replyHtml(ctx, TEXTS.buyNeedsAccount, { reply_markup: keyboardOf(connectButtons()) });
        return;
      case StarsErrorCode.PackageUnknown:
        await replyHtml(ctx, TEXTS.buyPackageGone, { reply_markup: buyPackagesKeyboard() });
        return;
      default:
        logger.warn(
          { ...errorLogFields(error), ...backendErrorFields(error) },
          'stars invoice not created',
        );
        await replyHtml(ctx, TEXTS.unavailable, { reply_markup: retryKeyboard(data) });
    }
  });

  // The user has paid. Any failure of the report is the reconciler's to settle within minutes
  // (docs/stars.md → Reconciliation), so it is never told as a failure: the bot does not re-read to
  // guess.
  privateChats.on('message:successful_payment', async (ctx) => {
    const payment = ctx.message.successful_payment;
    let report;
    try {
      report = await backend.reportStarsPaid({
        telegramUserId: String(ctx.from.id),
        telegramPaymentChargeId: payment.telegram_payment_charge_id,
        providerPaymentChargeId: payment.provider_payment_charge_id,
        invoicePayload: payment.invoice_payload,
        currency: payment.currency,
        totalAmount: payment.total_amount,
        paidAt: ctx.message.date,
      });
    } catch (error) {
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error) },
        'stars payment not reported',
      );
      // the backend's definite word that no row can hold this payment: a person resolves it
      if (error instanceof BackendError && error.reason === StarsErrorCode.PayloadUnknown) {
        await replyHtml(ctx, TEXTS.starsHeld, { reply_markup: withMenu([supportButton()]) });
        return;
      }
      await replyHtml(ctx, TEXTS.starsPending, { reply_markup: menuKeyboard() });
      return;
    }
    if (report.outcome === StarsCreditOutcome.Held) {
      await replyHtml(ctx, TEXTS.starsHeld, { reply_markup: withMenu([supportButton()]) });
      return;
    }
    await replyHtml(
      ctx,
      TEXTS.starsCredited({ purchasedTokens: report.tokens, tokenBalance: report.balance }),
      { reply_markup: menuKeyboard() },
    );
  });

  return privateChats;
}

// Telegram charges only after an `ok: true`, so anything but the backend's yes is a no: a refusal,
// a failure, a timeout. Never a yes without the backend. On the bot: the query carries no chat.
export function createPreCheckoutComposer({
  backend,
  logger,
}: Pick<StarsDeps, 'logger'> & { backend: Pick<BackendClient, 'checkStarsPreCheckout'> }) {
  const composer = new Composer<Context>();
  composer.on('pre_checkout_query', async (ctx) => {
    const query = ctx.preCheckoutQuery;
    let failed = false;
    let ok = false;
    try {
      const answer = await backend.checkStarsPreCheckout({
        telegramUserId: String(query.from.id),
        invoicePayload: query.invoice_payload,
        currency: query.currency,
        totalAmount: query.total_amount,
      });
      ok = answer.ok;
    } catch (error) {
      failed = true;
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error) },
        'stars pre-checkout not checked',
      );
    }
    try {
      await (ok
        ? ctx.answerPreCheckoutQuery(true)
        : ctx.answerPreCheckoutQuery(false, { error_message: starsPreCheckoutError(failed) }));
    } catch (error) {
      if (!(error instanceof GrammyError || error instanceof HttpError)) throw error;
      logger.warn(
        { ...errorLogFields(error), ...telegramErrorFields(error, 'answerPreCheckoutQuery') },
        'the pre-checkout query was not answered',
      );
    }
  });

  return composer;
}

function logAnswerFailure(logger: Logger, error: unknown): void {
  logger.warn(
    { ...errorLogFields(error), ...telegramErrorFields(error, 'answerCallbackQuery') },
    'answering the callback query failed',
  );
}
