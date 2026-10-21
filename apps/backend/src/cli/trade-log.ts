import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import * as z from 'zod';
import {
  DATABASE_URL_RULES,
  parseUrlEnv,
  readEnv,
  safeParseTradingSessionSettings,
  sessionStakeParams,
  type SessionTradeStep,
  type TradeLogLine,
  type TradeLogTradeJson,
} from '@binarius/shared';
import {
  BrokerTradeStatus,
  createDb,
  journalEntryOf,
  readTradeLogEnd,
  readSessionTradeSteps,
  readTradeLogPage,
  type Db,
  type TradeLogCursor,
  type TradeLogRow,
} from '@binarius/db';
import { formatFailure } from './kill-switch';

// The trade log's export (#666, docs/trade-log.md → The export): the decisions recorded in a
// period, one JSON line each, or the closed trades among them in the stand's calibrate shape.
// Internal ids only: no telegram id, no broker user id, no token, no raw broker payload.
// 0 done (no rows included: an export is not a gate), 1 failed, 2 not understood.
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

export const TRADE_LOG_PAGE_ROWS = 200;

export const TradeLogFormat = { Jsonl: 'jsonl', TradesJson: 'trades-json' } as const;
export type TradeLogFormat = (typeof TradeLogFormat)[keyof typeof TradeLogFormat];

const USAGE = `Выгрузка журнала решений сессий (docs/trade-log.md).

  trade-log export --from <ISO 8601> [--to <ISO 8601>] [--format jsonl|trades-json] [--session <uuid>]

--from — начало периода (включительно), --to — конец (не включительно, по умолчанию — сейчас
по часам базы), по времени записи решения; время — с зоной, до миллисекунд. jsonl — строка на решение; trades-json — массив закрытых сделок
для stand calibrate. Данные — в stdout, итог — в stderr.`;

