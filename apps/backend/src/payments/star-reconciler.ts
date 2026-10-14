import type { FastifyBaseLogger } from 'fastify';
import { InlineKeyboard } from 'grammy';
import type { StarTransaction } from 'grammy/types';
import {
  errorLogFields,
  MENU_CALLBACK_DATA,
  parseStarsInvoicePayload,
  STARS_CURRENCY,
} from '@binarius/shared';
import { creditStarPayment, listKnownStarCharges, StarsCreditSource, type Db } from '@binarius/db';
import type { ClientPush, ClientPushMessage } from '../auth/client-push';
import { CLIENT_LABELS, CLIENT_TEXTS } from '../auth/texts';
import { telegramErrorFields } from '../telegram-logging';
import {
  STARS_RECONCILE_MAX_PAGES,
  STARS_RECONCILE_PAGE_SIZE,
  STARS_RECONCILE_TICK_MS,
  STARS_RECONCILE_WINDOW_S,
} from '../timing';
import { recordTelegramSendFailure } from '../users/telegram-delivery';
import { logCredit } from './routes';

// docs/stars.md → Reconciliation. The only protection against a paid purchase whose
// successful_payment the backend never received: the bot polls, and grammY confirms an update's
// offset even when its handler failed, so Telegram never sends it again. Every tick reads the bot's
// Star transactions from offset 0 and credits each of ours that star_payments does not hold,
// through the same creditStarPayment the bot's route calls, so a race with the bot credits once.

export interface StarReconcilerConfig {
  tickMs: number;
  pageSize: number;
  maxPages: number;
  windowS: number;
}

const DEFAULT_STAR_RECONCILER_CONFIG: StarReconcilerConfig = {
  tickMs: STARS_RECONCILE_TICK_MS,
  pageSize: STARS_RECONCILE_PAGE_SIZE,
  maxPages: STARS_RECONCILE_MAX_PAGES,
  windowS: STARS_RECONCILE_WINDOW_S,
};

export interface StarReconcilerDeps {
  db: Db;
  // getStarTransactions on the public bot's token; throws as grammY does
  readTransactions: (offset: number, limit: number) => Promise<StarTransaction[]>;
  push: Pick<ClientPush, 'sendMailing'>;
  logger: FastifyBaseLogger;
  config?: Partial<StarReconcilerConfig>;
  // the wall clock the window is measured on: Telegram's `date` is wall-clock Unix time
  now?: () => number;
}

export interface StarReconciler {
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

// An incoming payment by a user for one of the bot's invoices: the only transactions that can be
// a purchase. Refunds (outgoing), paid media, gifts and the rest are not.
interface InvoicePayment {
  id: string;
  amount: number;
  date: number;
  payerTelegramUserId: number;
  invoicePayload: string;
}

function invoicePaymentOf(transaction: StarTransaction): InvoicePayment | undefined {
  const source = transaction.source;
  if (source?.type !== 'user' || source.transaction_type !== 'invoice_payment') return undefined;
  return {
    id: transaction.id,
    amount: transaction.amount,
    date: transaction.date,
    payerTelegramUserId: source.user.id,
    invoicePayload: source.invoice_payload ?? '',
  };
}

// What a credit made here tells the user (answer 3 of the clarify round): the bot's own answer to
// successful_payment never came, so nothing else says the tokens arrived.
export const starsCreditedPush = (tokens: bigint, balance: bigint): ClientPushMessage => ({
  text: CLIENT_TEXTS.starsCredited({
    purchasedTokens: tokens.toString(),
    tokenBalance: balance.toString(),
  }),
  reply_markup: new InlineKeyboard().text(CLIENT_LABELS.menuButton, MENU_CALLBACK_DATA),
});

export function createStarReconciler(deps: StarReconcilerDeps): StarReconciler {
  const { db, readTransactions, push, logger } = deps;
  const config = { ...DEFAULT_STAR_RECONCILER_CONFIG, ...deps.config };
  const now = deps.now ?? Date.now;
  let stopped = false;
  let ticking: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  // a charge that cannot be matched is said once per process, not on every tick
  const reported = new Set<string>();

  function reportOnce(payment: InvoicePayment, message: string): void {
    if (reported.has(payment.id)) return;
    reported.add(payment.id);
    logger.error({ telegramPaymentChargeId: payment.id, totalAmount: payment.amount }, message);
  }

  // A failed send is logged and not repeated: the tokens are already there.
  async function pushCredit(telegramUserId: bigint, tokens: bigint, balance: bigint) {
    try {
      await push.sendMailing(telegramUserId, starsCreditedPush(tokens, balance));
    } catch (error) {
      logger.warn(
        { ...errorLogFields(error), ...telegramErrorFields(error, 'sendMessage') },
        'stars credit push not delivered',
      );
      await recordTelegramSendFailure({ db, log: logger }, telegramUserId, error);
    }
  }

  async function settle(payment: InvoicePayment): Promise<void> {
    const parsed = parseStarsInvoicePayload(payment.invoicePayload);
    if (parsed === undefined) {
      reportOnce(payment, 'stars transaction with a payload that is not ours');
      return;
    }
    const payer = BigInt(payment.payerTelegramUserId);
    const credit = await db.transaction((tx) =>
      creditStarPayment(tx, {
        telegramPaymentChargeId: payment.id,
        providerPaymentChargeId: null,
        packageCode: parsed.packageCode,
        userId: parsed.userId,
        currency: STARS_CURRENCY,
        totalAmount: payment.amount,
        payerTelegramUserId: payer,
        paidAt: new Date(payment.date * 1000),
        source: StarsCreditSource.Reconciler,
      }),
    );
    if (credit.outcome === 'user_unknown') {
      reportOnce(payment, 'stars transaction for a user with no row');
      return;
    }
    logCredit(logger, credit);
    if (credit.outcome === 'credited') await pushCredit(payer, credit.tokens, credit.balance);
  }

  async function runTick(): Promise<void> {
    const oldest = Math.floor(now() / 1000) - config.windowS;
    let credited = 0;
    for (let page = 0; page < config.maxPages; page += 1) {
      if (stopped) return;
      const transactions = await readTransactions(page * config.pageSize, config.pageSize);
      const payments = transactions
        .map(invoicePaymentOf)
        .filter((payment): payment is InvoicePayment => payment !== undefined)
        .filter((payment) => payment.date >= oldest);
      const known = await listKnownStarCharges(
        db,
        payments.map((payment) => payment.id),
      );
      for (const payment of payments) {
        if (stopped) return;
        if (known.has(payment.id)) continue;
        await settle(payment);
        credited += 1;
      }
      if (transactions.length < config.pageSize) {
        if (credited > 0) logger.info({ settled: credited }, 'stars reconcile tick');
        return;
      }
    }
    logger.error({ pages: config.maxPages }, 'stars reconcile page ceiling');
  }

  // a tick longer than its interval makes the next one a no-op
  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    ticking ??= runTick()
      .catch((error: unknown) =>
        logger.error(
          { ...errorLogFields(error), ...telegramErrorFields(error, 'getStarTransactions') },
          'stars reconcile tick failed',
        ),
      )
      .finally(() => {
        ticking = undefined;
      });
    return ticking;
  }

  return {
    tick,
    start() {
      if (stopped || timer !== undefined) return;
      timer = setInterval(() => void tick(), config.tickMs);
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      await ticking;
    },
  };
}
