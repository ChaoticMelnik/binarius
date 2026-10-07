import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import {
  DATABASE_URL_RULES,
  TRADING_SWITCH_REASON_MAX,
  TradingSwitchSource,
  errorLogFields,
  parseUrlEnv,
  readEnv,
  tradingSwitchReasonSchema,
} from '@binarius/shared';
import {
  createDb,
  openTrading,
  readTradingSwitch,
  stopTrading,
  type TradingSwitchRow,
} from '@binarius/db';

// The global trading switch (#144, docs/kill-switch.md). `on` closes trading, `off` opens it,
// for demo and real together. 0 done, 1 the command could not be carried out, 2 not understood.
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = `Глобальный выключатель торговли (demo и real вместе).

  kill-switch on --reason <причина>   остановить приём новых заявок
  kill-switch off [--reason <причина>] открыть торговлю — demo и real
  kill-switch status                   показать состояние

Причина — 1-${TRADING_SWITCH_REASON_MAX} символов без управляющих.`;

type Parsed =
  { command: 'on'; reason: string } | { command: 'off'; reason?: string } | { command: 'status' };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function parseKillSwitchArgs(argv: readonly string[]): Parsed {
  let values: { reason?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { reason: { type: 'string' } },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const command = positionals[0];
  if (command === undefined) throw new UsageError('нет команды');
  if (positionals.length > 1) throw new UsageError('лишние аргументы');
  const reason = values.reason === undefined ? undefined : parseReason(values.reason);
  switch (command) {
    case 'on':
      if (reason === undefined) throw new UsageError('нужен --reason');
      return { command, reason };
    case 'off':
      return reason === undefined ? { command } : { command, reason };
    case 'status':
      if (reason !== undefined) throw new UsageError('--reason не нужен для status');
      return { command };
    default:
      throw new UsageError(`неизвестная команда: ${command}`);
  }
}

function parseReason(raw: string): string {
  const parsed = tradingSwitchReasonSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `--reason: 1-${TRADING_SWITCH_REASON_MAX} символов без управляющих (переводов строки, табуляции)`,
    );
  }
  return parsed.data;
}

const since = (row: TradingSwitchRow) => `с ${row.changedAt.toISOString()}, источник ${row.source}`;

export function describeTradingSwitch(row: TradingSwitchRow | undefined): string {
  if (row === undefined) return 'Строки переключателя нет — торговля остановлена';
  return row.tradingEnabled
    ? `Торговля открыта (${since(row)})`
    : `Торговля остановлена (${since(row)}): ${row.reason ?? ''}`;
}

export async function runKillSwitchCli(
  argv: readonly string[],
  source: NodeJS.ProcessEnv,
  print: (line: string) => void,
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseKillSwitchArgs(argv);
  } catch (error) {
    print(error instanceof Error ? error.message : String(error));
    print(USAGE);
    return EXIT_USAGE;
  }

  let databaseUrl: string;
  try {
    databaseUrl = parseUrlEnv(readEnv(source, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES);
  } catch (error) {
    // our own env messages name the variable, never its value
    print(error instanceof Error ? error.message : String(error));
    return EXIT_FAILED;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = createDb(pool);
  try {
    if (parsed.command === 'status') {
      print(describeTradingSwitch(await readTradingSwitch(db)));
      return EXIT_OK;
    }
    if (parsed.command === 'on') {
      const result = await stopTrading(db, {
        source: TradingSwitchSource.Operator,
        reason: parsed.reason,
      });
      print(
        result.changed
          ? 'Торговля остановлена. Новые заявки отклоняются; уже открытые сделки, сверка и расчёт продолжаются.'
          : `Торговля уже остановлена (${since(result.state)}): ${result.state.reason ?? ''}`,
      );
      return EXIT_OK;
    }
    const result = await openTrading(db, { reason: parsed.reason });
    print(
      result.changed
        ? 'Торговля открыта — demo и real.'
        : `Торговля уже открыта (${since(result.state)})`,
    );
    return EXIT_OK;
  } catch (error) {
    // One door for every failure (pool, statement, commit). A commit whose acknowledgement was
    // lost leaves the state unknown, so the line never claims nothing changed; the operator
    // learns the state by re-reading it. Name and code only (Rule 8): no message, no stack.
    print(
      parsed.command === 'status'
        ? `Не удалось прочитать состояние: ${formatFailure(error)}.`
        : `Не удалось выполнить команду: ${formatFailure(error)}. Состояние могло измениться — проверьте командой status.`,
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

// The module is imported by its test, so the command only runs when this file is what node was
// started with. `pnpm --filter @binarius/backend kill-switch …` resolves to exactly that.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const code = await runKillSwitchCli(process.argv.slice(2), process.env, (line) => {
    process.stdout.write(`${line}\n`);
  });
  process.exit(code);
}
