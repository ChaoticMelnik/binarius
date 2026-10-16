import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import * as z from 'zod';
import {
  SESSION_STATUS_MESSAGE_LOST_SUFFIX,
  SESSION_STATUS_MESSAGE_SUFFIX,
  SESSION_SUMMARY_SUFFIX,
  SessionSummaryErrorCode,
  TRADING_SESSIONS_PATH,
  TRADING_SESSIONS_STOP_PATH,
  TRADING_SESSIONS_TRACKED_PATH,
  TradeMode,
  TradingSessionErrorCode,
  TradingSessionStopReason,
  buildSessionSettings,
  errorLogFields,
  intervalForDuration,
  isPairOpen,
  pairAcceptsDuration,
  pairPayoutAccepted,
  safeParseCreateTradingSessionRequest,
  safeParseForgetSessionStatusMessageRequest,
  safeParseReadTradingSessionQuery,
  safeParseRecordSessionStatusMessageRequest,
  safeParseStopTradingSessionRequest,
  safeParseTrackedSessionsQuery,
  sessionFitsDeadline,
  SignalFeedOutcome,
  SignalKind,
  checkStake,
  stakeSettingsFrom,
  type SessionStakeStrategy,
  type TradingSessionErrorCode as ErrorCode,
} from '@binarius/shared';
import {
  TradingSessionError,
  checkTradingSessionStart,
  claimSessionSummary,
  createTradingSession,
  forgetSessionStatusMessage,
  listTrackedSessions,
  readActiveTradingSessionView,
  readBalanceSnapshot,
  readStakes,
  readTradingSessionView,
  recordSessionStatusMessage,
  stopTradingSession,
  stopUserSessions,
  touchBalanceRequested,
  type Db,
  type TradingSessionDbErrorCode,
} from '@binarius/db';
import type { PairsCatalog } from '@binarius/broker-rest';
import type { CachedSignalFeed } from '@binarius/signal';
import { internalBearerAuth } from '../auth/internal';
import { ACCESS_SKEW_MS } from '../auth/token-service';
import type { BalanceReconciler } from '../broker/balance-reconciler';
import { TRADING_ACCESS_REFRESH_BUDGET_MS } from '../timing';
import { readFinishedSessionView } from './session-view';

export interface TradingSessionRoutesDeps {
  db: Db;
  catalog: Pick<PairsCatalog, 'read'>;
  balance: Pick<BalanceReconciler, 'refresh'>;
  // the analysis's cached feed (#509): a start right after the analysis, in the same candle, asks
  // the broker nothing
  signals: Pick<CachedSignalFeed, 'evaluate'>;
  internalApiToken: string;
  // the process runs DEMO_ONLY (#396): createTradingSession refuses a real session
  demoOnly: boolean;
  // SESSION_STAKE_STRATEGY (#450): frozen into the new session's settings, never read again
  stakeStrategy: SessionStakeStrategy;
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
  insufficient_balance: 409,
  no_signal: 409,
  catalog_unavailable: 503,
  signal_unavailable: 503,
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
  { db, catalog, balance, signals, internalApiToken, demoOnly, stakeStrategy, now = Date.now },
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

  // the status the bot prints as final carries the balance after the last trade (#337); a thrown
  // refresh reaches the opaque 500, as in /trading/access
  const viewForReply = (id: string, telegramUserId: string) =>
    readFinishedSessionView({ db, balance }, id, telegramUserId);

