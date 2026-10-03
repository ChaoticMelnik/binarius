import type { FastifyBaseLogger } from 'fastify';
import { GrammyError } from 'grammy';
import { errorLogFields } from '@binarius/shared';
import { markTelegramBlocked, type Db } from '@binarius/db';

// Any 403 from Telegram on a send means nothing can be delivered to this user: they blocked the
// bot, deleted their account, or never started it. All three are marked alike — the mark clears
// on their next /start or /settings (the /users/start upsert) or unblock. `description` is neither
// compared nor logged (rule 8).
export function isTelegramForbidden(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 403;
}

// The one place a sender hands a failed send to (rule 19). A 403 marks the user as unreachable
// and cancels their pending notification jobs; any other failure is the sender's to log and
// changes nothing here. It never throws: the caller's own outcome must not depend on whether
// this bookkeeping could be written. Resolves true when a users row was marked.
export async function recordTelegramSendFailure(
  { db, log }: { db: Db; log: FastifyBaseLogger },
  telegramUserId: bigint,
  error: unknown,
): Promise<boolean> {
  if (!isTelegramForbidden(error)) return false;
  try {
    const marked = await markTelegramBlocked(db, telegramUserId);
    log.info(
      { recorded: marked !== undefined, canceledJobs: marked?.canceledJobs ?? 0 },
      'Telegram refused a send with 403; the user is marked unreachable',
    );
    return marked !== undefined;
  } catch (failure) {
    log.error({ ...errorLogFields(failure) }, 'the Telegram block could not be recorded');
    return false;
  }
}
