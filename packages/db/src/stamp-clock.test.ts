import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, PgDialect, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema/index';

// #158: a column a CHECK orders against its row's created_at is written with statementNow(),
// never the transaction's or the process's clock (schema/columns.ts -> statementNow). The columns
// come from the schema's CHECKs; the writes are found by two regexes over the non-test sources of
// packages/*/src, apps/*/src and packages/db/drizzle/*.sql:
//   (a) an object key, `revokedAt: <value>`, where the value is sql`...`, sql.raw(...), new Date,
//       Date.now or statementNow() - projections and interfaces (`lastSeenAt: t.lastSeenAt`,
//       `lastSeenAt: Date;`) are not writes and do not match;
//   (b) an assignment in SQL text, `revoked_at = <value>` or `${t.revokedAt} = <value>`, the value
//       running to a comma or a closing parenthesis at depth 0, or to the end of the line.
// Not seen (enforcement is partial, Architecture Rules -> Rule 51): a value held in a variable or
// helper in form (a), sql.raw with a variable, a .set() object built elsewhere, a spread or a
// computed key, the tuple form `set (a, b) = (...)`, a raw value spanning lines, .defaultNow() and
// INSERT defaults, raw INSERT ... VALUES, PL/pgSQL `:=`, a quoted key, and a write outside those
// directories. A same-named column of another table (auth_sessions.revoked_at, no CHECK) and
// `where col = now()` are false positives: the test goes red and a person looks; moving such a
// write to statementNow() is harmless.

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

const CLOCKS =
  /\b(now|transaction_timestamp|statement_timestamp|clock_timestamp)\s*\(\s*\)|\b(current_timestamp|localtimestamp)\b|\bnew Date\b|\bDate\.now\b/i;

interface StampedColumn {
  table: string;
  column: string;
  key: string;
}

function stampedColumns(): StampedColumn[] {
  const dialect = new PgDialect();
  const found: StampedColumn[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    const keys = new Map(
      Object.entries(getTableColumns(value)).map(([key, column]) => [column.name, key]),
    );
    for (const check of config.checks) {
      const text = dialect.sqlToQuery(check.value).sql;
      const columns = [
        ...[...text.matchAll(/"(\w+)"\."(\w+)"\s*>=\s*"\1"\."created_at"/g)].map((m) => m[2]),
        ...[...text.matchAll(/"(\w+)"\."created_at"\s*<=\s*"\1"\."(\w+)"/g)].map((m) => m[2]),
      ];
      for (const column of columns) {
        const key = column === undefined ? undefined : keys.get(column);
        if (column === undefined || key === undefined) {
          throw new Error(`${config.name}: CHECK ${check.name} names no column of the table`);
        }
        found.push({ table: config.name, column, key });
      }
    }
  }
  return found;
}

function sourceFiles(): string[] {
  return execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'packages/*/src/*',
      'apps/*/src/*',
      'packages/db/drizzle/*.sql',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .split('\n')
    .filter(
      (file) =>
        ((file.endsWith('.ts') && !file.endsWith('.test.ts')) || file.endsWith('.sql')) &&
        existsSync(path.join(repoRoot, file)),
    );
}

// the value of a SQL assignment: up to a comma or a closing parenthesis at depth 0, or the line's end
function sqlValue(source: string, from: number): string {
  let depth = 0;
  let end = from;
  for (; end < source.length; end++) {
    const ch = source[end];
    if (ch === '\n') break;
    if (ch === '(' || ch === '{') depth++;
    else if (ch === ')' || ch === '}') {
      if (depth === 0) break;
      depth--;
    } else if (ch === ',' && depth === 0) break;
  }
  return source.slice(from, end).trim();
}

interface Write {
  at: string;
  column: string;
  value: string;
}

function writes(columns: StampedColumn[]): Write[] {
  const unique = new Map(columns.map((c) => [`${c.column}:${c.key}`, c]));
  const found: Write[] = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(path.join(repoRoot, file), 'utf8');
    const lineOf = (index: number) => source.slice(0, index).split('\n').length;
    for (const { column, key } of unique.values()) {
      const objectForm = new RegExp(
        String.raw`\b${key}\s*:\s*(sql\x60[^\x60]*\x60|sql\.raw\([^\n]*|new Date\b[^,}\n]*|Date\.now\b[^,}\n]*|statementNow\(\))`,
        'g',
      );
      for (const m of source.matchAll(objectForm)) {
        found.push({ at: `${file}:${lineOf(m.index)}`, column, value: m[1] ?? '' });
      }
      const sqlForm = new RegExp(String.raw`(\b${column}\b|\$\{\w+\.${key}\})\s*=(?!=)\s*`, 'g');
      for (const m of source.matchAll(sqlForm)) {
        found.push({
          at: `${file}:${lineOf(m.index)}`,
          column,
          value: sqlValue(source, m.index + m[0].length),
        });
      }
    }
  }
  return found;
}

describe('stamps a CHECK orders against created_at (#158)', () => {
  const columns = stampedColumns();
  const found = writes(columns);

  it('derives the stamped columns from the schema', () => {
    expect(
      columns.map((c) => `${c.table}.${c.column}`).sort(),
      'a new CHECK of this form: add the column here and its writer to stamp-clock.db.test.ts',
    ).toEqual([
      'oauth_states.used_at',
      'staff_login_challenges.code_sent_at',
      'staff_login_challenges.confirmed_at',
      'staff_login_challenges.prompt_sent_at',
      'staff_login_links.used_at',
      'staff_sessions.last_seen_at',
      'staff_sessions.revoked_at',
    ]);
  });

  it('finds no stamped column written from the transaction or process clock', () => {
    const refused = found
      .filter((w) => CLOCKS.test(w.value) || !w.value.includes('statementNow()'))
      .map(
        (w) =>
          `${w.at} ${w.column} <- ${w.value}${CLOCKS.test(w.value) ? '' : ' (unrecognized stamp value)'}`,
      );
    expect(refused, 'write these columns with statementNow() (schema/columns.ts)').toEqual([]);
  });

  it('counts the writes of every stamped column', () => {
    const counts: Record<string, number> = {};
    for (const w of found) counts[w.column] = (counts[w.column] ?? 0) + 1;
    expect(
      counts,
      'a new or removed writer of a stamped column: update this pin and stamp-clock.db.test.ts',
    ).toEqual({
      used_at: 2,
      confirmed_at: 1,
      prompt_sent_at: 1,
      code_sent_at: 1,
      last_seen_at: 1,
      revoked_at: 3,
    });
  });
});
