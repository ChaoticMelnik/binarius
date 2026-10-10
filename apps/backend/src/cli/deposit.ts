import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import {
  DATABASE_URL_RULES,
  POSTBACK_MACROS,
  PostbackSource,
  parseUrlEnv,
  readEnv,
} from '@binarius/shared';
import {
  createDb,
  listRecentPostbackDeliveries,
  readDepositByPayment,
  type PostbackDeliveryRow,
} from '@binarius/db';
import { formatFailure } from './kill-switch';

// The postback journal (#141, docs/postbacks.md -> Visibility), read-only. Deposits themselves
// are on /admin/deposits; this shows what each delivery carried. 0 done, 1 the command could not
// be carried out or found nothing to show, 2 not understood.
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

export const DEPOSIT_LIST_DEFAULT = 20;
export const DEPOSIT_LIST_MAX = 200;

const USAGE = `Журнал постбэков брокера (только чтение).

  deposit list [--limit N]      последние доставки, новые сверху (N 1-${DEPOSIT_LIST_MAX}, по умолчанию ${DEPOSIT_LIST_DEFAULT})
  deposit show <payment_id>     депозит платежа и каждая его доставка с параметрами`;

type Parsed = { command: 'list'; limit: number } | { command: 'show'; paymentId: string };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function parseDepositArgs(argv: readonly string[]): Parsed {
  let values: { limit?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { limit: { type: 'string' } },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const [command, ...rest] = positionals;
  switch (command) {
    case undefined:
      throw new UsageError('нет команды');
    case 'list': {
      if (rest.length > 0) throw new UsageError('лишние аргументы');
      return {
        command,
        limit: values.limit === undefined ? DEPOSIT_LIST_DEFAULT : parseLimit(values.limit),
      };
    }
    case 'show': {
      if (values.limit !== undefined) throw new UsageError('--limit не нужен для show');
      const [paymentId, ...extra] = rest;
      if (paymentId === undefined || paymentId === '') throw new UsageError('нужен payment_id');
      if (extra.length > 0) throw new UsageError('лишние аргументы');
      return { command, paymentId };
    }
    default:
      throw new UsageError(`неизвестная команда: ${command}`);
  }
}

function parseLimit(raw: string): number {
  if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > DEPOSIT_LIST_MAX) {
    throw new UsageError(`--limit: целое от 1 до ${DEPOSIT_LIST_MAX}`);
  }
  return Number(raw);
}

const NONE = '—';
// Payload values are what the broker sent: a control character would reach the operator's
// terminal as an escape sequence.
const printable = (value: string | null | undefined): string =>
  value === null || value === undefined || value === ''
    ? NONE
    : value.replace(/\p{Cc}/gu, '?');
const payloadValue = (row: PostbackDeliveryRow, key: string): string =>
  printable(Object.hasOwn(row.payload, key) ? row.payload[key] : undefined);
const outcomeOf = (row: PostbackDeliveryRow): string =>
  row.rejectReason === null ? row.outcome : `${row.outcome}: ${row.rejectReason}`;

export function formatDeliveryLine(row: PostbackDeliveryRow): string {
  return [
    row.createdAt.toISOString(),
    printable(row.event),
    `постбэк ${printable(row.postbackId)}`,
    outcomeOf(row),
    `платёж ${payloadValue(row, POSTBACK_MACROS.paymentId)}`,
    `трейдер ${payloadValue(row, POSTBACK_MACROS.traderId)}`,
    `сумма ${payloadValue(row, POSTBACK_MACROS.amount)}`,
  ].join('  ');
}

export async function runDepositCli(
  argv: readonly string[],
  source: NodeJS.ProcessEnv,
  print: (line: string) => void,
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseDepositArgs(argv);
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
    if (parsed.command === 'list') {
      const rows = await listRecentPostbackDeliveries(db, parsed.limit);
      if (rows.length === 0) {
        print('Доставок нет. Депозиты — на странице /admin/deposits.');
        return EXIT_OK;
      }
      print(`Доставки постбэков, новые сверху (${rows.length}):`);
      for (const row of rows) print(formatDeliveryLine(row));
      return EXIT_OK;
    }

    const { deposit, deliveries } = await readDepositByPayment(db, {
      source: PostbackSource.Binodex,
      paymentId: parsed.paymentId,
    });
    if (deposit === undefined && deliveries.length === 0) {
      print(`Платёж ${printable(parsed.paymentId)} не найден: ни депозита, ни доставок.`);
      return EXIT_FAILED;
    }
    if (deposit === undefined) {
      print(`Депозита по платежу ${printable(parsed.paymentId)} нет: все его доставки отклонены.`);
    } else {
      print(`Депозит по платежу ${printable(parsed.paymentId)}:`);
      print(`  трейдер ${printable(deposit.brokerUserId)}`);
      print(`  сумма ${deposit.amount} ${printable(deposit.currency)}`);
      print(`  статус ${deposit.status}`);
      print(`  владелец (Telegram ID) ${deposit.telegramUserId?.toString() ?? NONE}`);
      print(`  аккаунт ${deposit.brokerAccountId ?? NONE}`);
      print(`  записан ${deposit.createdAt.toISOString()}`);
    }
    print(`Доставки (${deliveries.length}):`);
    for (const row of deliveries) {
      print(formatDeliveryLine(row));
      for (const [key, value] of Object.entries(row.payload)) {
        print(`    ${printable(key)}=${printable(value)}`);
      }
    }
    return EXIT_OK;
  } catch (error) {
    // name and code only (Rule 8): no message, no stack
    print(`Не удалось прочитать журнал: ${formatFailure(error)}.`);
    return EXIT_FAILED;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// The module is imported by its test, so the command only runs when this file is what node was
// started with. `pnpm --filter @binarius/backend deposit …` resolves to exactly that.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const code = await runDepositCli(process.argv.slice(2), process.env, (line) => {
    process.stdout.write(`${line}\n`);
  });
  process.exit(code);
}
