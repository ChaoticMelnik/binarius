import { eq } from 'drizzle-orm';
import { BrokerRestError, type BrokerRestClient } from '@binarius/broker-rest';
import { BrokerRestErrorCode, TradeMode } from '@binarius/shared';
import {
  brokerAccounts,
  readHeldExposure,
  upsertBalanceSnapshot,
  type Db,
  type HeldExposure,
} from '@binarius/db';
import { isAccessTokenRefusal, type AccessTokenSource } from '../broker/access-token';
import type { Logger } from './processor';

// The broker balance check after a reconciliation outcome (#92, docs/trade-intent-transport.md →
// Balance check after an outcome): one GET /v1/broker/user, the snapshot written after the owner
// check, then per mode the broker's `held` against our open trades. Alert only: an `error` line,
// no halt, no write to an intent. No amount reaches a log line.

export type BalanceCheckEnding =
  'compared' | 'mismatch' | 'not_compared' | 'failed' | 'rate_limited' | 'aborted';

export interface BalanceCheck {
  check(brokerAccountId: string, signal: AbortSignal): Promise<BalanceCheckEnding>;
}

export interface BalanceCheckDeps {
  db: Db;
  rest: Pick<BrokerRestClient, 'getUser'>;
  tokens: AccessTokenSource;
  logger: Logger;
}

type SkipReason = 'intent_unresolved' | 'settlement_pending' | 'trades_changed';

const byMode = (rows: HeldExposure[], mode: TradeMode) => rows.find((row) => row.mode === mode)!;

const sameTrades = (before: HeldExposure, after: HeldExposure) =>
  before.intentCount === after.intentCount &&
  before.openTradeIds.length === after.openTradeIds.length &&
  before.openTradeIds.every((id, i) => id === after.openTradeIds[i]);

// Our trades and the broker's move independently of the GET, so the GET is bracketed by two
// reads, and a mode is compared only when nothing of ours moved between them: no intent of the
// mode in flight at either read, none created, no trade opened or settled, and no open trade at
// or past its expected close (the broker may already have settled it). A trade that opens and
// settles inside one GET (a 5 s trade, #313) has an intent before the first read or creates one
// after it, so it is caught by the same rules.
function skipReason(before: HeldExposure, after: HeldExposure): SkipReason | undefined {
  if (before.unresolvedIntent || after.unresolvedIntent) return 'intent_unresolved';
  if (after.settlementPending) return 'settlement_pending';
  if (!sameTrades(before, after)) return 'trades_changed';
  return undefined;
}

export function createBalanceCheck({ db, rest, tokens, logger }: BalanceCheckDeps): BalanceCheck {
  return {
    async check(brokerAccountId, signal) {
      if (signal.aborted) return 'aborted';
      const before = await readHeldExposure(db, { brokerAccountId });

      // a timer's question: the backend never exchanges a token for it (Rule 12)
      const token = await tokens.accessToken(brokerAccountId, { mayRefresh: false, signal });
      if (!token.ok) {
        logger.warn(
          {
            brokerAccountId,
            reason: 'token',
            ...(isAccessTokenRefusal(token.reason)
              ? { refusal: token.reason }
              : { failure: token.reason, status: token.status }),
          },
          'balance check failed',
        );
        return 'failed';
      }

      const [account] = await db
        .select({ brokerUserId: brokerAccounts.brokerUserId })
        .from(brokerAccounts)
        .where(eq(brokerAccounts.id, brokerAccountId));
      if (account === undefined) {
        logger.warn({ brokerAccountId, reason: 'account_not_found' }, 'balance check failed');
        return 'failed';
      }

      let user;
      try {
        user = await rest.getUser({ accessToken: token.accessToken }, { signal });
      } catch (error) {
        if (!(error instanceof BrokerRestError)) throw error;
        if (error.code === BrokerRestErrorCode.Aborted) return 'aborted';
        // detail is the broker's text and stays out
        logger.warn(
          {
            brokerAccountId,
            reason: 'broker',
            code: error.code,
            status: error.status,
            retryAfterSec: error.retryAfterSec,
          },
          'balance check failed',
        );
        return error.code === BrokerRestErrorCode.RateLimited ? 'rate_limited' : 'failed';
      }

      if (user.id !== account.brokerUserId) {
        logger.warn(
          { brokerAccountId, expected: account.brokerUserId, received: user.id },
          'broker answered for another user, balance not stored',
        );
        return 'failed';
      }
      const written = await upsertBalanceSnapshot(db, { brokerAccountId, user, requested: false });
      if (!written.written) {
        logger.warn(
          { brokerAccountId, field: written.field },
          'broker balance outside the stored domain',
        );
        return 'failed';
      }

      const after = await readHeldExposure(db, {
        brokerAccountId,
        held: { [TradeMode.Demo]: user.demo.held, [TradeMode.Real]: user.real.held },
      });
      let compared = false;
      let mismatch = false;
      for (const mode of Object.values(TradeMode)) {
        const now = byMode(after, mode);
        const reason = skipReason(byMode(before, mode), now);
        if (reason !== undefined) {
          logger.info({ brokerAccountId, mode, reason }, 'balance check not compared');
          continue;
        }
        compared = true;
        if (now.heldExceedsOpen === true) {
          mismatch = true;
          logger.error(
            { brokerAccountId, mode, direction: 'broker_holds_more' },
            'broker balance mismatch',
          );
        }
      }
      if (mismatch) return 'mismatch';
      return compared ? 'compared' : 'not_compared';
    },
  };
}
