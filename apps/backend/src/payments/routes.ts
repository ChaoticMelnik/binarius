import type { FastifyPluginAsync } from 'fastify';
import {
  errorLogFields,
  parseStarsInvoicePayload,
  starPackageOf,
  STARS_CURRENCY,
  starsInvoicePayload,
  starsInvoiceRequestSchema,
  starsPaidRequestSchema,
  starsPreCheckoutRequestSchema,
  StarsCreditOutcome,
  StarsErrorCode,
  StarsPreCheckoutRefusal,
  StarPaymentStatus,
  starsPaymentsRequestSchema,
  starsRefundRequestSchema,
  StarsRefundErrorCode,
  StarsRefundRequestOutcome,
  UserStatus,
  type StarsPaidResponse,
  type StarsPaymentsResponse,
  type StarsPreCheckoutResponse,
  type StarsRefundResponse,
} from '@binarius/shared';
import {
  creditStarPayment,
  listStarPaymentsForPayer,
  readStarsBuyer,
  requestStarRefund,
  StarsCreditSource,
  type Db,
  type StarPaymentCredit,
  type StarPaymentRow,
} from '@binarius/db';
import { ADMIN_TEXTS } from '../admin/texts';
import { internalBearerAuth } from '../auth/internal';

export interface PaymentsRoutesDeps {
  db: Db;
  internalApiToken: string;
  // the staff bot's notice to every active staff member (AdminBot.notifyStaff); a fake in tests
  notifyStaff: (text: string) => Promise<void>;
}

// Buying tokens for Telegram Stars (#117, docs/stars.md): the three calls the bot makes around one
// payment, and /paysupport's two (#118). The invoice, the pre-checkout and the list only read; the
// credit is idempotent by Telegram's charge id, a refund request by its payment. Scoped by the
// Telegram id in the body, as the users routes. None of them reads DEMO_ONLY: a payment the user
// confirms in Telegram is not a broker operation (Rule 33).
export const paymentsRoutes: FastifyPluginAsync<PaymentsRoutesDeps> = async (
  app,
  { db, internalApiToken, notifyStaff },
) => {
  app.addHook('onRequest', internalBearerAuth(internalApiToken));

  // The payload of an invoice for one package. Every refusal comes before anything is written, so
  // the bot keeps the package screen and a press is the retry.
  app.post('/payments/stars/invoice', async (request, reply) => {
    const parsed = starsInvoiceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const buyer = await readStarsBuyer(db, BigInt(parsed.data.telegramUserId));
    if (buyer === undefined) return reply.code(404).send({ error: StarsErrorCode.UserNotFound });
    if (buyer.status === UserStatus.Blocked) {
      return reply.code(409).send({ error: StarsErrorCode.UserBlocked });
    }
    if (!buyer.hasActiveBrokerAccount) {
      return reply.code(409).send({ error: StarsErrorCode.NoActiveAccount });
    }
    const pack = starPackageOf(parsed.data.packageCode);
    if (pack === undefined) return reply.code(409).send({ error: StarsErrorCode.PackageUnknown });
    return reply.send({
      payload: starsInvoicePayload(pack.code, buyer.userId),
      package: { code: pack.code, tokens: pack.tokens.toString(), stars: pack.stars },
    });
  });

  // Telegram asks before it charges: a refusal here costs the user nothing. Never writes.
  app.post('/payments/stars/pre-checkout', async (request, reply) => {
    const parsed = starsPreCheckoutRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const refusal = await preCheckoutRefusal(db, parsed.data);
    if (refusal !== undefined) request.log.info({ reason: refusal }, 'stars pre-checkout refused');
    const answer: StarsPreCheckoutResponse =
      refusal === undefined ? { ok: true } : { ok: false, reason: refusal };
    return reply.send(answer);
  });

  // successful_payment, as the bot received it. The charge id is the key, so a repeated delivery
  // answers what the first one did.
  app.post('/payments/stars/paid', async (request, reply) => {
    const parsed = starsPaidRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const paid = parsed.data;
    const payload = parseStarsInvoicePayload(paid.invoicePayload);
    // no user to own a row: logged by the charge id only, for a staff member to look up
    if (payload === undefined) {
      request.log.error(
        { telegramPaymentChargeId: paid.telegramPaymentChargeId, totalAmount: paid.totalAmount },
        'stars payment with a payload that is not ours',
      );
      return reply.code(409).send({ error: StarsErrorCode.PayloadUnknown });
    }
    const credit = await db.transaction((tx) =>
      creditStarPayment(tx, {
        telegramPaymentChargeId: paid.telegramPaymentChargeId,
        providerPaymentChargeId: paid.providerPaymentChargeId,
        packageCode: payload.packageCode,
        userId: payload.userId,
        currency: paid.currency,
        totalAmount: paid.totalAmount,
        payerTelegramUserId: BigInt(paid.telegramUserId),
        paidAt: new Date(paid.paidAt * 1000),
        source: StarsCreditSource.Bot,
      }),
    );
    if (credit.outcome === 'user_unknown') {
      request.log.error(
        { telegramPaymentChargeId: paid.telegramPaymentChargeId, totalAmount: paid.totalAmount },
        'stars payment for a user with no row',
      );
      return reply.code(409).send({ error: StarsErrorCode.PayloadUnknown });
    }
    logCredit(request.log, credit);
    return reply.send(paidAnswer(credit));
  });

  // /paysupport (#118, docs/stars.md → /paysupport): the payer's newest payments. A read: the bot
  // may repeat it. A Telegram id with no users row is allowed — a forwarded invoice's payer may
  // have none — and gets the payments they made, by star_payments.payer_telegram_user_id.
  app.post('/payments/stars/list', async (request, reply) => {
    const parsed = starsPaymentsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const answer: StarsPaymentsResponse = {
      payments: await listStarPaymentsForPayer(db, BigInt(parsed.data.telegramUserId)),
    };
    return reply.send(answer);
  });

  // «Нужен возврат». One request per payment, by its payer only: another payer's id answers as a
  // missing one (Rule 13). The staff are told after the commit, and only by the press that
  // inserted; the reply does not wait for them, and a lost notice leaves the request listed by
  // `stars requests` and on the admin's «Возвраты Stars» (#510).
  app.post('/payments/stars/refund-request', async (request, reply) => {
    const parsed = starsRefundRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const result = await requestStarRefund(db, {
      telegramUserId: BigInt(parsed.data.telegramUserId),
      paymentId: parsed.data.paymentId,
    });
    switch (result.outcome) {
      case 'not_found':
        return reply.code(404).send({ error: StarsRefundErrorCode.PaymentNotFound });
      case 'already_refunded':
        return reply.code(409).send({ error: StarsRefundErrorCode.AlreadyRefunded });
      case 'already_requested': {
        const answer: StarsRefundResponse = { outcome: StarsRefundRequestOutcome.AlreadyRequested };
        return reply.send(answer);
      }
      case 'requested': {
        request.log.info({ starPaymentId: result.payment.id }, 'stars refund requested');
        void notifyStaff(refundNotice(result.payment)).catch((error: unknown) => {
          request.log.warn(
            { ...errorLogFields(error), starPaymentId: result.payment.id },
            'stars refund request: the staff were not told',
          );
        });
        const answer: StarsRefundResponse = { outcome: StarsRefundRequestOutcome.Requested };
        return reply.send(answer);
      }
    }
  });
};

