import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import {
  createKeyedWindow,
  DEPOSIT_BODY_LIMIT_BYTES,
  DEPOSIT_CREDITED_PATH,
  DepositCreditedOutcome,
  DepositErrorCode,
  UserStatus,
  assertExhausted,
  errorLogFields,
  safeParseDepositCreditedRequest,
  type BotTextBalance,
} from '@binarius/shared';
import {
  readBalanceSnapshot,
  resolveBalanceAccount,
  toBrokerBalanceView,
  touchBalanceRequested,
  type Db,
} from '@binarius/db';
import type { InitDataVerifier } from '../auth/telegram-init-data';
import type { ClientPush } from '../auth/client-push';
import type { BalanceReconciler, BalanceRefreshOutcome } from '../broker/balance-reconciler';
import { telegramErrorFields } from '../telegram-logging';
import { DEPOSIT_CREDITED_REFRESH_BUDGET_MS } from '../timing';
import { recordTelegramSendFailure } from '../users/telegram-delivery';

// Per Telegram user, taken after initData and never given back: a burst of the widget's credited
// events is one refresh, and a loop is bounded.
const DEPOSIT_CREDITED_PER_USER_PER_MINUTE = 3;
// At most one deposit push per Telegram user in this interval: a second credited within it still
// refreshes, but does not repeat the message.
const DEPOSIT_PUSH_MIN_INTERVAL_MS = 60_000;
const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

export interface DepositCreditedDeps {
  db: Db;
  initDataVerifier: InitDataVerifier;
  demoOnly: boolean;
  // the reconciler POST /trading/access refreshes through: one flight per account
  balance: Pick<BalanceReconciler, 'refresh'>;
  clientPush: Pick<ClientPush, 'sendDepositCredited'>;
  // lowered by tests; production runs on the constants above
  creditedPerUserPerMinute?: number;
  creditedRefreshBudgetMs?: number;
  pushMinIntervalMs?: number;
}

type CreditedAnswer =
  | { kind: 'outcome'; outcome: DepositCreditedOutcome }
  | { kind: 'refused'; error: DepositErrorCode };

const refused = (error: DepositErrorCode): CreditedAnswer => ({ kind: 'refused', error });
const pending: CreditedAnswer = { kind: 'outcome', outcome: DepositCreditedOutcome.Pending };

// docs/deposit.md -> After a deposit, error table rows 8-12. Every failure of the broker read is
// pending: the deposit happened at the broker either way, and the tick writes the snapshot of the
// account the route has just marked as requested.
export const CREDITED_ANSWERS = {
  ok: { kind: 'outcome', outcome: DepositCreditedOutcome.Refreshed },
  user_blocked: refused(DepositErrorCode.UserBlocked),
  // the row went between the resolution and the lock
  account_not_found: refused(DepositErrorCode.NoActiveAccount),
  account_pending: refused(DepositErrorCode.TokenUnavailable),
  account_revoked: refused(DepositErrorCode.TokenUnavailable),
  // our budget
  aborted: pending,
  // not expected with mayRefresh: true
  refresh_needed: pending,
  // the reconciler has reported the refused token already
  unauthorized: pending,
  rate_limited: pending,
  rejected: pending,
  unavailable: pending,
  contract_violation: pending,
  account_mismatch: pending,
  key_unavailable: pending,
} as const satisfies Record<BalanceRefreshOutcome, CreditedAnswer>;

