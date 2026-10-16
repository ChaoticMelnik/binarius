import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import {
  BonusRuleKind,
  DATABASE_URL_RULES,
  isBonusRuleKind,
  parseUrlEnv,
  readEnv,
} from '@binarius/shared';
import {
  activateBonusRuleVersion,
  createBonusRuleVersion,
  createDb,
  deactivateBonusRule,
  listBonusRules,
  type BonusRuleRow,
} from '@binarius/db';
import { formatFailure } from './kill-switch';

// The versioned bonus rules (#13, docs/bonus-rules.md → The CLI). 0 done, 1 the command could not
// be carried out (a refusal or a failure), 2 not understood. A version is never edited: a change
// is a new version, then `activate`.
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const KINDS = Object.values(BonusRuleKind).join(', ');

const USAGE = `Правила начисления бонусных токенов.

  bonus-rule list                                              все версии всех правил
  bonus-rule new-version <код> [--kind <вид>] --params '<json>' новая версия, неактивная
  bonus-rule activate <код> <версия>                           сделать версию действующей
  bonus-rule deactivate <код>                                  оставить правило без действующей версии

Вид (${KINDS}) нужен только для первой версии кода и должен совпадать с видом прежних.
Токены в параметрах — строкой: {"tokens": "150"}.`;

// the code is inlined nowhere, but it is printed and keyed on: a plain identifier
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const VERSION_PATTERN = /^[1-9]\d{0,8}$/;

type Parsed =
  | { command: 'list' }
  | { command: 'new-version'; code: string; kind?: BonusRuleKind; params: unknown }
  | { command: 'activate'; code: string; version: number }
  | { command: 'deactivate'; code: string };

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export function parseBonusRuleArgs(argv: readonly string[]): Parsed {
  let values: { kind?: string; params?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { kind: { type: 'string' }, params: { type: 'string' } },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const [command, code, version, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError('лишние аргументы');
  if (command === undefined) throw new UsageError('нет команды');
  if (command === 'list') {
    if (code !== undefined || values.kind !== undefined || values.params !== undefined) {
      throw new UsageError('list не принимает аргументов');
    }
    return { command };
  }
  if (command !== 'new-version' && command !== 'activate' && command !== 'deactivate') {
    throw new UsageError(`неизвестная команда: ${command}`);
  }
  if (code === undefined) throw new UsageError('нет кода правила');
  if (!CODE_PATTERN.test(code)) {
    throw new UsageError('код правила: латиница в нижнем регистре, цифры и _, до 64 символов');
  }
  if (command !== 'new-version' && (values.kind !== undefined || values.params !== undefined)) {
    throw new UsageError(`--kind и --params — только для new-version`);
  }
  if (command === 'deactivate') {
    if (version !== undefined) throw new UsageError('лишние аргументы');
    return { command, code };
  }
  if (command === 'activate') {
    if (version === undefined) throw new UsageError('нет номера версии');
    if (!VERSION_PATTERN.test(version)) throw new UsageError('версия — целое число от 1');
    return { command, code, version: Number(version) };
  }
  if (version !== undefined) throw new UsageError('лишние аргументы');
  if (values.kind !== undefined && !isBonusRuleKind(values.kind)) {
    throw new UsageError(`--kind: один из ${KINDS}`);
  }
  if (values.params === undefined) throw new UsageError("нужен --params '<json>'");
  let params: unknown;
  try {
    params = JSON.parse(values.params);
  } catch {
    throw new UsageError('--params: не JSON');
  }
  return {
    command,
    code,
    ...(values.kind === undefined ? {} : { kind: values.kind as BonusRuleKind }),
    params,
  };
}

const window = (row: BonusRuleRow) => {
  if (row.validFrom === null && row.validTo === null) return '';
  const from = row.validFrom === null ? '' : ` с ${row.validFrom.toISOString()}`;
  const to = row.validTo === null ? '' : ` по ${row.validTo.toISOString()}`;
  return `,${from}${to}`;
};

export function describeBonusRule(row: BonusRuleRow): string {
  const state = row.isActive ? 'действует' : 'не действует';
  return `${row.code} v${row.version} (${row.kind}) — ${state}${window(row)}: ${JSON.stringify(row.params)}`;
}

export async function runBonusRuleCli(
  argv: readonly string[],
  source: NodeJS.ProcessEnv,
  print: (line: string) => void,
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseBonusRuleArgs(argv);
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
    return await execute(db, parsed, print);
  } catch (error) {
    // one door for every failure; a lost commit acknowledgement leaves the state unknown
    print(
      parsed.command === 'list'
        ? `Не удалось прочитать правила: ${formatFailure(error)}.`
        : `Не удалось выполнить команду: ${formatFailure(error)}. Состояние могло измениться — проверьте командой list.`,
    );
    return EXIT_FAILED;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function execute(
  db: ReturnType<typeof createDb>,
  parsed: Parsed,
  print: (line: string) => void,
): Promise<number> {
  switch (parsed.command) {
    case 'list': {
      const rows = await listBonusRules(db);
      if (rows.length === 0) print('Правил нет.');
      for (const row of rows) print(describeBonusRule(row));
      return EXIT_OK;
    }
    case 'new-version': {
      const result = await createBonusRuleVersion(db, parsed);
      if (result.ok) {
        print(
          `Создана версия ${result.row.code} v${result.row.version}, неактивная. Включить: bonus-rule activate ${result.row.code} ${result.row.version}`,
        );
        return EXIT_OK;
      }
      if (result.reason === 'kind_required') {
        print(`У правила ${parsed.code} ещё нет версий: нужен --kind (${KINDS}).`);
      } else if (result.reason === 'kind_mismatch') {
        print(`Правило ${parsed.code} — вида ${result.kind}; --kind должен совпадать.`);
      } else {
        print(`Параметры отклонены: ${result.problem}.`);
      }
      return EXIT_FAILED;
    }
    case 'activate': {
      const result = await activateBonusRuleVersion(db, parsed);
      if (result.ok) {
        const previous =
          result.previousVersion === null ? '' : ` (вместо v${result.previousVersion})`;
        print(
          `Действует ${parsed.code} v${parsed.version}${previous}. Уже начисленное не пересчитывается.`,
        );
        return EXIT_OK;
      }
      if (result.reason === 'not_found') {
        print(`Версии ${parsed.code} v${parsed.version} нет.`);
      } else if (result.reason === 'already_active') {
        print(`${parsed.code} v${parsed.version} уже действует.`);
      } else {
        print(`Параметры версии не проходят проверку: ${result.problem}.`);
      }
      return EXIT_FAILED;
    }
    case 'deactivate': {
      const result = await deactivateBonusRule(db, parsed);
      if (result.ok) {
        print(
          `${parsed.code} v${result.row.version} больше не действует; начисления по правилу остановлены.`,
        );
        return EXIT_OK;
      }
      print(
        result.reason === 'not_found'
          ? `Правила ${parsed.code} нет.`
          : `У правила ${parsed.code} нет действующей версии.`,
      );
      return EXIT_FAILED;
    }
  }
}

// The module is imported by its tests, so the command only runs when this file is what node was
// started with. `pnpm --filter @binarius/backend bonus-rule …` resolves to exactly that.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const code = await runBonusRuleCli(process.argv.slice(2), process.env, (line) => {
    process.stdout.write(`${line}\n`);
  });
  process.exit(code);
}
