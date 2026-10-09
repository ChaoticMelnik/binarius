import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import * as z from 'zod';
import {
  TRADING_SESSIONS_PATH,
  TradeMode,
  TradingSessionErrorCode,
  TradingSessionStopReason,
  errorLogFields,
  isPairOpen,
  pairAcceptsDuration,
  pairPayoutAccepted,
  safeParseCreateTradingSessionRequest,
  safeParseReadTradingSessionQuery,
  safeParseStopTradingSessionRequest,
  sessionFitsDeadline,
  checkDemoStake,
  demoStakeSettings,
  tradingSessionSettingsSchema,
  type TradingSessionErrorCode as ErrorCode,
} from '@binarius/shared';
import {
  TradingSessionError,
  checkTradingSessionStart,
  createTradingSession,
  readActiveTradingSessionView,
  readBalanceSnapshot,
  readDemoStake,
  readTradingSessionView,
  stopTradingSession,
  touchBalanceRequested,
  type Db,
  type TradingSessionDbErrorCode,
} from '@binarius/db';
import type { PairsCatalog } from '@binarius/broker-rest';
import { internalBearerAuth } from '../auth/internal';
import { ACCESS_SKEW_MS } from '../auth/token-service';
import type { BalanceReconciler } from '../broker/balance-reconciler';
import { TRADING_ACCESS_REFRESH_BUDGET_MS } from '../timing';

export interface TradingSessionRoutesDeps {
  db: Db;
  catalog: Pick<PairsCatalog, 'read'>;
  balance: Pick<BalanceReconciler, 'refresh'>;
  internalApiToken: string;
  // the process runs DEMO_ONLY (#396): createTradingSession refuses a real session
  demoOnly: boolean;
  now?: () => number;
}

// a wire code added without a status fails the typecheck
const STATUS_OF = {
  user_not_found: 404,
  broker_account_not_found: 404,
  not_found: 404,
  ambiguous_broker_account: 409,
  account_not_confirmed: 409,
  account_revoked: 409,
  account_halted: 409,
  user_blocked: 409,
  insufficient_tokens: 409,
  trading_paused: 409,
  mode_not_allowed: 409,
  demo_only: 409,
  active_session_exists: 409,
  session_too_long: 409,
  balance_unavailable: 409,
  pair_unavailable: 409,
  payout_too_low: 409,
  session_not_active: 409,
  stake_precision: 409,
  stake_below_minimum: 409,
  insufficient_demo_balance: 409,
  catalog_unavailable: 503,
} as const satisfies Record<ErrorCode, 404 | 409 | 503>;

// createTradingSession's refusals under its locks; a db code added without a wire code fails the
// typecheck
const DB_CODE_TO_WIRE = {
  account_not_found: TradingSessionErrorCode.BrokerAccountNotFound,
  account_revoked: TradingSessionErrorCode.AccountRevoked,
  account_not_confirmed: TradingSessionErrorCode.AccountNotConfirmed,
  account_halted: TradingSessionErrorCode.AccountHalted,
  user_not_active: TradingSessionErrorCode.UserBlocked,
  active_session_exists: TradingSessionErrorCode.ActiveSessionExists,
  trading_paused: TradingSessionErrorCode.TradingPaused,
  mode_not_allowed: TradingSessionErrorCode.ModeNotAllowed,
  demo_only: TradingSessionErrorCode.DemoOnly,
} as const satisfies Record<TradingSessionDbErrorCode, ErrorCode>;

const idParamSchema = z.uuid();

const refuse = (reply: FastifyReply, code: Exclude<ErrorCode, 'active_session_exists'>) =>
  reply.code(STATUS_OF[code]).send({ error: code });

