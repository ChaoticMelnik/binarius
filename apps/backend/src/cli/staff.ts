import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import {
  DATABASE_URL_RULES,
  errorLogFields,
  parseUrlEnv,
  readEnv,
  staffLoginSchema,
} from '@binarius/shared';
import {
  createDb,
  createStaffAccount,
  disableStaffAccount,
  findStaffForLogin,
  generatePassword,
  hashPassword,
  resetStaffPassword,
  StaffStatus,
  uniqueViolation,
  verifyPassword,
  type Db,
  type StaffInvalidation,
} from '@binarius/db';
import { formatFailure } from './kill-switch';

// 0 done, 1 refused or the result is unknown, 2 the command was not understood
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
  // What the receive path can match: grammY hands ctx.from.id over as a JSON-parsed number,
  // exact up to 2^53 - 1 (admin/telegram.ts). Telegram's ids fit in 52 bits, so nothing real is
  // refused; an id past this would be an account that gets its invitation and can never confirm.
  const TELEGRAM_USER_ID_MAX = BigInt(Number.MAX_SAFE_INTEGER);
  if (!/^[1-9]\d*$/.test(rawId) || BigInt(rawId) > TELEGRAM_USER_ID_MAX) {
    throw new UsageError(`--telegram-id: целое число от 1 до ${TELEGRAM_USER_ID_MAX}`);
  }
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

  let databaseUrl: string;
  try {
    databaseUrl = parseUrlEnv(readEnv(source, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES);
  } catch (error) {
    // our own env messages name the variable, never its value
    print(`Команда не выполнена: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }

  let pool: Pool | undefined;
  let db: Db | undefined;
  let password: string | undefined;
  // Every statement from here on sits inside this try, whose catch returns a code: that, not an
  // audit of what each call can throw, is why the CLI never leaves on an unhandled rejection.
  try {
    pool = new Pool({ connectionString: databaseUrl });
    db = createDb(pool);
    if (parsed.command === 'create') {
      password = generatePassword();
      const created = await createStaffAccount(db, {
        login: parsed.login,
        passwordHash: await hashPassword(password),
        telegramUserId: parsed.telegramId as bigint,
        displayName: parsed.name,
      });
      for (const line of createdLines(created.login, password)) print(line);
      return EXIT_OK;
    }

    if (parsed.command === 'disable') {
      const counts = await disableStaffAccount(db, parsed.login);
      if (counts === undefined) {
        print(`Учётная запись ${parsed.login} не найдена`);
        return EXIT_FAILED;
      }
      for (const line of disabledLines(parsed.login, counts)) print(line);
      return EXIT_OK;
    }

    password = generatePassword();
    const counts = await resetStaffPassword(db, {
      login: parsed.login,
      passwordHash: await hashPassword(password),
    });
    if (counts === undefined) {
      print(`Учётная запись ${parsed.login} не найдена`);
      return EXIT_FAILED;
    }
    for (const line of resetLines(parsed.login, password, counts)) print(line);
    return EXIT_OK;
  } catch (error) {
    // awaited here, so the finally below does not end the pool under the re-read
    return await reportFailure(db, parsed, password, error, print);
  } finally {
    if (pool !== undefined) await pool.end().catch(() => undefined);
  }
}

const UNKNOWN_COUNTS = 'число закрытых запросов, ссылок и отозванных сессий неизвестно';

const countsText = (counts: StaffInvalidation | undefined): string =>
  counts === undefined
    ? UNKNOWN_COUNTS
    : `закрыто запросов на вход ${counts.closedChallenges}, ссылок ${counts.closedLinks}, отозвано сессий ${counts.revokedSessions}`;

// printed once and never stored in plaintext: the row holds a hash
const createdLines = (login: string, password: string): string[] => [
  `Создана учётная запись ${login}`,
  `Пароль: ${password}`,
];

const disabledLines = (login: string, counts?: StaffInvalidation): string[] => [
  `Отключена ${login}: ${countsText(counts)}`,
];

const resetLines = (login: string, password: string, counts?: StaffInvalidation): string[] => [
  `Пароль ${login} сброшен: ${countsText(counts)}`,
  `Пароль: ${password}`,
];

function hasSqlState(error: unknown, code: string): boolean {
  const { err, cause } = errorLogFields(error);
  return err.code === code || cause?.code === code;
}

async function reportFailure(
  db: Db | undefined,
  parsed: Parsed,
  password: string | undefined,
  error: unknown,
  print: (line: string) => void,
): Promise<number> {
  // only create's INSERT can meet a unique index on staff, so only there does it mean "taken"
  if (parsed.command === 'create' && uniqueViolation(error) !== undefined) {
    print('Такой логин или Telegram ID уже занят');
    return EXIT_FAILED;
  }
  const refused = (): number => {
    print(`Команда не выполнена: ${formatFailure(error)}`);
    return EXIT_FAILED;
  };
  if (hasSqlState(error, '42P01')) {
    refused();
    print('База данных не мигрирована: выполните pnpm db:migrate');
    return EXIT_FAILED;
  }
  // no pool, or no password yet: not a statement was sent
  if (db === undefined || (parsed.command !== 'disable' && password === undefined)) {
    return refused();
  }
  let landed: string | undefined;
  try {
    landed = await commandLanded(db, parsed, password);
  } catch {
    // the re-read's own error is almost always the same one; the original is what is printed
    print(`Результат неизвестен: ${formatFailure(error)}`);
    print('Проверьте учётную запись и повторите команду');
    return EXIT_FAILED;
  }
  if (landed === undefined) return refused();
  print(`Ответ потерян, но запрошенное состояние достигнуто: ${formatFailure(error)}`);
  const lines =
    parsed.command === 'disable'
      ? disabledLines(landed)
      : parsed.command === 'create'
        ? createdLines(landed, password as string)
        : resetLines(landed, password as string);
  for (const line of lines) print(line);
  return EXIT_OK;
}

// A failed answer does not say whether the commit landed, and a repeat would mint another
// password, so the state is re-read: the login of the row in the requested state, if it is.
async function commandLanded(
  db: Db,
  parsed: Parsed,
  password: string | undefined,
): Promise<string | undefined> {
  const row = await findStaffForLogin(db, parsed.login);
  if (row === undefined) return undefined;
  if (parsed.command === 'disable') {
    return row.status === StaffStatus.Disabled ? row.login : undefined;
  }
  return password !== undefined && (await verifyPassword(row.passwordHash, password))
    ? row.login
    : undefined;
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
