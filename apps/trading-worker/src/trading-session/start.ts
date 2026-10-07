import { TradingSessionDbErrorCode } from '@binarius/db';
import {
  BrokerAccountStatus,
  normalizeDecimal,
  sessionFitsDeadline,
  stakeSettingsFor,
  tradingSessionSettingsSchema,
  TRADING_SESSION_SETTINGS_VERSION,
  type DecimalString,
  type TradingSessionSettings,
} from '@binarius/shared';
import { StakeStrategy } from '../stake/codes';
import { assertStakeParams } from '../stake/config';

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
    return accounts.some((account) => account.id === accountId)
      ? { ok: true, brokerAccountId: accountId }
      : { ok: false, reason: 'account_not_found' };
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
  trades: number;
  minTradeAmount: DecimalString;
}): SessionPlan {
  if (!sessionFitsDeadline(input.trades, input.durationSec)) {
    return { ok: false, reason: 'session_too_long' };
  }
  // a zero minimum is a valid snapshot, but a zero stake is no trade (#130 n1)
  if (normalizeDecimal(input.minTradeAmount) === '0') {
    return { ok: false, reason: 'zero_min_trade_amount' };
  }
  const parsed = tradingSessionSettingsSchema.safeParse({
    version: TRADING_SESSION_SETTINGS_VERSION,
    assetId: input.assetId,
    durationSec: input.durationSec,
    trades: input.trades,
    stake: stakeSettingsFor(input.minTradeAmount),
  });
  if (!parsed.success) return { ok: false, reason: 'invalid_settings' };
  try {
    assertStakeParams({ strategy: StakeStrategy.Fixed, ...parsed.data.stake });
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
  // unreachable from the CLI, which passes demo
  [TradingSessionDbErrorCode.ModeNotAllowed]: 'Сессии бывают только demo',
} as const satisfies Record<TradingSessionDbErrorCode, string>;
