import {
  createBrokerRestClient,
  createPairsCatalog,
  DEFAULT_BROKER_PAIRS_TTL_MS,
} from '@binarius/broker-rest';
import {
  checkTradingSessionStart,
  createTradingSession,
  readActiveH1Session,
  readBalanceSnapshot,
  readH1Account,
  readLastH1Session,
  readStakes,
  readTradingSessionView,
  stopTradingSession,
  TradingSessionDbErrorCode,
  TradingSessionError,
  type Db,
  type TradingSessionStartRefusal,
} from '@binarius/db';
import {
  buildH1SessionSettings,
  checkStake,
  H1_EXPIRY_SEC,
  H1_MIN_PAYOUT_PCT,
  HTTPS_ONLY_RULES,
  isPairOpen,
  pairAcceptsDuration,
  parseDemoOnlyEnv,
  parseUrlEnv,
  readEnv,
  stakeSettingsFrom,
  StakeRefusal,
  TradeMode,
  TradingSessionErrorCode,
  TradingSessionStopReason,
  type PairsCatalogView,
} from '@binarius/shared';
import { formatFailure } from './kill-switch';

// `h1 session start|stop|status` (#670, docs/h1.md → Sessions): an H1 session (settings v4) of a
// marked account. The checks of `start` run in a fixed order, each its own line and exit 1, before
// any write; its trades come from the driver (#707), the orchestrator stops it.
export type H1SessionCommand =
  | {
      kind: 'session_start';
      accountId: string;
      assetId: number;
      trades: number;
      maxLossMultiplier: number;
    }
  | { kind: 'session_stop'; accountId: string }
  | { kind: 'session_status'; accountId: string };

