import { Api, GrammyError } from 'grammy';
import { STARS_TELEGRAM_API_TIMEOUT_MS } from '../timing';

// Telegram's side of a Stars refund (#118, #510; docs/stars.md → Refunds): the one call and the one
// reading of its answer, shared by `stars refund` and POST /admin/star-payments/:id/refund.

// Telegram's word that the charge was refunded before (assumption 2 of docs/stars.md → Refunds:
// the MTProto error the Bot API passes through, not observed live). Case-sensitive, as Telegram
// writes its error names.
export const CHARGE_ALREADY_REFUNDED = 'CHARGE_ALREADY_REFUNDED';

export interface StarsRefundApi {
  // Bot API refundStarPayment: true, or an error classifyRefundAnswer reads
  refundStarPayment(
    userId: number,
    telegramPaymentChargeId: string,
    signal?: AbortSignal,
  ): Promise<true>;
}

// The public bot's: refundStarPayment is called by the bot that was paid. `apiRoot` is the tests'.
export const createStarsRefundApi = ({
  token,
  apiRoot,
}: {
  token: string;
  apiRoot?: string;
}): StarsRefundApi => {
  const api = new Api(token, {
    timeoutSeconds: STARS_TELEGRAM_API_TIMEOUT_MS / 1000,
    ...(apiRoot === undefined ? {} : { apiRoot }),
  });
  return {
    // grammY types the signal with its abort-controller shim; a native one is what its fetch
    // takes (as notifyStaff, admin/telegram.ts)
    refundStarPayment: (userId, chargeId, signal) =>
      api.refundStarPayment(
        userId,
        chargeId,
        signal as Parameters<typeof api.refundStarPayment>[2],
      ),
  };
};

// How the Telegram call ended, as the outcome table of docs/stars.md → Refunds reads it.
export type TelegramRefundOutcome =
  | { kind: 'refunded' }
  | { kind: 'already_refunded' }
  | { kind: 'refused'; errorCode: number; description: string }
  | { kind: 'unknown'; error: unknown };

// A GrammyError below 500 is Telegram's answer given before anything happened. A 5xx may follow a
// refund Telegram carried out (#626 п.3), and anything else — a timeout, a dropped connection, our
// own deadline — may have come after it: both are unknown.
export function classifyRefundAnswer(error: unknown): TelegramRefundOutcome {
  if (!(error instanceof GrammyError)) return { kind: 'unknown', error };
  if (error.error_code >= 500) return { kind: 'unknown', error };
  if (error.error_code === 400 && error.description.includes(CHARGE_ALREADY_REFUNDED)) {
    return { kind: 'already_refunded' };
  }
  return { kind: 'refused', errorCode: error.error_code, description: error.description };
}

export async function askRefund(
  api: StarsRefundApi,
  payer: bigint,
  chargeId: string,
  signal?: AbortSignal,
): Promise<TelegramRefundOutcome> {
  try {
    // Telegram ids are below 2^53 (telegramUserIdSchema bounds the wire)
    await api.refundStarPayment(Number(payer), chargeId, signal);
    return { kind: 'refunded' };
  } catch (error) {
    return classifyRefundAnswer(error);
  }
}
