import { BrokerRestError, MAX_DETAIL_LENGTH, type BrokerRestClient } from '@binarius/broker-rest';
import type { TradeIntentRow } from '@binarius/db';
import {
  BrokerRestErrorCode,
  decimalStringSchema,
  normalizeDecimal,
  TradeIntentFailureReason,
  TradeMode,
  TradeTransport,
  type OpenTrade,
  type SocketOpenTradeRequest,
} from '@binarius/shared';
import { reportRefusedToken, type AccessTokenSource } from '../broker/access-token';
import type { TradeSessionSource } from '../broker/trade-session';
import type { SubmitResult, TradeExecutor } from './executor';
import type { Logger } from './processor';

export interface TradeCommandExecutorDeps {
  sessions: TradeSessionSource;
  rest: Pick<BrokerRestClient, 'openTrade'>;
  tokens: AccessTokenSource;
  logger: Logger;
}

const UNKNOWN: SubmitResult = {
  outcome: 'unknown',
  reason: TradeIntentFailureReason.BrokerUnavailable,
};

// The two-cases rule (docs/trade-executor.md): the order goes out over the socket when the
// account's session is ready, and over REST only when nothing was emitted. After an emit the
// answer is the socket's or unknown; the order is never sent twice and never retried.
export function createTradeCommandExecutor(deps: TradeCommandExecutorDeps): TradeExecutor {
  const { sessions, rest, tokens, logger } = deps;

  function accepted(intent: TradeIntentRow, transport: TradeTransport, trade: OpenTrade) {
    logger.info(
      { intentId: intent.id, transport, brokerTradeId: trade.id },
      'trade command accepted',
    );
    return { outcome: 'accepted', transport, trade } satisfies SubmitResult;
  }

  async function overRest(
    intent: TradeIntentRow,
    request: SocketOpenTradeRequest,
    signal: AbortSignal,
  ): Promise<SubmitResult> {
    const transport = TradeTransport.RestFallback;
    const token = await tokens.accessToken(intent.brokerAccountId, { signal });
    if (!token.ok) {
      logger.warn(
        {
          intentId: intent.id,
          transport,
          stage: 'token',
          reason: token.reason,
          status: token.status,
        },
        'trade command refused',
      );
      return { outcome: 'rejected', reason: TradeIntentFailureReason.BrokerRejected };
    }
    try {
      const trade = await rest.openTrade(
        { accessToken: token.accessToken },
        { ...request, isDemo: intent.mode === TradeMode.Demo },
        { signal },
      );
      return accepted(intent, transport, trade);
    } catch (thrown) {
      if (!(thrown instanceof BrokerRestError)) throw thrown;
      const { code, status } = thrown;
      switch (code) {
        // refused before acting (docs/broker-rest.md -> Errors): the order did not open
        case BrokerRestErrorCode.Unauthorized:
        case BrokerRestErrorCode.RateLimited:
        case BrokerRestErrorCode.Rejected:
          logger.warn(
            {
              intentId: intent.id,
              transport,
              stage: 'rest',
              code,
              status,
              retryAfterSec: thrown.retryAfterSec,
              detail: thrown.detail,
            },
            'trade command refused',
          );
          // mayRefresh stays the default: a trade is the user's action, so the backend may
          // exchange here (#281). Not awaited: the processor races the submit against its
          // deadline, and an exchange outlasting it would turn this sure rejection into unknown.
          // Bounded by the source's own budget; shutdown does not wait for it.
          if (code === BrokerRestErrorCode.Unauthorized) {
            void reportRefusedToken(
              tokens,
              logger,
              { intentId: intent.id, brokerAccountId: intent.brokerAccountId },
              token.accessToken,
              { signal },
            );
          }
          return {
            outcome: 'rejected',
            reason: TradeIntentFailureReason.BrokerRejected,
            ...(thrown.detail === undefined ? {} : { detail: thrown.detail }),
          };
        // the POST may have opened the trade
        case BrokerRestErrorCode.Unavailable:
        case BrokerRestErrorCode.ContractViolation:
        case BrokerRestErrorCode.Aborted:
          logger.warn(
            { intentId: intent.id, transport, stage: 'rest', code, status },
            'trade command outcome unknown',
          );
          return UNKNOWN;
      }
    }
  }

  return {
    async submit(intent, signal) {
      const request: SocketOpenTradeRequest = {
        assetId: intent.assetId,
        action: intent.action,
        durationSec: intent.durationSec,
        // numeric(20,8) reads back as '10.00000000'; the live broker took "1.5", and the fixture
        // refuses more than two fraction digits
        amount: decimalStringSchema.parse(normalizeDecimal(intent.amount)),
      };
      const session = sessions.sessionFor(intent.brokerAccountId);
      if (session === undefined) {
        logger.info(
          { intentId: intent.id, sessionState: 'none' },
          'trade command falls back to rest',
        );
        return overRest(intent, request, signal);
      }
      const transport = TradeTransport.Socket;
      const result = await session.openTrade(intent.mode, request, signal);
      switch (result.outcome) {
        case 'success':
          return accepted(intent, transport, result.trade);
        case 'fail': {
          const detail = result.failures
            .map((failure) => failure.message)
            .join('; ')
            .slice(0, MAX_DETAIL_LENGTH);
          logger.warn(
            { intentId: intent.id, transport, failures: result.failures.length, detail },
            'trade command refused',
          );
          return { outcome: 'rejected', reason: TradeIntentFailureReason.BrokerRejected, detail };
        }
        case 'not_sent':
          if (result.reason === 'not_ready') {
            logger.info(
              { intentId: intent.id, sessionState: result.state },
              'trade command falls back to rest',
            );
            return overRest(intent, request, signal);
          }
          break;
        case 'unknown':
          break;
      }
      // emitted with no answer, or the processor's deadline already passed: its own outcome
      // has been written and this one is dropped
      logger.warn(
        { intentId: intent.id, transport, reason: result.reason, sessionState: result.state },
        'trade command outcome unknown',
      );
      return UNKNOWN;
    },
  };
}