export interface TradeLogArgs {
  from: Date;
  // undefined: the database's clock when the export starts, the clock recorded_at is written by
  to: Date | undefined;
  format: TradeLogFormat;
  sessionId?: string;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const isoSchema = z.iso.datetime({ offset: true });
const uuidSchema = z.uuid();

export function parseInstant(raw: string, name: string): Date {
  if (!isoSchema.safeParse(raw).success) {
    throw new UsageError(`${name}: нужна дата ISO 8601 с зоной, например 2026-10-20T00:00:00Z`);
  }
  // Date holds milliseconds and recorded_at microseconds: a finer bound would move the window.
  // In an accepted ISO instant the only '.' is the seconds' fraction.
  if (/\.\d{4}/.test(raw)) {
    throw new UsageError(
      `${name}: не больше трёх знаков после точки - время считается в миллисекундах`,
    );
  }
  return new Date(raw);
}

export function parseTradeLogArgs(argv: readonly string[]): TradeLogArgs {
  let values: { from?: string; to?: string; format?: string; session?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        format: { type: 'string' },
        session: { type: 'string' },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const command = positionals[0];
  if (command === undefined) throw new UsageError('нет команды');
  if (command !== 'export') throw new UsageError(`неизвестная команда: ${command}`);
  if (positionals.length > 1) throw new UsageError('лишние аргументы');
  if (values.from === undefined) throw new UsageError('нужен --from');
  const from = parseInstant(values.from, '--from');
  const to = values.to === undefined ? undefined : parseInstant(values.to, '--to');
  if (to !== undefined && to.getTime() <= from.getTime()) {
    throw new UsageError('--to должен быть позже --from');
  }
  const format = values.format ?? TradeLogFormat.Jsonl;
  if (format !== TradeLogFormat.Jsonl && format !== TradeLogFormat.TradesJson) {
    throw new UsageError(`--format: jsonl или trades-json, не ${format}`);
  }
  if (values.session !== undefined && !uuidSchema.safeParse(values.session).success) {
    throw new UsageError('--session: нужен uuid сессии');
  }
  return {
    from,
    to,
    format,
    ...(values.session === undefined ? {} : { sessionId: values.session }),
  };
}

// One line, field by field (Rule 9): nothing of a row reaches the output unnamed.
export function toTradeLogLine(
  row: TradeLogRow,
  steps: ReadonlyMap<string, SessionTradeStep>,
): TradeLogLine {
  const { decision, session, intent, ticks } = row;
  const settings = session === null ? undefined : safeParseTradingSessionSettings(session.settings);
  const stake = settings?.success === true ? sessionStakeParams(settings.data) : undefined;
  const step = intent === null ? undefined : steps.get(intent.id);
  return {
    decision: {
      id: decision.id,
      context: decision.context,
      outcome: decision.outcome,
      detail: decision.detail,
      version: decision.version,
      assetId: decision.assetId,
      interval: decision.interval,
      step: decision.step,
      kind: decision.kind,
      action: decision.action,
      decidedAtMs: decision.decidedAtMs,
      takenAtMs: decision.takenAtMs,
      recordedAtMs: decision.recordedAt.getTime(),
      ticksUntilMs: decision.ticksUntilMs,
      payout: decision.payout,
      lastTick: decision.lastTick,
      result: decision.result,
    },
    signal: journalEntryOf(decision) as TradeLogLine['signal'],
    session:
      session === null
        ? null
        : {
            id: session.id,
            userId: session.userId,
            brokerAccountId: session.brokerAccountId,
            mode: session.mode,
            strategy: stake?.strategy ?? null,
            baseStake: stake?.baseStake ?? null,
            durationSec: settings?.success === true ? settings.data.durationSec : null,
            stopReason: session.stopReason,
          },
    trade:
      intent === null
        ? null
        : {
            intentId: intent.id,
            status: intent.status,
            mode: intent.mode,
            action: intent.action,
            amount: intent.amount,
            durationSec: intent.durationSec,
            createdAtMs: intent.createdAt.getTime(),
            submittedAtMs: intent.submittedAt?.getTime() ?? null,
            lastError: intent.lastError,
            submitDeadlineAtMs: intent.submitDeadlineAt?.getTime() ?? null,
            cycle: step?.cycle ?? null,
            cycleStep: step?.step ?? null,
            broker:
              intent.broker === null
                ? null
                : {
                    status: intent.broker.status,
                    payout: intent.broker.payout,
                    openPrice: intent.broker.openPrice,
                    openTimestampMs: intent.broker.openTimestampMs,
                    closePrice: intent.broker.closePrice,
                    closeTimestampMs: intent.broker.closeTimestampMs,
                    profit: intent.broker.profit,
                  },
          },
    ticks:
      ticks === null
        ? null
        : {
            status: ticks.status,
            detail: ticks.detail,
            fromMs: ticks.fromMs,
            untilMs: ticks.untilMs,
            count: ticks.count,
            rows: ticks.ticks,
          },
  };
}

// the stand's calibrate input: only a session's trade the broker closed, with its close
export function toTradeJson(line: TradeLogLine): TradeLogTradeJson | undefined {
  const { session, trade } = line;
  const broker = trade?.broker;
  if (
    session === null ||
    trade === null ||
    broker === null ||
    broker === undefined ||
    broker.status !== BrokerTradeStatus.Closed ||
    broker.closePrice === null ||
    broker.closeTimestampMs === null ||
    broker.profit === null
  ) {
    return undefined;
  }
  return {
    trading_session_id: session.id,
    asset_id: line.decision.assetId,
    action: trade.action,
    duration_sec: trade.durationSec,
    created_at_ms: trade.createdAtMs,
    open_timestamp_ms: broker.openTimestampMs,
    open_price: broker.openPrice,
    close_timestamp_ms: broker.closeTimestampMs,
    close_price: broker.closePrice,
    profit: broker.profit,
    submitted_at_ms: trade.submittedAtMs,
    payout: broker.payout,
    intent_id: trade.intentId,
    decision_id: line.decision.id,
    mode: trade.mode,
    amount: trade.amount,
  };
}

async function exportLines(
  db: Db,
  args: TradeLogArgs,
  emit: (line: TradeLogLine) => void,
): Promise<void> {
  const to = args.to ?? (await readTradeLogEnd(db));
  const steps = new Map<string, SessionTradeStep>();
  const stepped = new Set<string>();
  let after: TradeLogCursor | undefined;
  for (;;) {
    const page = await readTradeLogPage(db, {
      from: args.from,
      to,
      limit: TRADE_LOG_PAGE_ROWS,
      ...(after === undefined ? {} : { after }),
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
    });
    const fresh = [
      ...new Set(
        page.rows.flatMap((row) =>
          row.session === null || stepped.has(row.session.id) ? [] : [row.session.id],
        ),
      ),
    ];
    for (const [intentId, step] of await readSessionTradeSteps(db, fresh)) {
      steps.set(intentId, step);
    }
    for (const id of fresh) stepped.add(id);
    for (const row of page.rows) emit(toTradeLogLine(row, steps));
    if (page.next === undefined) return;
    after = page.next;
  }
}

export async function runTradeLogCli(
  argv: readonly string[],
  source: NodeJS.ProcessEnv,
  out: (text: string) => void,
  err: (line: string) => void,
): Promise<number> {
  let args: TradeLogArgs;
  try {
    args = parseTradeLogArgs(argv);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    err(USAGE);
    return EXIT_USAGE;
  }

  let databaseUrl: string;
  try {
    databaseUrl = parseUrlEnv(readEnv(source, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES);
  } catch (error) {
    // our own env messages name the variable, never its value
    err(error instanceof Error ? error.message : String(error));
    return EXIT_FAILED;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = createDb(pool);
  try {
    let count = 0;
    if (args.format === TradeLogFormat.Jsonl) {
      await exportLines(db, args, (line) => {
        out(`${JSON.stringify(line)}\n`);
        count += 1;
      });
    } else {
      const trades: TradeLogTradeJson[] = [];
      await exportLines(db, args, (line) => {
        const trade = toTradeJson(line);
        if (trade !== undefined) trades.push(trade);
      });
      out(`${JSON.stringify(trades)}\n`);
      count = trades.length;
    }
    err(`строк: ${count}`);
    return EXIT_OK;
  } catch (error) {
    // name and code only (Rule 8); a JSONL export cut here has printed whole lines only
    err(`Не удалось выгрузить журнал: ${formatFailure(error)}.`);
    return EXIT_FAILED;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// The module is imported by its test, so the command only runs when this file is what node was
// started with. exitCode, not exit(): a piped stdout is written asynchronously, and exit() would
// cut the export short.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runTradeLogCli(
    process.argv.slice(2),
    process.env,
    (text) => void process.stdout.write(text),
    (line) => void process.stderr.write(`${line}\n`),
  );
}
