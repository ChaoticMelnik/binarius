import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import {
  DATABASE_URL_RULES,
  DEFAULT_SESSION_CYCLES,
  INT4_MAX,
  MAX_SESSION_CYCLES,
  parseUrlEnv,
  readEnv,
} from '@binarius/shared';
import { createDb } from '@binarius/db';
import * as z from 'zod';
import { runH1SessionCommand, type H1SessionCommand, type H1SessionDeps } from './h1-session';
import { formatFailure } from './kill-switch';
import { UsageError } from './trade-log';

// The H1 sessions' commands (#670, docs/h1.md → Sessions): this file parses them and owns the
// connection, h1-session.ts runs them. The mark (`h1 mark|unmark|list`) and the shadow report
// (`h1 shadow report`) were removed in #830.
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = `H1: сессии H1 (docs/h1.md → Sessions).

  h1 session start --account <accountId> --asset <id> [--cycles <N>]
  h1 session stop --account <accountId>
  h1 session status --account <accountId>

session start — сессия H1 аккаунта брокера (uuid), как обычная сессия: пара --asset (открыта,
берёт 5 с), --cycles циклов (1…20, по умолчанию 5), стратегия ставки процесса
(SESSION_STAKE_STRATEGY); ставка — сохранённая ставка режима пользователя или минимум брокера.
В stdout — id сессии. session stop — остановить активную сессию H1 аккаунта; session status —
последняя сессия H1 аккаунта. Код выхода: 0 — сделано, 1 — отказ (строка в stderr), нет сессии
или ошибка, 2 — не понято.`;

export type H1Command = H1SessionCommand;

const accountIdSchema = z.uuid();

function parseAccountId(raw: string | undefined): string {
  if (raw === undefined) throw new UsageError('нужен id аккаунта брокера (uuid)');
  if (!accountIdSchema.safeParse(raw).success) {
    throw new UsageError('id аккаунта брокера — uuid');
  }
  return raw;
}

const POSITIVE_INTEGER = /^[1-9]\d{0,9}$/;

function parseBoundedInt(raw: string | undefined, flag: string, max: number): number {
  if (raw === undefined) throw new UsageError(`нужен ${flag}`);
  const value = POSITIVE_INTEGER.test(raw) ? Number(raw) : Number.NaN;
  if (!(value <= max)) throw new UsageError(`${flag}: целое от 1 до ${max}`);
  return value;
}

function parseSessionCommand(argv: readonly string[]): H1SessionCommand {
  let values: { account?: string; asset?: string; cycles?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        account: { type: 'string' },
        asset: { type: 'string' },
        cycles: { type: 'string' },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const [, subcommand, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError('лишние аргументы');
  if (subcommand === 'start') {
    return {
      kind: 'session_start',
      accountId: parseAccountId(values.account),
      assetId: parseBoundedInt(values.asset, '--asset', INT4_MAX),
      cycles:
        values.cycles === undefined
          ? DEFAULT_SESSION_CYCLES
          : parseBoundedInt(values.cycles, '--cycles', MAX_SESSION_CYCLES),
    };
  }
  if (subcommand !== 'stop' && subcommand !== 'status') {
    throw new UsageError(
      subcommand === undefined
        ? 'нужна команда session start, stop или status'
        : `неизвестная команда: session ${subcommand}`,
    );
  }
  if (values.asset !== undefined || values.cycles !== undefined) {
    throw new UsageError(`session ${subcommand} принимает только --account`);
  }
  return {
    kind: subcommand === 'stop' ? 'session_stop' : 'session_status',
    accountId: parseAccountId(values.account),
  };
}

export function parseH1Command(argv: readonly string[]): H1Command {
  const [command] = argv;
  if (command === undefined) throw new UsageError('нет команды');
  if (command !== 'session') throw new UsageError(`неизвестная команда: ${command}`);
  return parseSessionCommand(argv);
}

export async function runH1Cli(
  argv: readonly string[],
  source: NodeJS.ProcessEnv,
  out: (text: string) => void,
  err: (line: string) => void,
  deps: H1SessionDeps = {},
): Promise<number> {
  let command: H1Command;
  try {
    command = parseH1Command(argv);
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
  try {
    return await runH1SessionCommand(createDb(pool), command, source, out, err, deps);
  } catch (error) {
    // name and code only (Rule 8)
    err(`Не удалось выполнить команду: ${formatFailure(error)}.`);
    return EXIT_FAILED;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// The module is imported by its test, so the command only runs when this file is what node was
// started with. exitCode, not exit(): a piped stdout is written asynchronously.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runH1Cli(
    process.argv.slice(2),
    process.env,
    (text) => void process.stdout.write(text),
    (line) => void process.stderr.write(`${line}\n`),
  );
}