// Registered as an encapsulated plugin so the auth hook covers exactly these routes
// (docs/trading-session.md -> Routes). Every refusal of the start comes before
// createTradingSession, so a 4xx leaves no trading_sessions row; a balance refresh it ran on the
// way may have written the account's snapshot.
export const tradingSessionRoutes: FastifyPluginAsync<TradingSessionRoutesDeps> = async (
  app,
  { db, catalog, balance, internalApiToken, demoOnly, now = Date.now },
) => {
  app.addHook('onRequest', internalBearerAuth(internalApiToken));

  // the account's active session rides on the refusal, so a retry after a timeout that fired
  // past the commit learns what the first request created
  const activeSessionExists = async (
    reply: FastifyReply,
    brokerAccountId: string,
    telegramUserId: string,
  ) =>
    reply.code(STATUS_OF.active_session_exists).send({
      error: TradingSessionErrorCode.ActiveSessionExists,
      session: (await readActiveTradingSessionView(db, brokerAccountId, telegramUserId)) ?? null,
    });

  app.post(TRADING_SESSIONS_PATH, async (request, reply) => {
    const parsed = safeParseCreateTradingSessionRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const { telegramUserId, assetId, durationSec, trades } = parsed.data;
    if (!sessionFitsDeadline(trades, durationSec)) {
      return refuse(reply, TradingSessionErrorCode.SessionTooLong);
    }

    const eligible = await checkTradingSessionStart(db, {
      telegramUserId,
      ...(parsed.data.brokerAccountId === undefined
        ? {}
        : { brokerAccountId: parsed.data.brokerAccountId }),
    });
    if (!eligible.ok) {
      if (eligible.code === TradingSessionErrorCode.ActiveSessionExists) {
        return reply.code(STATUS_OF.active_session_exists).send({
          error: eligible.code,
          session:
            eligible.activeSessionId === undefined
              ? null
              : ((await readTradingSessionView(db, eligible.activeSessionId, telegramUserId)) ??
                null),
        });
      }
      return refuse(reply, eligible.code);
    }
    const { brokerAccountId } = eligible;

    const view = catalog.read();
    if (view === undefined || !view.fresh) {
      return refuse(reply, TradingSessionErrorCode.CatalogUnavailable);
    }
    const pair = view.pairs.find((candidate) => candidate.id === assetId);
    if (pair === undefined || !isPairOpen(pair, now()) || !pairAcceptsDuration(pair, durationSec)) {
      return refuse(reply, TradingSessionErrorCode.PairUnavailable);
    }
    // no cycle on a pair paying less than the floor (#379); single trades are not restricted
    if (!pairPayoutAccepted(pair)) {
      return refuse(reply, TradingSessionErrorCode.PayoutTooLow);
    }

    // keeps the account in work for the backend's reconcile tick and the worker's sessions;
    // a stored snapshot of any age serves: the sizer checks the balance before every trade
    await touchBalanceRequested(db, brokerAccountId);
    let snapshot = await readBalanceSnapshot(db, brokerAccountId);
    if (snapshot === undefined) {
      // the same comparison as POST /trading/access: an exchange would not fit the budget, so it
      // runs in the background and the caller retries
      if (eligible.accessTokenExpiresAt.getTime() <= Date.now() + ACCESS_SKEW_MS) {
        balance.refresh(brokerAccountId, { requested: true }).catch((error: unknown) => {
          request.log.error(
            { accountId: brokerAccountId, ...errorLogFields(error) },
            'balance refresh threw',
          );
        });
        return refuse(reply, TradingSessionErrorCode.BalanceUnavailable);
      }
      await balance.refresh(brokerAccountId, {
        signal: AbortSignal.timeout(TRADING_ACCESS_REFRESH_BUDGET_MS),
        requested: true,
      });
      snapshot = await readBalanceSnapshot(db, brokerAccountId);
      if (snapshot === undefined) return refuse(reply, TradingSessionErrorCode.BalanceUnavailable);
    }

    // the user's saved stake, or the broker's minimum without one (#297), checked against the
    // same snapshot before any row is written
    const demoStake = (await readDemoStake(db, BigInt(telegramUserId))) ?? null;
    const stakeRefusal = checkDemoStake(demoStake ?? snapshot.minTradeAmount, {
      minTradeAmount: snapshot.minTradeAmount,
      demoAvailable: snapshot.demo.available,
    });
    if (stakeRefusal !== null) return refuse(reply, stakeRefusal);

    // a stored min_trade_amount of 0 is valid and gives baseStake '0', which settings v1 refuse:
    // the snapshot offers no stake to trade with, the same answer as no snapshot
    const stakeSettings = tradingSessionSettingsSchema.safeParse({
      version: 1,
      assetId,
      durationSec,
      trades,
      stake: demoStakeSettings(demoStake, snapshot.minTradeAmount),
    });
    if (!stakeSettings.success) {
      request.log.warn({ accountId: brokerAccountId }, 'balance snapshot gives no session stake');
      return refuse(reply, TradingSessionErrorCode.BalanceUnavailable);
    }
    const settings = stakeSettings.data;

    let created;
    try {
      created = await createTradingSession(
        db,
        { telegramUserId, brokerAccountId, mode: TradeMode.Demo, settings },
        { demoOnly },
      );
    } catch (error) {
      if (!(error instanceof TradingSessionError)) throw error;
      const code = DB_CODE_TO_WIRE[error.code];
      if (code === TradingSessionErrorCode.ActiveSessionExists) {
        return activeSessionExists(reply, brokerAccountId, telegramUserId);
      }
      return refuse(reply, code);
    }
    const session = await readTradingSessionView(db, created.id, telegramUserId);
    return reply.code(201).send({ session });
  });

  app.get(`${TRADING_SESSIONS_PATH}/:id`, async (request, reply) => {
    const id = idParamSchema.safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return refuse(reply, TradingSessionErrorCode.NotFound);
    const query = safeParseReadTradingSessionQuery(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'validation', issues: query.error.issues });
    }
    // another user's id answers exactly as a missing one (Rule 13)
    const session = await readTradingSessionView(db, id.data, query.data.telegramUserId);
    if (session === undefined) return refuse(reply, TradingSessionErrorCode.NotFound);
    return reply.send({ session });
  });

  // Owner scope is the read; the CAS is by id. A session's account and the account's user never
  // change, so nothing between the two can make the CAS stop another user's session.
  app.post(`${TRADING_SESSIONS_PATH}/:id/stop`, async (request, reply) => {
    const id = idParamSchema.safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return refuse(reply, TradingSessionErrorCode.NotFound);
    const body = safeParseStopTradingSessionRequest(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'validation', issues: body.error.issues });
    }
    const { telegramUserId } = body.data;
    const owned = await readTradingSessionView(db, id.data, telegramUserId);
    if (owned === undefined) return refuse(reply, TradingSessionErrorCode.NotFound);
    const stopped = await stopTradingSession(db, {
      id: id.data,
      reason: TradingSessionStopReason.UserStopped,
    });
    if (stopped === undefined) return refuse(reply, TradingSessionErrorCode.SessionNotActive);
    return reply.send({ session: await readTradingSessionView(db, id.data, telegramUserId) });
  });
};