// POST /deposit/credited (#112, docs/deposit.md -> After a deposit). Registered inside
// depositRoutes, so the plugin's ceiling covers it. A trigger, not data: the body is initData
// alone, and the only effect is a balance read of the caller's own account and, after a write,
// one push of the balance the broker reported.
export function registerDepositCredited(app: FastifyInstance, deps: DepositCreditedDeps): void {
  const perUser = createKeyedWindow(
    deps.creditedPerUserPerMinute ?? DEPOSIT_CREDITED_PER_USER_PER_MINUTE,
    WINDOW_MS,
    MAX_KEYS,
  );
  const pushes = createKeyedWindow(
    1,
    deps.pushMinIntervalMs ?? DEPOSIT_PUSH_MIN_INTERVAL_MS,
    MAX_KEYS,
  );
  const refreshBudgetMs = deps.creditedRefreshBudgetMs ?? DEPOSIT_CREDITED_REFRESH_BUDGET_MS;

  app.post(
    DEPOSIT_CREDITED_PATH,
    { bodyLimit: DEPOSIT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const parsed = safeParseDepositCreditedRequest(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
      }
      const refuse = (status: number, error: DepositErrorCode) =>
        reply.code(status).send({ error });

      // before any read: no widget session exists on a DEMO_ONLY server, so a credited event here
      // is stale or forged (#396)
      if (deps.demoOnly) return refuse(409, DepositErrorCode.DemoOnly);

      const proof = deps.initDataVerifier.verify(parsed.data.initData, Date.now());
      if (!proof.ok) {
        request.log.warn(
          { reason: proof.reason },
          'the credited event carried no valid Telegram proof',
        );
        return refuse(401, DepositErrorCode.InvalidTelegramAuth);
      }
      const { telegramUserId } = proof;
      if (perUser.take(String(telegramUserId))) {
        return refuse(429, DepositErrorCode.TooManyRequests);
      }

      const resolved = await resolveBalanceAccount(deps.db, { telegramUserId });
      switch (resolved.kind) {
        case 'no_user':
        case 'no_account':
        case 'not_found':
          return refuse(409, DepositErrorCode.NoActiveAccount);
        case 'ambiguous':
          return refuse(409, DepositErrorCode.AmbiguousAccount);
        case 'account':
          break;
        default:
          return assertExhausted(resolved, 'balance account resolution');
      }
      const accountId = resolved.account.id;
      // a blocked user never reaches the broker (Rule 12); the reconciler checks it again under the
      // lock
      if (resolved.account.userStatus === UserStatus.Blocked) {
        return refuse(409, DepositErrorCode.UserBlocked);
      }

      // as POST /trading/access: the tick watches the account even if this refresh writes nothing
      await touchBalanceRequested(deps.db, accountId);
      const result = await deps.balance.refresh(accountId, {
        signal: AbortSignal.timeout(refreshBudgetMs),
        requested: true,
        mayRefresh: true,
      });
      const answer = CREDITED_ANSWERS[result];
      if (answer.kind === 'refused') return refuse(409, answer.error);
      if (answer.outcome === DepositCreditedOutcome.Pending) {
        request.log.info({ accountId, outcome: result }, 'credited: the balance was not refreshed');
        return reply.send({ outcome: answer.outcome });
      }

      if (!pushes.take(String(telegramUserId))) {
        await pushBalance(deps, request.log, telegramUserId, accountId);
      }
      return reply.send({ outcome: answer.outcome });
    },
  );
}

// Never throws on a send failure: the answer is the refresh's, whatever Telegram says.
async function pushBalance(
  deps: DepositCreditedDeps,
  log: FastifyBaseLogger,
  telegramUserId: bigint,
  accountId: string,
): Promise<void> {
  const stored = await readBalanceSnapshot(deps.db, accountId);
  let balance: BotTextBalance = null;
  if (stored !== undefined) {
    const view = toBrokerBalanceView(stored);
    balance = { amount: view.real.available, fresh: view.fresh };
  }
  try {
    await deps.clientPush.sendDepositCredited(telegramUserId, balance);
  } catch (error) {
    // identity only: grammY's HttpError wraps a message with the token in its URL
    log.warn(
      { ...errorLogFields(error), ...telegramErrorFields(error, 'sendMessage'), push: 'deposit' },
      'the deposit push could not be sent to Telegram',
    );
    await recordTelegramSendFailure({ db: deps.db, log }, telegramUserId, error);
  }
}
