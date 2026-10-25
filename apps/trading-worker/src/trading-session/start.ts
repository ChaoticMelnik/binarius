import { TradingSessionDbErrorCode } from '@binarius/db';
import {
  BrokerAccountStatus,
  buildSessionSettings,
  normalizeDecimal,
  sessionFitsDeadline,
  sessionStakeParams,
  stakeSettingsFor,
  type DecimalString,
  type SessionStakeStrategy,
  type TradingSessionSettings,
} from '@binarius/shared';
import { assertStakeParams } from '@binarius/stake';

// The session-start CLI's pure part (docs/trading-session.md -> The CLI): which account, which
// settings, and the Russian texts of its refusals. Nothing here reads the database.

export type AccountPick =
  | { ok: true; brokerAccountId: string }
  | { ok: false; reason: 'no_active_account' | 'account_not_confirmed' | 'account_not_found' }
  | { ok: false; reason: 'ambiguous_account'; accounts: { id: string; status: string }[] };

// With ACCOUNT_ID, only one of the user's own accounts, before anything of the account is read: a
// foreign or unknown id is the same account_not_found. The list is readUserAccounts' 10 newest, so
// an own account older than those is not found either (accepted). Without ACCOUNT_ID, the user's
// only active account; the list carries no email (not needed to choose).
export function pickSessionAccount(
  accounts: readonly { id: string; status: string }[],
  accountId?: string,
): AccountPick {
  if (accountId !== undefined) {
    // pg answers uuids in lower case while UUID_PATTERN accepts either; the listed spelling goes on
    const wanted = accountId.toLowerCase();
    const own = accounts.find((account) => account.id.toLowerCase() === wanted);
    return own === undefined
      ? { ok: false, reason: 'account_not_found' }
      : { ok: true, brokerAccountId: own.id };
  }
  const active = accounts.filter((account) => account.status === BrokerAccountStatus.Active);
  if (active.length === 1) return { ok: true, brokerAccountId: active[0]!.id };
  if (active.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous_account',
      accounts: active.map(({ id, status }) => ({ id, status })),
    };
  }
  return accounts.some((account) => account.status === BrokerAccountStatus.Pending)
    ? { ok: false, reason: 'account_not_confirmed' }
    : { ok: false, reason: 'no_active_account' };
}

export type SessionPlan =
  | { ok: true; settings: TradingSessionSettings }
  | { ok: false; reason: 'session_too_long' | 'zero_min_trade_amount' | 'invalid_settings' };

export function planSessionStart(input: {
  assetId: number;
  durationSec: number;
  cycles: number;
  minTradeAmount: DecimalString;
  // SESSION_STAKE_STRATEGY of the CLI's env (#450)
  strategy: SessionStakeStrategy;
}): SessionPlan {
  if (!sessionFitsDeadline(input.cycles, input.durationSec, input.strategy)) {
    return { ok: false, reason: 'session_too_long' };
  }
  // a zero minimum is a valid snapshot, but a zero stake is no trade (#130 n1)
  if (normalizeDecimal(input.minTradeAmount) === '0') {
    return { ok: false, reason: 'zero_min_trade_amount' };
  }
  const parsed = buildSessionSettings({
    assetId: input.assetId,
    durationSec: input.durationSec,
    cycles: input.cycles,
    stake: stakeSettingsFor(input.minTradeAmount),
    strategy: input.strategy,
  });
  if (!parsed.success) return { ok: false, reason: 'invalid_settings' };
  try {
    assertStakeParams(sessionStakeParams(parsed.data));
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, reason: 'invalid_settings' };
    throw error;
  }
  return { ok: true, settings: parsed.data };
}

export const SESSION_START_REFUSALS = {
  [TradingSessionDbErrorCode.AccountNotFound]: 'У пользователя нет такого аккаунта брокера',
  [TradingSessionDbErrorCode.AccountRevoked]: 'Аккаунт брокера отключён',
  [TradingSessionDbErrorCode.AccountNotConfirmed]: 'Аккаунт брокера ещё не подтверждён в боте',
  [TradingSessionDbErrorCode.AccountHalted]: 'Торговля на аккаунте остановлена до ручной проверки',
  [TradingSessionDbErrorCode.UserNotActive]: 'Пользователь заблокирован',
  [TradingSessionDbErrorCode.ActiveSessionExists]: 'На аккаунте уже идёт торговая сессия',
  [TradingSessionDbErrorCode.TradingPaused]: 'Торговля остановлена — сессия не создана',
  // the CLI passes demo, and createTradingSession takes only the user's mode (#327): a user in
  // real mode gets this
  [TradingSessionDbErrorCode.ModeNotAllowed]:
    'Пользователь в реальном режиме: CLI создаёт только demo-сессии — запустите сессию из бота или верните пользователя в demo',
  // unreachable while the CLI passes demo; the flag is read so a future real mode meets the guard
  [TradingSessionDbErrorCode.DemoOnly]: 'Стенд запущен с DEMO_ONLY=true — real-сессии отключены',
} as const satisfies Record<TradingSessionDbErrorCode, string>;
