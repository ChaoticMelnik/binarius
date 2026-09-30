import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { DATABASE_URL_RULES, parseUrlEnv, readEnv, staffLoginSchema } from '@binarius/shared';
import {
  createDb,
  createStaffAccount,
  disableStaffAccount,
  generatePassword,
  hashPassword,
  resetStaffPassword,
  uniqueViolation,
} from '@binarius/db';

// 0 done, 1 the command could not be carried out, 2 the command was not understood
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = `Управление учётными записями сотрудников.

  staff create --login <login> --telegram-id <id> [--name <имя>]
  staff disable --login <login>
  staff reset-password --login <login>

Пароль генерируется и печатается один раз — сохраните его сразу.
Telegram ID сотрудник узнаёт, отправив /start служебному боту.`;

interface Parsed {
  command: string;
  login: string;
  telegramId?: bigint;
  name?: string;
}

export function parseStaffArgs(argv: readonly string[]): Parsed {
  let values: Record<string, string | undefined>;
  let positionals: string[];
  try {
    // strict, so a mistyped flag is refused rather than silently ignored. Its own errors are
    // wrapped, so every way of getting the command wrong leaves by the same door.
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        login: { type: 'string' },
        'telegram-id': { type: 'string' },
        name: { type: 'string' },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const command = positionals[0];
  if (command === undefined) throw new UsageError('нет команды');
  if (!['create', 'disable', 'reset-password'].includes(command)) {
    throw new UsageError(`неизвестная команда: ${command}`);
  }
  if (positionals.length > 1) throw new UsageError('лишние аргументы');

  const login = values.login;
  if (login === undefined) throw new UsageError('нужен --login');
  const validLogin = staffLoginSchema.safeParse(login);
  if (!validLogin.success) {
    throw new UsageError('--login: 3-64 символа из A-Z a-z 0-9 . _ -');
  }

  if (command !== 'create') {
    if (values['telegram-id'] !== undefined) throw new UsageError('--telegram-id только у create');
    if (values.name !== undefined) throw new UsageError('--name только у create');
    return { command, login };
  }

  const rawId = values['telegram-id'];
  if (rawId === undefined) throw new UsageError('нужен --telegram-id');
  if (!/^[1-9]\d{0,18}$/.test(rawId)) throw new UsageError('--telegram-id: целое число больше 0');
  return {
    command,
    login,
    telegramId: BigInt(rawId),
    ...(values.name === undefined ? {} : { name: values.name }),
  };
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export async function runStaffCli(
  argv: readonly string[],
  source: NodeJS.ProcessEnv,
  print: (line: string) => void,
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseStaffArgs(argv);
  } catch (error) {
    print(error instanceof Error ? error.message : String(error));
    print(USAGE);
    return EXIT_USAGE;
  }

  const databaseUrl = parseUrlEnv(readEnv(source, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES);
  const pool = new Pool({ connectionString: databaseUrl });
  const db = createDb(pool);
  try {
    if (parsed.command === 'create') {
      const password = generatePassword();
      const created = await createStaffAccount(db, {
        login: parsed.login,
        passwordHash: await hashPassword(password),
        telegramUserId: parsed.telegramId as bigint,
        displayName: parsed.name,
      });
      print(`Создана учётная запись ${created.login}`);
      // printed once and never stored in plaintext: the row holds a hash
      print(`Пароль: ${password}`);
      return EXIT_OK;
    }

    if (parsed.command === 'disable') {
      const counts = await disableStaffAccount(db, parsed.login);
      if (counts === undefined) {
        print(`Учётная запись ${parsed.login} не найдена`);
        return EXIT_FAILED;
      }
      print(
        `Отключена ${parsed.login}: закрыто запросов на вход ${counts.closedChallenges}, отозвано сессий ${counts.revokedSessions}`,
      );
      return EXIT_OK;
    }

    const password = generatePassword();
    const counts = await resetStaffPassword(db, {
      login: parsed.login,
      passwordHash: await hashPassword(password),
    });
    if (counts === undefined) {
      print(`Учётная запись ${parsed.login} не найдена`);
      return EXIT_FAILED;
    }
    print(
      `Пароль ${parsed.login} сброшен: закрыто запросов на вход ${counts.closedChallenges}, отозвано сессий ${counts.revokedSessions}`,
    );
    print(`Пароль: ${password}`);
    return EXIT_OK;
  } catch (error) {
    if (uniqueViolation(error) !== undefined) {
      print('Такой логин или Telegram ID уже занят');
      return EXIT_FAILED;
    }
    throw error;
  } finally {
    await pool.end();
  }
}

// The module is imported by its test, so the command only runs when this file is what node was
// started with. `pnpm --filter @binarius/backend staff …` resolves to exactly that.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const code = await runStaffCli(process.argv.slice(2), process.env, (line) => {
    process.stdout.write(`${line}\n`);
  });
  process.exit(code);
}
