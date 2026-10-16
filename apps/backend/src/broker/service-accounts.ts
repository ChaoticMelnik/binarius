import type { FastifyBaseLogger } from 'fastify';
import { AccessTokenRefusal, assertExhausted, errorLogFields } from '@binarius/shared';
import { listServiceAccountStates, listServiceRenewalCandidates, type Db } from '@binarius/db';
import { ADMIN_TEXTS } from '../admin/texts';
import type { AccessTokenOptions, AccessTokenResult } from '../auth/token-service';

// The service-account keeper (#391, docs/service-accounts.md → The keeper). Each tick renews the
// service tokens that are due, then counts the working service accounts against the minimum and
// tells the staff bot when that count changes below it, and once when it recovers.
//
// This is the one timer that exchanges a token (Rule 12's exception): it asks only with
// serviceOnly, and the token service refuses any row whose mark is gone under the row lock.

export interface ServiceAccountKeeperConfig {
  tickMs: number;
  renewAheadMs: number;
  rotationGapMs: number;
  perTick: number;
  stalledRetryMs: number;
  minWorking: number;
}

export interface ServiceAccountKeeperDeps {
  db: Db;
  accessToken: (accountId: string, options: AccessTokenOptions) => Promise<AccessTokenResult>;
  // AdminBot.notifyStaff: one plain message to every active staff member
  notifyStaff: (text: string, signal: AbortSignal) => Promise<{ sent: number; failed: number }>;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  config: ServiceAccountKeeperConfig;
}

export interface ServiceAccountKeeper {
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

// the broker email, or the broker's user id when there is none (a blank address is none)
const labelOf = ({ email, brokerUserId }: { email: string | null; brokerUserId: string }) => {
  const address = email?.trim() ?? '';
  return address === '' ? brokerUserId : address;
};

interface Reported {
  below: boolean;
  working: number;
}

export function createServiceAccountKeeper(deps: ServiceAccountKeeperDeps): ServiceAccountKeeper {
  const { db, accessToken, notifyStaff, logger, config } = deps;
  const stopping = new AbortController();
  // account id → when it may be tried again
  const held = new Map<string, number>();
  // what the staff last heard, or nothing yet in this process (a start below the minimum says so)
  let last: Reported | undefined;
  let stopped = false;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const holdBack = (accountId: string) => held.set(accountId, Date.now() + config.stalledRetryMs);

  async function renew(): Promise<{ candidates: number; renewed: number; refused: number }> {
    const now = Date.now();
    for (const [accountId, retryAt] of held) {
      if (retryAt <= now) held.delete(accountId);
    }
    const candidates = await listServiceRenewalCandidates(db, {
      renewAheadMs: config.renewAheadMs,
      rotationGapMs: config.rotationGapMs,
      limit: config.perTick,
      exclude: [...held.keys()],
    });
    let renewed = 0;
    let refused = 0;
    for (const accountId of candidates) {
      if (stopped) break;
      let result: AccessTokenResult;
      try {
        result = await accessToken(accountId, {
          mayRefresh: true,
          serviceOnly: true,
          renewAheadMs: config.renewAheadMs,
        });
      } catch (error) {
        // a database error carries the statement and the row's values: name and code only
        logger.error({ accountId, ...errorLogFields(error) }, 'service token renewal threw');
        holdBack(accountId);
        continue;
      }
      if (result.ok) {
        renewed += 1;
        continue;
      }
      switch (result.reason) {
        // the pair is intact and the limit is per address: the next candidate would get it too
        case AccessTokenRefusal.RefreshRateLimited:
          return { candidates: candidates.length, renewed, refused };
        // the exchange failed and the token service revoked the row; the count below sees it
        case AccessTokenRefusal.AccountRevoked:
          refused += 1;
          logger.warn(
            { accountId, revokedReason: result.revokedReason },
            'service account revoked by its renewal',
          );
          break;
        // the row left the candidate set by itself (unmarked, blocked, unconfirmed or gone)
        case AccessTokenRefusal.NotService:
        case AccessTokenRefusal.UserBlocked:
        case AccessTokenRefusal.AccountPending:
        case AccessTokenRefusal.AccountNotFound:
          logger.info({ accountId, reason: result.reason }, 'service token renewal skipped');
          break;
        // nothing changed on the row, so it would head the queue again: held back. refresh_needed
        // is unreachable with mayRefresh: true
        case AccessTokenRefusal.KeyUnavailable:
        case AccessTokenRefusal.RefreshNeeded:
          holdBack(accountId);
          break;
        default:
          return assertExhausted(result, 'access token refusal');
      }
    }
    return { candidates: candidates.length, renewed, refused };
  }

  async function report(): Promise<{
    marked: number;
    working: number;
    below: boolean;
    alerted: boolean;
  }> {
    const states = await listServiceAccountStates(db);
    const working = states.filter((state) => state.working).length;
    const below = working < config.minWorking;
    const marked = states.length;
    let text: string | undefined;
    if (below && (last === undefined || !last.below || last.working !== working)) {
      text = ADMIN_TEXTS.serviceAccountsBelow({
        working,
        marked,
        min: config.minWorking,
        notWorking: states.flatMap((state) =>
          state.notWorkingReason === null
            ? []
            : [
                {
                  label: labelOf(state),
                  reason: state.notWorkingReason,
                  revokedReason: state.authRevokedReason,
                },
              ],
        ),
      });
    } else if (!below && last?.below === true) {
      text = ADMIN_TEXTS.serviceAccountsRestored({ working, min: config.minWorking });
    }
    if (text === undefined) {
      last = { below, working };
      return { marked, working, below, alerted: false };
    }
    const { sent, failed } = await notifyStaff(text, stopping.signal);
    logger.info(
      { kind: below ? 'below' : 'restored', working, marked, sent, failed },
      'service accounts alert',
    );
    if (sent === 0 && failed === 0) {
      // nobody to tell (or stopping): remembered, so the next tick does not try again
      if (!stopping.signal.aborted) logger.warn({ working, marked }, 'no active staff to alert');
      last = { below, working };
    } else if (sent > 0) {
      last = { below, working };
    }
    // every send failed: `last` stays, so the next tick tries again
    return { marked, working, below, alerted: sent > 0 };
  }

  async function runTick(): Promise<void> {
    const renewals = await renew();
    if (stopped) return;
    const counted = await report();
    logger.info(
      {
        marked: counted.marked,
        working: counted.working,
        min: config.minWorking,
        candidates: renewals.candidates,
        renewed: renewals.renewed,
        refused: renewals.refused,
        held: held.size,
        below: counted.below,
        alerted: counted.alerted,
      },
      'service accounts tick',
    );
  }

  // a tick longer than the interval makes the next one a no-op
  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    running ??= runTick()
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'service accounts tick failed');
      })
      .finally(() => {
        running = undefined;
      });
    return running;
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
      stopping.abort();
      await running;
    },
  };
}