export interface H1SessionDeps {
  // one read of the broker's pairs; undefined when there is none. The CLI's own GET by default
  catalog?: () => Promise<PairsCatalogView | undefined>;
  now?: () => number;
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;

// checkTradingSessionStart's refusals; a code added later fails tsc here
const START_CHECK_LINES = {
  [TradingSessionErrorCode.UserNotFound]: 'пользователь аккаунта не найден',
  [TradingSessionErrorCode.UserBlocked]: 'пользователь заблокирован',
  [TradingSessionErrorCode.BrokerAccountNotFound]: 'аккаунт брокера не найден',
  [TradingSessionErrorCode.AmbiguousBrokerAccount]: 'у пользователя несколько аккаунтов брокера',
  [TradingSessionErrorCode.AccountNotConfirmed]: 'аккаунт брокера ещё не подтверждён в боте',
  [TradingSessionErrorCode.AccountRevoked]: 'аккаунт брокера отключён',
  [TradingSessionErrorCode.AccountHalted]: 'торговля на аккаунте остановлена до ручной проверки',
  [TradingSessionErrorCode.ActiveSessionExists]: 'на аккаунте уже идёт торговая сессия',
  [TradingSessionErrorCode.InsufficientTokens]: 'у пользователя нет свободного токена',
  [TradingSessionErrorCode.TradingPaused]: 'торговля остановлена выключателем',
  [TradingSessionErrorCode.ModeNotAllowed]: 'режим сессии не совпадает с режимом пользователя',
} as const satisfies Record<TradingSessionStartRefusal, string>;

// createTradingSession's refusals under its locks; a code added later fails tsc here
const CREATE_LINES = {
  [TradingSessionDbErrorCode.AccountNotFound]: 'аккаунт брокера не найден',
  [TradingSessionDbErrorCode.AccountRevoked]: 'аккаунт брокера отключён',
  [TradingSessionDbErrorCode.AccountNotConfirmed]: 'аккаунт брокера ещё не подтверждён в боте',
  [TradingSessionDbErrorCode.AccountHalted]: 'торговля на аккаунте остановлена до ручной проверки',
  [TradingSessionDbErrorCode.UserNotActive]: 'пользователь заблокирован',
  [TradingSessionDbErrorCode.ActiveSessionExists]: 'на аккаунте уже идёт торговая сессия',
  [TradingSessionDbErrorCode.TradingPaused]: 'торговля остановлена выключателем',
  [TradingSessionDbErrorCode.ModeNotAllowed]: 'режим пользователя сменился — сессия не создана',
  [TradingSessionDbErrorCode.DemoOnly]: 'DEMO_ONLY=true: real-сессии отключены',
  [TradingSessionDbErrorCode.AccountNotH1]: 'метка H1 снята во время старта — сессия не создана',
} as const satisfies Record<TradingSessionDbErrorCode, string>;

// checkStake's refusals of the session's stake against the snapshot
const STAKE_LINES = {
  [StakeRefusal.Precision]: 'сохранённая ставка точнее шага брокера',
  [StakeRefusal.BelowMinimum]: 'сохранённая ставка ниже минимума брокера',
  [StakeRefusal.AboveAvailable]: 'на балансе режима меньше ставки',
} as const satisfies Record<StakeRefusal, string>;

function catalogFromEnv(source: NodeJS.ProcessEnv): () => Promise<PairsCatalogView | undefined> {
  const baseUrl = parseUrlEnv(
    readEnv(source, 'BROKER_API_BASE_URL'),
    'BROKER_API_BASE_URL',
    HTTPS_ONLY_RULES,
  );
  return async () => {
    // the catalog's own lines carry no URL or token; the CLI prints only their messages
    const quiet = { warn: () => undefined, error: () => undefined, info: () => undefined };
    const catalog = createPairsCatalog({
      client: createBrokerRestClient({ baseUrl }),
      ttlMs: DEFAULT_BROKER_PAIRS_TTL_MS,
      logger: quiet,
    });
    const refreshed = await catalog.refresh();
    catalog.stop();
    return refreshed ? catalog.read() : undefined;
  };
}

async function start(
  db: Db,
  command: Extract<H1SessionCommand, { kind: 'session_start' }>,
  source: NodeJS.ProcessEnv,
  out: (text: string) => void,
  err: (line: string) => void,
  deps: H1SessionDeps,
): Promise<number> {
  const { accountId, assetId } = command;
  let demoOnly: boolean;
  let readCatalog: () => Promise<PairsCatalogView | undefined>;
  try {
    demoOnly = parseDemoOnlyEnv(source);
    readCatalog = deps.catalog ?? catalogFromEnv(source);
  } catch (error) {
    // our own env messages name the variable, never its value
    err(error instanceof Error ? error.message : String(error));
    return EXIT_FAILED;
  }

  const account = await readH1Account(db, accountId);
  if (account === undefined) {
    err('аккаунт брокера не найден');
    return EXIT_FAILED;
  }
  if (account.h1Since === null) {
    err(`аккаунт не помечен для H1: сначала h1 mark ${accountId}`);
    return EXIT_FAILED;
  }
  // the user's mode decides the session's (Rule 36); DEMO_ONLY before any broker read (Rule 33)
  const mode = account.tradingMode;
  if (demoOnly && mode === TradeMode.Real) {
    err('DEMO_ONLY=true, а пользователь в реальном режиме: real-сессии отключены');
    return EXIT_FAILED;
  }

  const view = await readCatalog();
  if (view === undefined || !view.fresh) {
    err('каталог пар брокера недоступен — повторите позже');
    return EXIT_FAILED;
  }
  const now = (deps.now ?? Date.now)();
  const pair = view.pairs.find((candidate) => candidate.id === assetId);
  if (pair === undefined || !isPairOpen(pair, now) || !pairAcceptsDuration(pair, H1_EXPIRY_SEC)) {
    err(
      `пара ${assetId} недоступна: её нет в каталоге, она закрыта или не берёт ${H1_EXPIRY_SEC} с`,
    );
    return EXIT_FAILED;
  }
  // only at the start (owner 2026-10-19): a payout that falls during the session is not checked
  if (pair.payout < H1_MIN_PAYOUT_PCT) {
    err(`выплата пары ${pair.payout} % ниже ${H1_MIN_PAYOUT_PCT} %`);
    return EXIT_FAILED;
  }

  const eligible = await checkTradingSessionStart(db, {
    telegramUserId: account.telegramUserId,
    brokerAccountId: accountId,
    mode,
  });
  if (!eligible.ok) {
    const active = eligible.activeSessionId === undefined ? '' : `: ${eligible.activeSessionId}`;
    err(`${START_CHECK_LINES[eligible.code]}${active}`);
    return EXIT_FAILED;
  }

  const snapshot = await readBalanceSnapshot(db, accountId);
  if (snapshot === undefined) {
    err('нет снимка баланса аккаунта: откройте экран сделки в боте и повторите');
    return EXIT_FAILED;
  }
  // the user's saved stake of the mode, or the broker's minimum (as the start route, #297)
  const stakes = await readStakes(db, BigInt(account.telegramUserId));
  const savedStake = (mode === TradeMode.Real ? stakes?.realStake : stakes?.demoStake) ?? null;
  const available = mode === TradeMode.Real ? snapshot.real.available : snapshot.demo.available;
  const stakeRefusal = checkStake(savedStake ?? snapshot.minTradeAmount, {
    minTradeAmount: snapshot.minTradeAmount,
    available,
  });
  if (stakeRefusal !== null) {
    err(STAKE_LINES[stakeRefusal]);
    return EXIT_FAILED;
  }
  // a minimum of 0 gives a stake of 0, and a ceiling outside numeric(20,8) fails the schema
  const settings = buildH1SessionSettings({
    assetId,
    trades: command.trades,
    stake: stakeSettingsFrom(savedStake, snapshot.minTradeAmount),
    maxLossMultiplier: command.maxLossMultiplier,
  });
  if (!settings.success) {
    err('ставка или потолок потерь не укладываются в настройки сессии');
    return EXIT_FAILED;
  }

  try {
    const session = await createTradingSession(
      db,
      {
        telegramUserId: account.telegramUserId,
        brokerAccountId: accountId,
        mode,
        settings: settings.data,
      },
      { demoOnly },
    );
    out(`${session.id}\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof TradingSessionError) {
      err(CREATE_LINES[error.code]);
      return EXIT_FAILED;
    }
    // a commit whose acknowledgement was lost leaves the state unknown; name and code only (Rule 8)
    err(
      `Не удалось создать сессию: ${formatFailure(error)}. Состояние могло измениться — проверьте: ` +
        `select id, status from trading_sessions where broker_account_id = '${accountId}'`,
    );
    return EXIT_FAILED;
  }
}

async function stop(
  db: Db,
  accountId: string,
  out: (text: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const active = await readActiveH1Session(db, accountId);
  if (active === undefined) {
    err('у аккаунта нет активной сессии');
    return EXIT_FAILED;
  }
  if (!active.isH1) {
    err('активная сессия аккаунта — не H1: её останавливает бот');
    return EXIT_FAILED;
  }
  const stopped = await stopTradingSession(db, {
    id: active.id,
    reason: TradingSessionStopReason.UserStopped,
  });
  if (stopped === undefined) {
    err('у аккаунта нет активной сессии');
    return EXIT_FAILED;
  }
  out(`${active.id}\n`);
  err('сессия H1 остановлена');
  return EXIT_OK;
}

async function status(
  db: Db,
  accountId: string,
  out: (text: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const account = await readH1Account(db, accountId);
  const id = account === undefined ? undefined : await readLastH1Session(db, accountId);
  if (account === undefined || id === undefined) {
    err('нет сессий H1');
    return EXIT_FAILED;
  }
  const view = await readTradingSessionView(db, id, account.telegramUserId);
  if (view === undefined) {
    err('нет сессий H1');
    return EXIT_FAILED;
  }
  const { trades } = view;
  const planned = view.settings === null ? '-' : String(view.cycles.planned);
  out(
    [
      `сессия ${view.id}`,
      `статус ${view.status}${view.stopReason === null ? '' : ` (${view.stopReason})`}, режим ${view.mode}`,
      `сделок ${trades.settled} из ${planned}: выигрышей ${trades.won}, проигрышей ${trades.lost}, ничьих ${trades.tied}, отклонено ${trades.rejected}`,
      `прибыль ${trades.profit}`,
      `начало ${view.startedAt}, конец ${view.endedAt ?? '-'}`,
    ].join('\n') + '\n',
  );
  return EXIT_OK;
}

export function runH1SessionCommand(
  db: Db,
  command: H1SessionCommand,
  source: NodeJS.ProcessEnv,
  out: (text: string) => void,
  err: (line: string) => void,
  deps: H1SessionDeps = {},
): Promise<number> {
  switch (command.kind) {
    case 'session_start':
      return start(db, command, source, out, err, deps);
    case 'session_stop':
      return stop(db, command.accountId, out, err);
    case 'session_status':
      return status(db, command.accountId, out, err);
  }
}