  app.post(TRADING_SESSIONS_PATH, async (request, reply) => {
    const parsed = safeParseCreateTradingSessionRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const { telegramUserId, mode, assetId, durationSec, trades } = parsed.data;
    if (!sessionFitsDeadline(trades, durationSec)) {
      return refuse(reply, TradingSessionErrorCode.SessionTooLong);
    }

    const eligible = await checkTradingSessionStart(db, {
      telegramUserId,
      mode,
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

    // The pair's signal on the current candle (#509): no session starts on a pair without one. A
    // broker failure or a throw is a refusal too, never a start on a signal nobody read.
    const readSignal = async (): Promise<
      | typeof TradingSessionErrorCode.NoSignal
      | typeof TradingSessionErrorCode.SignalUnavailable
      | null
    > => {
      try {
        const evaluation = await signals.evaluate({
          assetId,
          interval: intervalForDuration(durationSec),
          digits: pair.digits,
        });
        if (evaluation.outcome === SignalFeedOutcome.FetchFailed) {
          return TradingSessionErrorCode.SignalUnavailable;
        }
        return evaluation.entry.decision.kind === SignalKind.Signal
          ? null
          : TradingSessionErrorCode.NoSignal;
      } catch (error) {
        request.log.error({ assetId, ...errorLogFields(error) }, 'session start signal threw');
        return TradingSessionErrorCode.SignalUnavailable;
      }
    };
    // keeps the account in work for the backend's reconcile tick and the worker's sessions;
    // a stored snapshot of any age serves: the sizer checks the balance before every trade
    const readSnapshot = async () => {
      await touchBalanceRequested(db, brokerAccountId);
      const stored = await readBalanceSnapshot(db, brokerAccountId);
      if (stored !== undefined) return stored;
      // the same comparison as POST /trading/access: an exchange would not fit the budget, so it
      // runs in the background and the caller retries
      if (eligible.accessTokenExpiresAt.getTime() <= Date.now() + ACCESS_SKEW_MS) {
        balance.refresh(brokerAccountId, { requested: true }).catch((error: unknown) => {
          request.log.error(
            { accountId: brokerAccountId, ...errorLogFields(error) },
            'balance refresh threw',
          );
        });
        return undefined;
      }
      await balance.refresh(brokerAccountId, {
        signal: AbortSignal.timeout(TRADING_ACCESS_REFRESH_BUDGET_MS),
        requested: true,
      });
      return readBalanceSnapshot(db, brokerAccountId);
    };
    // in parallel, so the start's budget holds the longer of the two, not their sum; the signal's
    // refusal answers first
    const [signalRefusal, snapshot] = await Promise.all([readSignal(), readSnapshot()]);
    if (signalRefusal !== null) return refuse(reply, signalRefusal);
    if (snapshot === undefined) return refuse(reply, TradingSessionErrorCode.BalanceUnavailable);

    // the user's saved stake of the session's mode, or the broker's minimum without one (#297,
    // #327), checked against that mode's balance of the same snapshot before any row is written
    const stakes = await readStakes(db, BigInt(telegramUserId));
    const savedStake = (mode === TradeMode.Real ? stakes?.realStake : stakes?.demoStake) ?? null;
    const available = mode === TradeMode.Real ? snapshot.real.available : snapshot.demo.available;
    const stakeRefusal = checkStake(savedStake ?? snapshot.minTradeAmount, {
      minTradeAmount: snapshot.minTradeAmount,
      available,
    });
    if (stakeRefusal !== null) return refuse(reply, stakeRefusal);

    // a stored min_trade_amount of 0 is valid and gives baseStake '0', which the settings refuse:
    // the snapshot offers no stake to trade with, the same answer as no snapshot; so does a stake
    // whose martingale limits would leave numeric(20,8) (#450)
    const stakeSettings = buildSessionSettings({
      assetId,
      durationSec,
      trades,
      stake: stakeSettingsFrom(savedStake, snapshot.minTradeAmount),
      strategy: stakeStrategy,
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
        { telegramUserId, brokerAccountId, mode, settings },
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

  // The bot's recovery list (#567, docs/bot-session.md → Recovery after a restart): not scoped by
  // a user (Rule 13), each row names its owner's chat. A static path, so find-my-way picks it
  // before /:id whatever the registration order.
  app.get(TRADING_SESSIONS_TRACKED_PATH, async (request, reply) => {
    const query = safeParseTrackedSessionsQuery(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'validation', issues: query.error.issues });
    }
    const rows = await listTrackedSessions(db, { limit: query.data.limit });
    return reply.send({
      sessions: rows.map(({ id, telegramUserId, messageId, assetId, startedAt }) => ({
        id,
        telegramUserId,
        messageId,
        assetId,
        startedAt: startedAt.toISOString(),
      })),
    });
  });

  app.get(`${TRADING_SESSIONS_PATH}/:id`, async (request, reply) => {
    const id = idParamSchema.safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return refuse(reply, TradingSessionErrorCode.NotFound);
    const query = safeParseReadTradingSessionQuery(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'validation', issues: query.error.issues });
    }
    // another user's id answers exactly as a missing one (Rule 13)
    const session = await viewForReply(id.data, query.data.telegramUserId);
    if (session === undefined) return refuse(reply, TradingSessionErrorCode.NotFound);
    return reply.send({ session });
  });

  // The bot's first poll of a status message (#567): records its id, the first one recorded wins,
  // unless the body names it as the message this one replaces, and answers the view GET /trading/sessions/:id gives. The owner is in the CAS and in the read,
  // so another user's id writes nothing and answers as a missing one (Rule 13).
  const statusMessagePath = `${TRADING_SESSIONS_PATH}/:id${SESSION_STATUS_MESSAGE_SUFFIX}`;
  app.post(statusMessagePath, async (request, reply) => {
    const id = idParamSchema.safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return refuse(reply, TradingSessionErrorCode.NotFound);
    const body = safeParseRecordSessionStatusMessageRequest(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'validation', issues: body.error.issues });
    }
    const { telegramUserId, messageId, replacesMessageId } = body.data;
    await recordSessionStatusMessage(db, {
      id: id.data,
      telegramUserId,
      messageId,
      replacesMessageId,
    });
    const session = await viewForReply(id.data, telegramUserId);
    if (session === undefined) return refuse(reply, TradingSessionErrorCode.NotFound);
    return reply.send({ session });
  });