export const refundNotice = (payment: StarPaymentRow): string =>
  ADMIN_TEXTS.refundRequested({
    chargeId: payment.telegramPaymentChargeId,
    packageCode: payment.packageCode,
    stars: payment.totalAmount,
    status: payment.status,
    payerTelegramUserId: payment.payerTelegramUserId.toString(),
  });

async function preCheckoutRefusal(
  db: Db,
  query: { telegramUserId: string; invoicePayload: string; currency: string; totalAmount: number },
): Promise<StarsPreCheckoutRefusal | undefined> {
  const payload = parseStarsInvoicePayload(query.invoicePayload);
  if (payload === undefined) return StarsPreCheckoutRefusal.Payload;
  const pack = starPackageOf(payload.packageCode);
  if (pack === undefined) return StarsPreCheckoutRefusal.Package;
  if (query.currency !== STARS_CURRENCY) return StarsPreCheckoutRefusal.Currency;
  if (query.totalAmount !== pack.stars) return StarsPreCheckoutRefusal.Amount;
  const buyer = await readStarsBuyer(db, BigInt(query.telegramUserId));
  if (buyer === undefined) return StarsPreCheckoutRefusal.UserNotFound;
  // a forwarded invoice: its Pay button works for whoever holds it
  if (buyer.userId !== payload.userId) return StarsPreCheckoutRefusal.Payer;
  if (buyer.status === UserStatus.Blocked) return StarsPreCheckoutRefusal.UserBlocked;
  if (!buyer.hasActiveBrokerAccount) return StarsPreCheckoutRefusal.NoActiveAccount;
  return undefined;
}

type RecordedCredit = Exclude<StarPaymentCredit, { outcome: 'user_unknown' }>;

// What the bot tells the user. A charge recorded before reads as its stored status: paid is
// «начислено», anything else goes to support.
export function paidAnswer(credit: RecordedCredit): StarsPaidResponse {
  switch (credit.outcome) {
    case 'credited':
      return {
        outcome: StarsCreditOutcome.Credited,
        tokens: credit.tokens.toString(),
        balance: credit.balance.toString(),
      };
    case 'already_recorded':
      return credit.status === StarPaymentStatus.Paid && credit.tokens !== null
        ? {
            outcome: StarsCreditOutcome.AlreadyCredited,
            tokens: credit.tokens.toString(),
            balance: credit.balance.toString(),
          }
        : { outcome: StarsCreditOutcome.Held };
    case 'held':
      return { outcome: StarsCreditOutcome.Held };
  }
}

// ids and the outcome only (Rule 8): no Telegram id, no payload
export function logCredit(
  log: { info(object: object, message: string): void; warn(object: object, message: string): void },
  credit: RecordedCredit,
): void {
  if (credit.outcome === 'held') {
    log.warn({ starPaymentId: credit.paymentId, reason: credit.reason }, 'stars payment held');
    return;
  }
  log.info({ starPaymentId: credit.paymentId, outcome: credit.outcome }, 'stars payment recorded');
}
