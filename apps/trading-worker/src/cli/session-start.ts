import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import {
  createDb,
  createTradingSession,
  readBalanceSnapshot,
  readUserAccounts,
  TradingSessionError,
} from '@binarius/db';
import {
  DATABASE_URL_RULES,
  DEFAULT_SESSION_TRADES,
  errorLogFields,
  INT4_MAX,
  MAX_SESSION_TRADES,
  parseBoundedIntegerEnv,
  parseUrlEnv,
  readEnv,
  telegramUserIdSchema,
  TradeMode,
  UUID_PATTERN,
} from '@binarius/shared';
import {
  pickSessionAccount,
  planSessionStart,
  SESSION_START_REFUSALS,
} from '../trading-session/start';

// Starts a demo session of TRADES trades for a user's account (#287, docs/trading-session.md ->
// The CLI). The session id on stdout and exit 0; any refusal or failure on stderr and exit 1.
// The orchestrator in the running worker picks the session up on its next tick.
const EXIT_OK = 0;
const EXIT_FAILED = 1;

interface CliEnv {
  databaseUrl: string;
  telegramUserId: string;
  accountId?: string;
  assetId: number;
  durationSec: number;
  trades: number;
}

export function parseSessionStartEnv(source: NodeJS.ProcessEnv): CliEnv {
  const telegramUserId = readEnv(source, 'TELEGRAM_USER_ID');
  if (!telegramUserIdSchema.safeParse(telegramUserId).success) {
    throw new Error('Env TELEGRAM_USER_ID must be a positive integer');
  }
  const accountId = source.ACCOUNT_ID;
  if (accountId !== undefined && !UUID_PATTERN.test(accountId)) {
    throw new Error('Env ACCOUNT_ID must be a uuid');
  }
  return {
    databaseUrl: parseUrlEnv(readEnv(source, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES),
    telegramUserId,
    ...(accountId === undefined ? {} : { accountId }),
    assetId: parseBoundedIntegerEnv(readEnv(source, 'ASSET_ID'), 'ASSET_ID', 1, INT4_MAX),
    durationSec: parseBoundedIntegerEnv(
      readEnv(source, 'DURATION_SEC', '15'),
      'DURATION_SEC',
      1,
      INT4_MAX,
    ),
    trades: parseBoundedIntegerEnv(
      readEnv(source, 'TRADES', String(DEFAULT_SESSION_TRADES)),
      'TRADES',
      1,
      MAX_SESSION_TRADES,
    ),
  };
}

const ACCOUNT_PICK_REFUSALS = {
  account_not_found: SESSION_START_REFUSALS.account_not_found,
  account_not_confirmed: SESSION_START_REFUSALS.account_not_confirmed,
  no_active_account: 'У пользователя нет активного аккаунта брокера',
} as const;

const PLAN_REFUSALS = {
  session_too_long: 'Сессия не уложится в час: уменьшите TRADES или DURATION_SEC',
  zero_min_trade_amount: 'Минимальная ставка аккаунта — 0: из неё не получится ставка сессии',
  invalid_settings: 'Настройки сессии не проходят проверку',
} as const;

export async function runSessionStartCli(
  source: NodeJS.ProcessEnv,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  let env: CliEnv;
  try {
    env = parseSessionStartEnv(source);
  } catch (error) {
    // our own env messages name the variable, never its value
    err(error instanceof Error ? error.message : String(error));
    return EXIT_FAILED;
  }

  const pool = new Pool({ connectionString: env.databaseUrl });
  const db = createDb(pool);
  let brokerAccountId: string | undefined;
  try {
    const user = await readUserAccounts(db, BigInt(env.telegramUserId));
    if (user === undefined) {
      err('Нет пользователя с таким TELEGRAM_USER_ID');
      return EXIT_FAILED;
    }
    const pick = pickSessionAccount(user.accounts, env.accountId);
    if (!pick.ok) {
      if (pick.reason === 'ambiguous_account') {
        err('У пользователя несколько активных аккаунтов — укажите ACCOUNT_ID:');
        for (const account of pick.accounts) err(`${account.id} ${account.status}`);
      } else {
        err(ACCOUNT_PICK_REFUSALS[pick.reason]);
      }
      return EXIT_FAILED;
    }
    brokerAccountId = pick.brokerAccountId;
    const snapshot = await readBalanceSnapshot(db, brokerAccountId);
    if (snapshot === undefined) {
      err(
        'Нет снимка баланса аккаунта: откройте экран сделки в боте (POST /trading/access его пишет)',
      );
      return EXIT_FAILED;
    }
    const plan = planSessionStart({
      assetId: env.assetId,
      durationSec: env.durationSec,
      trades: env.trades,
      minTradeAmount: snapshot.minTradeAmount,
    });
    if (!plan.ok) {
      err(PLAN_REFUSALS[plan.reason]);
      return EXIT_FAILED;
    }
    const session = await createTradingSession(db, {
      telegramUserId: env.telegramUserId,
      brokerAccountId,
      mode: TradeMode.Demo,
      settings: plan.settings,
    });
    out(session.id);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof TradingSessionError) {
      err(SESSION_START_REFUSALS[error.code]);
      return EXIT_FAILED;
    }
    // One door for every other failure. A commit whose acknowledgement was lost leaves the state
    // unknown, so the line says how to re-read it. Name and code only (Rule 8).
    err(
      `Не удалось создать сессию: ${formatFailure(error)}. Состояние могло измениться — проверьте: ` +
        `select id, status from trading_sessions where broker_account_id = '${brokerAccountId ?? 'ACCOUNT_ID'}'`,
    );
    return EXIT_FAILED;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function formatFailure(error: unknown): string {
  const { err, cause } = errorLogFields(error);
  const one = ({ name, code }: { name: string; code?: string }) =>
    code === undefined ? name : `${name} ${code}`;
  return cause === undefined ? one(err) : `${one(err)} (${one(cause)})`;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const code = await runSessionStartCli(
    process.env,
    (line) => process.stdout.write(`${line}\n`),
    (line) => process.stderr.write(`${line}\n`),
  );
  process.exit(code);
}