  // The bot's report of a lost status message (#567): Telegram refused its edit for good, so the
  // row forgets it and leaves the recovery list. The owner and the message id are in the CAS, so
  // another user's id, a missing session and another message all answer forgotten: false and
  // write nothing (Rule 13).
  const lostMessagePath = `${TRADING_SESSIONS_PATH}/:id${SESSION_STATUS_MESSAGE_LOST_SUFFIX}`;
  app.post(lostMessagePath, async (request, reply) => {
    const id = idParamSchema.safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return refuse(reply, TradingSessionErrorCode.NotFound);
    const body = safeParseForgetSessionStatusMessageRequest(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'validation', issues: body.error.issues });
    }
    const { telegramUserId, messageId } = body.data;
    const forgotten = await forgetSessionStatusMessage(db, {
      id: id.data,
      telegramUserId,
      messageId,
    });
    return reply.send({ forgotten });
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
    return reply.send({ session: await viewForReply(id.data, telegramUserId) });
  });

  // The finished session's card, at most once (#318). Every refusal is one 409: not the owner's
  // or missing (Rule 13), not stopped, a trade still able to move, no settled trade, or sent
  // already; the bot draws nothing for any of them. A non-uuid id is a missing one.
  app.post(`${TRADING_SESSIONS_PATH}/:id${SESSION_SUMMARY_SUFFIX}`, async (request, reply) => {
    const unavailable = () => reply.code(409).send({ error: SessionSummaryErrorCode.Unavailable });
    const id = idParamSchema.safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return unavailable();
    const body = safeParseStopTradingSessionRequest(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'validation', issues: body.error.issues });
    }
    const summary = await claimSessionSummary(db, {
      id: id.data,
      telegramUserId: body.data.telegramUserId,
    });
    if (summary === undefined) return unavailable();
    return reply.send({
      summary: {
        result: summary.result,
        trades: summary.trades.map(({ profit, openPrice, closePrice }) => ({
          profit,
          openPrice,
          closePrice,
        })),
      },
    });
  });

  // Every active session of the user (#122, /stop in the bot): one UPDATE whose predicate is the
  // owner, so another user's id stops nothing and answers [] as "no sessions" (Rule 13). Nothing
  // goes to the broker but viewForReply's balance read of a finished session; a live trade plays
  // out on its own path. The reads run in parallel, one account each, inside
  // TRADING_SESSION_VIEW_BUDGET_MS. A thrown refresh is the opaque 500 after the stop committed.
  app.post(TRADING_SESSIONS_STOP_PATH, async (request, reply) => {
    const body = safeParseStopTradingSessionRequest(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'validation', issues: body.error.issues });
    }
    const { telegramUserId } = body.data;
    const stopped = await stopUserSessions(db, { telegramUserId });
    const views = await Promise.all(stopped.map(({ id }) => viewForReply(id, telegramUserId)));
    // a row deleted by hand between the two statements is left out, not a 500
    return reply.send({ sessions: views.filter((view) => view !== undefined) });
  });
};
