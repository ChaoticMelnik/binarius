import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeServiceChildLines, composeServiceEnv, composeServiceValue } from '../compose-text';

// The backup scripts (docs/backups.md) run under `sh` against stand-ins for pg_dump, pg_restore,
// psql, pg_isready, age, rclone and curl on PATH. rclone's stand-in keeps the remote as a
// directory tree, so listings, copies and purges act on what the scripts wrote. The scripts on a
// real Postgres 18 with the real tools are the CI compose job's (docs/backups.md -> Tests).

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const here = import.meta.dirname;
const script = (name: string): string => path.join(here, name);

const RECIPIENT = 'age1testrecipient';
const IDENTITY = 'AGE-SECRET-KEY-1TESTIDENTITY';
const PING = 'https://hc-ping.example/check';
const REMOTE = 'backup:bucket/pilot';

const SHIMS: Record<string, string> = {
  pg_isready: `
log "pg_isready $*"
fails pg_isready && exit 2
exit 0`,
  pg_dump: `
log "pg_dump $*"
db="$PGDATABASE"; schema_only=''
while [ $# -gt 0 ]; do
  case "$1" in -d) db="$2"; shift ;; -s) schema_only=1 ;; esac
  shift
done
if [ -n "$schema_only" ]; then
  fails pg_dump-schema && exit 1
  printf '\\\\restrict token%s\\n-- Dumped from database version 18.6\\n' "$$"
  case "$db" in
    "$PGDATABASE") echo 'CREATE TRIGGER t WHEN (((a) OR (b)) OR (c));' ;;
    *_restore_check_schema) echo "CREATE TRIGGER t WHEN ((a) OR (b) OR (c));\${SHIM_SCHEMA_DIFF:+ -- lost}" ;;
    *) echo 'CREATE TRIGGER t WHEN ((a) OR (b) OR (c));' ;;
  esac
  printf '\\\\unrestrict token%s\\n' "$$"
  exit 0
fi
if fails pg_dump; then printf 'PGDMP partial'; exit 1; fi
if [ -n "\${SHIM_DUMP_TINY:-}" ]; then printf 'PGDMP'; exit 0; fi
i=0
while [ "$i" -lt 20 ]; do echo 'PGDMP a line of the custom-format archive, about fifty bytes'; i=$((i + 1)); done`,
  pg_restore: `
log "pg_restore $*"
cat > "$SHIM_DIR/restored"
fails pg_restore && exit 1
exit 0`,
  psql: `
line="psql $(printf '%s ' "$@" | tr '\\n' ' ')"
sql="$(printf '%s ' "$@")"
file=''
prev=''
for a in "$@"; do
  if [ "$prev" = -f ]; then file="$a"; fi
  prev="$a"
done
case "$sql" in
  *' -c '*) ;;
  *) if [ -z "$file" ]; then stdin="$(cat)"; line="$line<<< $(printf '%s' "$stdin" | tr '\\n' ' ')"; sql="$stdin"; fi ;;
esac
log "$line"
if [ -n "$file" ]; then
  fails psql-schema-load && exit 3
  exit 0
fi
case "$sql" in
  *pg_database_size*) echo "\${SHIM_DB_SIZE:-1000}" ;;
  *pg_stat_activity*) echo "\${SHIM_PSQL_CONNECTIONS:-0}" ;;
  *__drizzle_migrations*) echo '85|1761000000000' ;;
  *query_to_xml*) printf 'staff 1\\nusers 0\\n' ;;
  *'alter database'*) fails psql-rename && exit 3 ;;
esac
exit 0`,
  age: `
log "age $*"
if [ "$1" = -d ]; then
  cp "$3" "$SHIM_DIR/identity.seen"
  ls -l "$3" | cut -c1-10 > "$SHIM_DIR/identity.mode"
  fails age-decrypt && exit 1
  sed 1d
  exit 0
fi
fails age-encrypt && exit 1
echo 'age-encryption.org/v1'
cat`,
  rclone: `
log "rclone $*"
sub="$1"; shift
[ "$sub" != copy ] && fails "rclone-$sub" && exit 3
dirs=''; files=''; recursive=''; depth=1; min_age=''; set_args=''
for a in "$@"; do
  case "$prev" in --max-depth) depth="$a" ;; --min-age) min_age="$a" ;; esac
  prev="$a"
  case "$a" in
    --dirs-only) dirs=1 ;; --files-only) files=1 ;; -R) recursive=1 ;;
    --max-depth|--min-age|--leave-root|[0-9]*) ;;
    backup:*) set_args="$set_args $SHIM_STORE/\${a#backup:}" ;;
  esac
done
set -- $set_args
case "$sub" in
  rcat) mkdir -p "$(dirname "$1")"; cat > "$1" ;;
  lsl)
    [ -f "$1" ] || exit 3
    size="$(wc -c < "$1" | tr -d ' ')"
    if [ -n "\${SHIM_LSL_SIZE_MISMATCH:-}" ]; then size=$((size + 1)); fi
    printf '%9s 2026-10-09 03:00:00.000000000 %s\\n' "$size" "$(basename "$1")" ;;
  lsf)
    [ -d "$1" ] || exit 3
    cd "$1"
    if [ -n "$recursive" ] && [ -n "$files" ]; then
      find . -mindepth 1 -maxdepth "$depth" -type f | sed 's,^\\./,,' | sort
    elif [ -n "$recursive" ]; then
      find . -mindepth 1 -maxdepth "$depth" -type d | sed 's,^\\./,,; s,$,/,' | sort
    elif [ -n "$dirs" ]; then
      for x in *; do if [ -d "$x" ]; then echo "$x/"; fi; done
    elif [ -n "$min_age" ] && [ -z "\${SHIM_STALE:-}" ]; then
      :
    else
      for x in *; do if [ -f "$x" ]; then echo "$x"; fi; done
    fi ;;
  copy)
    mkdir -p "$2"
    # a copy cut off after its first object
    if fails rclone-copy; then cp "$1/env.age" "$2/"; exit 3; fi
    cp -R "$1/." "$2/" ;;
  purge) [ -d "$1" ] || exit 3; rm -rf "$1" ;;
  cat) [ -f "$1" ] || exit 3; cat "$1" ;;
esac
exit 0`,
  curl: `
log "curl $*"
log "curl-config $(cat)"
fails curl && exit 7
exit 0`,
};

const PRELUDE = `#!/bin/sh
log() { printf '%s\\n' "$1" >> "$SHIM_LOG"; }
fails() { case " \${SHIM_FAIL:-} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
`;

let root = '';
let shims = '';
let caseNumber = 0;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'backup-test-'));
  shims = path.join(root, 'bin');
  mkdirSync(shims);
  for (const [name, body] of Object.entries(SHIMS)) {
    const file = path.join(shims, name);
    writeFileSync(file, PRELUDE + body + '\n');
    chmodSync(file, 0o755);
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Case {
  dir: string;
  store: string;
  tmp: string;
  state: string;
  envMount: string;
}

function newCase(): Case {
  caseNumber += 1;
  const dir = path.join(root, `case-${caseNumber}`);
  const c = {
    dir,
    store: path.join(dir, 'store'),
    tmp: path.join(dir, 'tmp'),
    state: path.join(dir, 'state'),
    envMount: path.join(dir, 'env'),
  };
  for (const d of [c.store, c.tmp, c.state]) mkdirSync(d, { recursive: true });
  writeFileSync(c.envMount, 'TOKEN_ENCRYPTION_KEY=abc\nOTHER=1\n');
  return c;
}

interface Result {
  status: number;
  stdout: string;
  stderr: string;
  calls: string[];
}

function run(
  c: Case,
  file: string,
  args: string[] = [],
  env: Record<string, string | undefined> = {},
): Result {
  const base: Record<string, string | undefined> = {
    PATH: `${shims}:/usr/bin:/bin`,
    TMPDIR: c.tmp,
    PGDATABASE: 'binarius',
    BACKUP_REMOTE_PATH: 'bucket/pilot',
    RCLONE_CONFIG_BACKUP_TYPE: 'local',
    BACKUP_AGE_RECIPIENT: RECIPIENT,
    BACKUP_AGE_IDENTITY: IDENTITY,
    BACKUP_ENV_FILE: '/opt/binarius/.env',
    BACKUP_PING_URL: PING,
    BACKUP_STATE_DIR: c.state,
    BACKUP_ENV_MOUNT: c.envMount,
    SHIM_LOG: path.join(c.dir, 'calls.log'),
    SHIM_STORE: c.store,
    SHIM_DIR: c.dir,
  };
  const merged = Object.fromEntries(
    Object.entries({ ...base, ...env }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const result = spawnSync('sh', [script(file), ...args], { env: merged, encoding: 'utf8' });
  const log = path.join(c.dir, 'calls.log');
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
  };
}

// each step matches a call after the calls the previous step matched; a step that is a list
// is one pipeline, whose stages start together and log in any order
function expectInOrder(calls: string[], steps: (RegExp | RegExp[])[]): void {
  let from = 0;
  for (const step of steps) {
    let next = from;
    for (const pattern of Array.isArray(step) ? step : [step]) {
      const index = calls.findIndex((call, i) => i >= from && pattern.test(call));
      expect(index, `${pattern} after call ${from}:\n${calls.join('\n')}`).toBeGreaterThanOrEqual(
        0,
      );
      next = Math.max(next, index + 1);
    }
    from = next;
  }
}

const matching = (calls: string[], pattern: RegExp): string[] =>
  calls.filter((call) => pattern.test(call));

// the URL reaches curl on stdin (a config line), never in its argv
const CURL_ARGV = 'curl -fsS -m 10 --retry 2 -o /dev/null -K -';
const pings = (calls: string[]): string[] =>
  calls
    .filter((call) => call.startsWith('curl-config '))
    .map((call) => call.slice('curl-config '.length));

const runOf = (stdout: string): string =>
  /binarius-\d{8}T\d{6}Z/.exec(stdout)?.[0] ?? 'no run in the output';

function utcDateKey(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');
}

function putRun(c: Case, tier: string, run: string, dump = 'DUMP'): void {
  const dir = path.join(c.store, 'bucket/pilot', tier, run);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'binarius.dump.age'), `age-encryption.org/v1\n${dump}\n`);
  writeFileSync(path.join(dir, 'env.age'), 'age-encryption.org/v1\nTOKEN_ENCRYPTION_KEY=abc\n');
}

describe('backup.sh', () => {
  it('B1 dumps, encrypts, uploads and verifies both objects, copies the day, prunes, pings once', () => {
    const c = newCase();
    const before = Math.floor(Date.now() / 1000) * 1000;
    const r = run(c, 'backup.sh');
    const after = Date.now();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /^backup ok: binarius-\d{8}T\d{6}Z, dump \d+ bytes, env \d+ bytes, daily copied, \d+ s\n$/,
    );
    const runName = runOf(r.stdout);
    const [, year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = (
      /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(runName) ?? []
    ).map(Number);
    const runTime = Date.UTC(year, month - 1, day, hour, minute, second);
    expect(runTime).toBeGreaterThanOrEqual(before);
    expect(runTime).toBeLessThanOrEqual(after);
    const hourly = `${REMOTE}/hourly/${runName}`;
    expectInOrder(r.calls, [
      /^pg_isready -q$/,
      [
        /^pg_dump --format=custom$/,
        new RegExp(`^age -r ${RECIPIENT}$`),
        new RegExp(`^rclone rcat ${hourly}/binarius\\.dump\\.age$`),
      ],
      new RegExp(`^rclone lsl ${hourly}/binarius\\.dump\\.age$`),
      [new RegExp(`^age -r ${RECIPIENT}$`), new RegExp(`^rclone rcat ${hourly}/env\\.age$`)],
      new RegExp(`^rclone lsl ${hourly}/env\\.age$`),
      new RegExp(`^rclone lsf --files-only -R --max-depth 3 ${REMOTE}$`),
      new RegExp(`^rclone copy ${hourly} ${REMOTE}/daily/${runName}$`),
      new RegExp(`^rclone delete --min-age 7d ${REMOTE}/hourly$`),
      new RegExp(`^rclone rmdirs --leave-root ${REMOTE}/hourly$`),
      new RegExp(`^rclone delete --min-age 30d ${REMOTE}/daily$`),
      new RegExp(`^rclone rmdirs --leave-root ${REMOTE}/daily$`),
      /^curl /,
    ]);
    expect(matching(r.calls, /^curl /)).toEqual([CURL_ARGV]);
    expect(pings(r.calls)).toEqual([`url = "${PING}"`]);
    expect(matching(r.calls, /^curl .*hc-ping/)).toEqual([]);
    expect(matching(r.calls, /^rclone purge /)).toEqual([]);
    expect(existsSync(path.join(c.state, 'ok'))).toBe(true);
    const stored = path.join(c.store, 'bucket/pilot');
    expect(readFileSync(path.join(stored, 'hourly', runName, 'env.age'), 'utf8')).toBe(
      'age-encryption.org/v1\nTOKEN_ENCRYPTION_KEY=abc\nOTHER=1\n',
    );
    expect(readdirSync(path.join(stored, 'daily', runName)).sort()).toEqual([
      'binarius.dump.age',
      'env.age',
    ]);
    const dumpBytes = /dump (\d+) bytes/.exec(r.stdout)?.[1];
    expect(dumpBytes).toBe(
      String(statSync(path.join(stored, 'hourly', runName, 'binarius.dump.age')).size),
    );
    expect(readdirSync(c.tmp)).toEqual([]);
  });

  it.each([
    ['B2', 'pg_dump', 'dump (exit 1)'],
    ['B3', 'rclone-rcat', 'upload (exit 3)'],
    ['B10', 'age-encrypt', 'encrypt (exit 1)'],
  ])(
    '%s a failed %s stops the run before anything is verified or pruned',
    (_id, failing, reason) => {
      const c = newCase();
      const r = run(c, 'backup.sh', [], { SHIM_FAIL: failing });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe(`backup failed: ${reason}\n`);
      expect(matching(r.calls, /^rclone (lsl|delete|copy|lsf) /)).toEqual([]);
      expect(pings(r.calls)).toEqual([`url = "${PING}/fail"`]);
      expect(matching(r.calls, /^rclone purge /)).toEqual([
        expect.stringMatching(
          new RegExp(`^rclone purge ${REMOTE}/hourly/binarius-\\d{8}T\\d{6}Z$`),
        ),
      ]);
      expect(existsSync(path.join(c.state, 'ok'))).toBe(false);
      const hourly = path.join(c.store, 'bucket/pilot/hourly');
      expect(existsSync(hourly) ? readdirSync(hourly) : []).toEqual([]);
      if (failing === 'rclone-rcat') {
        // nothing was stored, so the purge itself fails: a warning, the reason stays the upload's
        expect(r.stderr).toContain('backup warn: the partial run was not removed (exit 3)');
      }
    },
  );

  it('B4 a stored size that differs from the bytes sent fails the run and removes it', () => {
    const c = newCase();
    const r = run(c, 'backup.sh', [], { SHIM_LSL_SIZE_MISMATCH: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(
      /^backup failed: verify \(binarius\.dump\.age: (\d+) bytes stored, \d+ sent\)\n$/,
    );
    const [, stored, sent] = /(\d+) bytes stored, (\d+) sent/.exec(r.stdout) ?? [];
    expect(Number(stored)).toBe(Number(sent) + 1);
    expect(matching(r.calls, /^rclone (delete|copy) /)).toEqual([]);
    expect(matching(r.calls, /^rclone purge /)).toHaveLength(1);
    expect(readdirSync(path.join(c.store, 'bucket/pilot/hourly'))).toEqual([]);
    expect(pings(r.calls)).toEqual([`url = "${PING}/fail"`]);
  });

  it('B5 pings nothing without BACKUP_PING_URL', () => {
    const c = newCase();
    const r = run(c, 'backup.sh', [], { BACKUP_PING_URL: undefined });
    expect(r.status).toBe(0);
    expect(matching(r.calls, /^curl /)).toEqual([]);
  });

  it('B6 does not copy the day again when daily/ already holds a run of that date', () => {
    const c = newCase();
    for (const offset of [0, 1]) putRun(c, 'daily', `binarius-${utcDateKey(offset)}T000000Z`);
    const r = run(c, 'backup.sh');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/, daily exists, \d+ s\n$/);
    expect(matching(r.calls, /^rclone copy /)).toEqual([]);
  });

  it('B7 refuses before pg_isready when BACKUP_ENV_FILE is set and the mounted file is empty', () => {
    const c = newCase();
    writeFileSync(c.envMount, '');
    const r = run(c, 'backup.sh');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(
      /^backup failed: env \(BACKUP_ENV_FILE is set, but .* is not a non-empty file\)\n$/,
    );
    expect(r.calls).toEqual([CURL_ARGV, `curl-config url = "${PING}/fail"`]);
  });

  it.each([
    ['BACKUP_REMOTE_PATH', { BACKUP_REMOTE_PATH: '' }],
    ['BACKUP_AGE_RECIPIENT', { BACKUP_AGE_RECIPIENT: undefined }],
    [
      'RCLONE_CONFIG_BACKUP_ACCOUNT',
      { RCLONE_CONFIG_BACKUP_TYPE: 'b2', RCLONE_CONFIG_BACKUP_KEY: 'k' },
    ],
    [
      'RCLONE_CONFIG_BACKUP_KEY',
      { RCLONE_CONFIG_BACKUP_TYPE: 'b2', RCLONE_CONFIG_BACKUP_ACCOUNT: 'a' },
    ],
  ])('B8 refuses a missing or empty %s by name, calling nothing but the fail ping', (name, env) => {
    const c = newCase();
    const r = run(c, 'backup.sh', [], env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(`backup failed: config (${name})\n`);
    expect(r.calls).toEqual([CURL_ARGV, `curl-config url = "${PING}/fail"`]);
  });

  it('B9 a failed prune after a stored run fails the run, keeps it and leaves no marker', () => {
    const c = newCase();
    const r = run(c, 'backup.sh', [], { SHIM_FAIL: 'rclone-delete' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('backup failed: prune (hourly, exit 3)\n');
    expect(matching(r.calls, /^rclone purge /)).toEqual([]);
    expect(readdirSync(path.join(c.store, 'bucket/pilot/hourly'))).toHaveLength(1);
    expect(existsSync(path.join(c.state, 'ok'))).toBe(false);
    expect(pings(r.calls)).toEqual([`url = "${PING}/fail"`]);
  });

  it('B11 the ok line ends with the run time in seconds', () => {
    const c = newCase();
    const r = run(c, 'backup.sh', [], { BACKUP_ENV_FILE: undefined });
    expect(r.stdout).toMatch(
      /^backup ok: binarius-\d{8}T\d{6}Z, dump \d+ bytes, env none, daily copied, \d+ s\n$/,
    );
  });

  const putDaily = (c: Case, objects: string[]): void => {
    const dir = path.join(c.store, 'bucket/pilot/daily', `binarius-${utcDateKey(0)}T000000Z`);
    mkdirSync(dir, { recursive: true });
    for (const object of objects) writeFileSync(path.join(dir, object), 'age-encryption.org/v1\n');
  };

  it('B12 copies the day again when its daily/ directory holds no dump', () => {
    const c = newCase();
    putDaily(c, ['env.age']);
    const r = run(c, 'backup.sh');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/, daily copied, \d+ s\n$/);
    const copy = path.join(c.store, 'bucket/pilot/daily', runOf(r.stdout));
    expect(readdirSync(copy).sort()).toEqual(['binarius.dump.age', 'env.age']);
  });

  it.each([
    ['B13a', '/opt/binarius/.env', 'daily copied', 1],
    ['B13b', undefined, 'daily exists', 0],
  ])(
    '%s a day copy holding only the dump, BACKUP_ENV_FILE %s: %s',
    (_id, envFile, daily, copies) => {
      const c = newCase();
      putDaily(c, ['binarius.dump.age']);
      const r = run(c, 'backup.sh', [], { BACKUP_ENV_FILE: envFile });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`, ${daily}, \\d+ s\\n$`));
      expect(matching(r.calls, /^rclone copy /)).toHaveLength(copies);
    },
  );

  it('B15 a failed day copy is removed, fails the run and keeps the hourly run', () => {
    const c = newCase();
    const r = run(c, 'backup.sh', [], { SHIM_FAIL: 'rclone-copy' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('backup failed: daily (exit 3)\n');
    const runName = runOf(r.calls.find((call) => call.startsWith('rclone copy ')) ?? '');
    expect(matching(r.calls, /^rclone purge /)).toEqual([
      `rclone purge ${REMOTE}/daily/${runName}`,
    ]);
    expect(existsSync(path.join(c.store, 'bucket/pilot/daily', runName))).toBe(false);
    expect(readdirSync(path.join(c.store, 'bucket/pilot/hourly', runName)).sort()).toEqual([
      'binarius.dump.age',
      'env.age',
    ]);
    expect(existsSync(path.join(c.state, 'ok'))).toBe(false);
    expect(pings(r.calls)).toEqual([`url = "${PING}/fail"`]);
  });

  it('B16 a dump object below the floor fails verify and removes the run', () => {
    const c = newCase();
    const r = run(c, 'backup.sh', [], { SHIM_DUMP_TINY: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(
      /^backup failed: verify \(binarius\.dump\.age: \d+ bytes, below 512\)\n$/,
    );
    expect(matching(r.calls, /^rclone purge /)).toEqual([
      expect.stringMatching(new RegExp(`^rclone purge ${REMOTE}/hourly/binarius-\\d{8}T\\d{6}Z$`)),
    ]);
    expect(pings(r.calls)).toEqual([`url = "${PING}/fail"`]);
  });
});

describe('restore-check.sh', () => {
  const OLDER = 'binarius-20261009T020000Z';
  const LATEST = 'binarius-20261009T030000Z';
  const withRuns = (): Case => {
    const c = newCase();
    putRun(c, 'hourly', OLDER, 'OLDER');
    putRun(c, 'hourly', LATEST, 'LATEST');
    return c;
  };
  const dropBoth = [
    /^psql -X -q -d postgres -c drop database if exists "binarius_restore_check" with \(force\) $/,
    /^psql -X -q -d postgres -c drop database if exists "binarius_restore_check_schema" with \(force\) $/,
  ];
  const expectBothDroppedLast = (calls: string[]): void => {
    expect(calls.slice(-2).map((call, i) => dropBoth[i]?.test(call))).toEqual([true, true]);
  };

  it('R1 restores the latest run and compares it with the live schema loaded into a second database', () => {
    const c = withRuns();
    const r = run(c, 'restore-check.sh');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('rows staff 1\nrows users 0\n');
    expect(r.stdout).toMatch(
      new RegExp(
        `restore-check ok: ${LATEST}, 2 tables, schema identical, migrations 85, env ok\\n$`,
      ),
    );
    expectInOrder(r.calls, [
      new RegExp(`^rclone lsf --dirs-only ${REMOTE}/hourly$`),
      new RegExp(`^rclone lsf --files-only --min-age 130m ${REMOTE}/hourly/${LATEST}$`),
      [new RegExp(`^rclone cat ${REMOTE}/hourly/${LATEST}/env\\.age$`), /^age -d -i \S+$/],
      /drop database if exists "binarius_restore_check" with \(force\) -c drop database if exists "binarius_restore_check_schema" with \(force\) -c create database "binarius_restore_check"/,
      [
        new RegExp(`^rclone cat ${REMOTE}/hourly/${LATEST}/binarius\\.dump\\.age$`),
        /^age -d -i \S+$/,
        /^pg_restore --exit-on-error --no-owner --no-privileges -d binarius_restore_check$/,
      ],
      /^pg_dump -s --no-owner --no-privileges -d binarius$/,
      /-d postgres -c create database "binarius_restore_check_schema" $/,
      /^psql -X -q -v ON_ERROR_STOP=1 -d binarius_restore_check_schema -f \S+ $/,
      /^pg_dump -s --no-owner --no-privileges -d binarius_restore_check$/,
      /^pg_dump -s --no-owner --no-privileges -d binarius_restore_check_schema$/,
      /^psql -X -At -c select count\(\*\), max\(created_at\) from drizzle\.__drizzle_migrations $/,
      /^psql -X -At -d binarius_restore_check -c select count/,
      /query_to_xml/,
      ...dropBoth,
    ]);
    expectBothDroppedLast(r.calls);
    expect(readFileSync(path.join(c.dir, 'restored'), 'utf8')).toBe('LATEST\n');
    expect(readFileSync(path.join(c.dir, 'identity.seen'), 'utf8')).toBe(`${IDENTITY}\n`);
    expect(readFileSync(path.join(c.dir, 'identity.mode'), 'utf8')).toBe('-rw-------\n');
    expect(readdirSync(c.tmp)).toEqual([]);
    expect(matching(r.calls, /^curl /)).toEqual([]);
  });

  it('R2 fails as no-backups when the remote has no hourly/ at all', () => {
    const c = newCase();
    const r = run(c, 'restore-check.sh');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('restore-check failed: no-backups (exit 3)\n');
    expect(pings(r.calls)).toEqual([`url = "${PING}/fail"`]);
    expect(matching(r.calls, /create database/)).toEqual([]);
  });

  it('R2b fails as no-backups, naming no exit code, when hourly/ is empty', () => {
    const c = newCase();
    mkdirSync(path.join(c.store, 'bucket/pilot/hourly'), { recursive: true });
    const r = run(c, 'restore-check.sh');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('restore-check failed: no-backups (hourly/ holds no run)\n');
  });

  it('R3 fails as stale when the latest dump is older than two hourly runs', () => {
    const c = withRuns();
    const r = run(c, 'restore-check.sh', [], { SHIM_STALE: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(`restore-check failed: stale (${LATEST} is older than 130m)\n`);
    expect(matching(r.calls, /create database/)).toEqual([]);
  });

  it('R4 a failed pg_restore still drops both scratch databases', () => {
    const c = withRuns();
    const r = run(c, 'restore-check.sh', [], { SHIM_FAIL: 'pg_restore' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('restore-check failed: restore (restore, exit 1)\n');
    expectBothDroppedLast(r.calls);
    expect(pings(r.calls)).toEqual([`url = "${PING}/fail"`]);
  });

  it('R5 a restored schema that differs fails with the first lines of the diff', () => {
    const c = withRuns();
    const r = run(c, 'restore-check.sh', [], { SHIM_SCHEMA_DIFF: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('-- lost');
    expect(r.stdout).toMatch(
      /restore-check failed: schema \(the restored schema differs from the live one loaded from its pg_dump -s\)\n$/,
    );
    expectBothDroppedLast(r.calls);
  });

  it('R6 skips above BACKUP_RESTORE_CHECK_MAX_BYTES without creating a database', () => {
    const c = withRuns();
    const r = run(c, 'restore-check.sh', [], { SHIM_DB_SIZE: '600000000' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /^restore-check skipped: the database is 600000000 bytes, above 524288000 /,
    );
    expect(matching(r.calls, /create database|^rclone /)).toEqual([]);
  });

  it('R7 refuses without BACKUP_AGE_IDENTITY, calling nothing', () => {
    const c = withRuns();
    const r = run(c, 'restore-check.sh', [], {
      BACKUP_AGE_IDENTITY: undefined,
      BACKUP_PING_URL: undefined,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('restore-check failed: config (BACKUP_AGE_IDENTITY)\n');
    expect(r.calls).toEqual([]);
  });

  it('R8 a live schema that does not load into the second database fails as schema and drops both', () => {
    const c = withRuns();
    const r = run(c, 'restore-check.sh', [], { SHIM_FAIL: 'psql-schema-load' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(
      'restore-check failed: schema (load the live schema into binarius_restore_check_schema, exit 3)\n',
    );
    expectBothDroppedLast(r.calls);
    expect(pings(r.calls)).toEqual([`url = "${PING}/fail"`]);
  });
});

describe('restore.sh', () => {
  const RUN = 'binarius-20261009T030000Z';

  it.each([
    ['no confirmation', undefined],
    ['another run confirmed', 'binarius-20261009T020000Z'],
  ])('RS1 refuses with %s before touching the database', (_label, confirm) => {
    const c = newCase();
    putRun(c, 'hourly', RUN);
    const r = run(c, 'restore.sh', [RUN], { BACKUP_RESTORE_CONFIRM: confirm });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(
      `restore refused: confirm: set BACKUP_RESTORE_CONFIRM=${RUN} to replace the live database with it\n`,
    );
    expect(r.calls).toEqual([]);
  });

  it('RS2 refuses while anything is connected to the live database', () => {
    const c = newCase();
    putRun(c, 'hourly', RUN);
    const r = run(c, 'restore.sh', [RUN], {
      BACKUP_RESTORE_CONFIRM: RUN,
      SHIM_PSQL_CONNECTIONS: '2',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(
      'restore refused: 2 connections to binarius - stop bot, backend, trading-worker and web first\n',
    );
    expect(matching(r.calls, /create database|^rclone |alter database/)).toEqual([]);
  });

  it('RS3 restores into binarius_restored, then swaps the names in one transaction', () => {
    const c = newCase();
    putRun(c, 'hourly', RUN, 'THE RUN');
    putRun(c, 'daily', RUN, 'DAILY COPY');
    const r = run(c, 'restore.sh', [RUN], { BACKUP_RESTORE_CONFIRM: RUN });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(
      new RegExp(
        `^restore ok: ${RUN} now serves as binarius; the previous database is binarius_before_restore_\\d{14} \\(drop it by hand when done\\)\\n$`,
      ),
    );
    expectInOrder(r.calls, [
      /pg_stat_activity where datname = 'binarius' and backend_type = 'client backend'/,
      new RegExp(`^rclone lsf --files-only -R --max-depth 3 ${REMOTE}$`),
      /drop database if exists "binarius_restored" with \(force\) -c create database "binarius_restored"/,
      [
        new RegExp(`^rclone cat ${REMOTE}/hourly/${RUN}/binarius\\.dump\\.age$`),
        /^age -d -i \S+$/,
        /^pg_restore --exit-on-error --no-owner --no-privileges -d binarius_restored$/,
      ],
      /<<< begin; alter database "binarius" rename to "binarius_before_restore_\d{14}"; alter database "binarius_restored" rename to "binarius"; commit;/,
    ]);
    expect(r.calls.at(-1)).toMatch(/alter database/);
    expect(readFileSync(path.join(c.dir, 'restored'), 'utf8')).toBe('THE RUN\n');
  });

  it('RS4 restores a run kept only in daily/', () => {
    const c = newCase();
    putRun(c, 'daily', RUN, 'DAILY ONLY');
    const r = run(c, 'restore.sh', [RUN], { BACKUP_RESTORE_CONFIRM: RUN });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^restore ok: ${RUN} now serves as binarius;`));
    expect(matching(r.calls, /^rclone cat /)).toEqual([
      `rclone cat ${REMOTE}/daily/${RUN}/binarius.dump.age`,
    ]);
    expect(readFileSync(path.join(c.dir, 'restored'), 'utf8')).toBe('DAILY ONLY\n');
  });

  it('RS6 a run without a dump in either tier is not-found, before any database is created', () => {
    const c = newCase();
    const dir = path.join(c.store, 'bucket/pilot/daily', RUN);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'env.age'), 'age-encryption.org/v1\n');
    const r = run(c, 'restore.sh', [RUN], { BACKUP_RESTORE_CONFIRM: RUN });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(
      `restore failed: not-found (${RUN} has no binarius.dump.age under hourly/ or daily/)\n`,
    );
    expect(matching(r.calls, /create database|drop database/)).toEqual([]);
  });

  it('RS7 refuses a PGDATABASE longer than 33 characters, calling nothing', () => {
    const c = newCase();
    putRun(c, 'hourly', RUN);
    const r = run(c, 'restore.sh', [RUN], {
      BACKUP_RESTORE_CONFIRM: RUN,
      PGDATABASE: 'a'.repeat(34),
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(
      'restore failed: config (PGDATABASE is not [a-z0-9_] of at most 33 characters)\n',
    );
    expect(r.calls).toEqual([]);
  });

  it('RS8 names the first stage of the pipeline that failed, and drops the restored copy', () => {
    const c = newCase();
    putRun(c, 'hourly', RUN);
    const r = run(c, 'restore.sh', [RUN], {
      BACKUP_RESTORE_CONFIRM: RUN,
      SHIM_FAIL: 'rclone-cat age-decrypt pg_restore',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('restore failed: restore (cat, exit 3)\n');
    expect(r.calls.at(-1)).toMatch(/drop database if exists "binarius_restored" with \(force\) $/);
  });

  it('RS9 a failed rename keeps binarius_restored for another try', () => {
    const c = newCase();
    putRun(c, 'hourly', RUN);
    const r = run(c, 'restore.sh', [RUN], {
      BACKUP_RESTORE_CONFIRM: RUN,
      SHIM_FAIL: 'psql-rename',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(
      'restore failed: rename (exit 3; binarius is unchanged, binarius_restored is kept for another try)\n',
    );
    expect(r.calls.at(-1)).toMatch(/alter database/);
  });
});

describe('fetch-env.sh', () => {
  const RUN = 'binarius-20261009T030000Z';
  const ENV = 'TOKEN_ENCRYPTION_KEY=abc\n';

  it.each([
    ['F1', 'hourly'],
    ['F2', 'daily'],
  ])('%s prints the .env of a run kept in %s/, and nothing else', (_id, tier) => {
    const c = newCase();
    putRun(c, tier, RUN);
    const r = run(c, 'fetch-env.sh', [RUN]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(ENV);
    expect(r.stderr).toBe('');
    expect(matching(r.calls, /^rclone cat /)).toEqual([
      `rclone cat ${REMOTE}/${tier}/${RUN}/env.age`,
    ]);
  });

  it('F3 a run in neither tier is not-found on stderr, with nothing on stdout', () => {
    const c = newCase();
    putRun(c, 'hourly', 'binarius-20261009T020000Z');
    const r = run(c, 'fetch-env.sh', [RUN]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(
      `fetch-env failed: not-found (${RUN} has no env.age under hourly/ or daily/)\n`,
    );
    expect(matching(r.calls, /^rclone cat /)).toEqual([]);
  });

  it('F4 answers a name that is not a run with the usage and 64, calling nothing', () => {
    const c = newCase();
    const r = run(c, 'fetch-env.sh', ['latest']);
    expect(r.status).toBe(64);
    expect(r.stderr).toBe('usage: fetch-env binarius-<YYYYmmddTHHMMSSZ>\n');
    expect(r.calls).toEqual([]);
  });
});

describe('entrypoint.sh and lib.sh', () => {
  it('E1 answers an unknown command with the usage and 64', () => {
    const c = newCase();
    const r = run(c, 'entrypoint.sh', ['nonsense']);
    expect(r.status).toBe(64);
    expect(r.stderr).toContain(
      'usage: loop | backup-now | restore-check | restore <run> | fetch-env <run> | age-keygen',
    );
    expect(r.calls).toEqual([]);
  });

  const lib = (expression: string): string =>
    spawnSync('sh', ['-c', `. "${script('lib.sh')}"; ${expression}`], {
      encoding: 'utf8',
    }).stdout.trimEnd();

  it.each([
    [0, '3600'],
    [1, '3599'],
    [3599, '1'],
    [1_761_620_400, '3600'],
  ])('E2 sleeps from epoch %i to the top of the next hour: %s s', (epoch, seconds) => {
    expect(lib(`seconds_until_next_hour ${epoch}`)).toBe(seconds);
  });

  it('E3 takes the UTC date of a run from its name', () => {
    expect(lib('date_key binarius-20261009T030000Z')).toBe('20261009');
  });

  it.each([
    ['0 0 0', ''],
    ['1 1 1', 'cat, exit 1'],
    ['141 1 1', 'decrypt, exit 1'],
    ['141 141 1', 'restore, exit 1'],
    ['141 0 0', 'cat, exit 141'],
    ['0 0 -', 'restore, exit 255'],
  ])('E4 failed_stage of cat decrypt restore at %s: %j', (codes, stage) => {
    const c = newCase();
    const stages = ['cat', 'decrypt', 'restore'];
    codes.split(' ').forEach((code, i) => {
      if (code !== '-') writeFileSync(path.join(c.dir, `${stages[i]}.rc`), `${code}\n`);
    });
    expect(lib(`failed_stage "${c.dir}" ${stages.join(' ')}`)).toBe(stage);
  });

  it.each([
    ['binarius', '0'],
    ['a'.repeat(33), '0'],
    ['a'.repeat(34), '1'],
    ['', '1'],
    ['Binarius', '1'],
    ['bi-narius', '1'],
  ])('E5 is_database_name %j: %s', (name, code) => {
    expect(lib(`is_database_name '${name}'; echo $?`)).toBe(code);
  });
});

describe('the backup service in compose.yaml and its image', () => {
  const compose = readFileSync(path.join(repoRoot, 'compose.yaml'), 'utf8');
  const envExample = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  const dockerfile = readFileSync(path.join(here, 'Dockerfile'), 'utf8');
  const entrypoint = readFileSync(script('entrypoint.sh'), 'utf8');
  const env = composeServiceEnv(compose, 'backup');
  const HOURLY_RUN_MINUTES = 60;
  const VALUELESS = [
    'BACKUP_REMOTE_PATH',
    'RCLONE_CONFIG_BACKUP_TYPE',
    'RCLONE_CONFIG_BACKUP_ACCOUNT',
    'RCLONE_CONFIG_BACKUP_KEY',
    'BACKUP_AGE_RECIPIENT',
    'BACKUP_AGE_IDENTITY',
    'BACKUP_ENV_FILE',
    'BACKUP_PING_URL',
    'BACKUP_RESTORE_CHECK_MAX_BYTES',
  ];

  it('C1 is a profile service with its own build, rebuilt by every up', () => {
    expect(composeServiceValue(compose, 'backup', 'profiles')).toBe('[backup]');
    expect(composeServiceValue(compose, 'backup', 'build')).toBe('tooling/backup');
    expect(composeServiceValue(compose, 'backup', 'pull_policy')).toBe('build');
    expect(composeServiceValue(compose, 'backup', 'stop_grace_period')).toBe('30s');
    expect(composeServiceValue(compose, 'backup', 'restart')).toBe(
      '${COMPOSE_RESTART:-unless-stopped}',
    );
    expect(composeServiceValue(compose, 'backup', 'init')).toBe('true');
  });

  it('C2 forwards the backup variables only when set and connects as the postgres service', () => {
    for (const name of VALUELESS) expect(env.get(name), name).toBe('');
    expect(env.get('PGHOST')).toBe('postgres');
    const postgres = composeServiceEnv(compose, 'postgres');
    expect(env.get('PGUSER')).toBe(postgres.get('POSTGRES_USER'));
    expect(env.get('PGPASSWORD')).toBe(postgres.get('POSTGRES_PASSWORD'));
    expect(env.get('PGDATABASE')).toBe(postgres.get('POSTGRES_DB'));
    expect(env.get('PGDATABASE')).toBe('${POSTGRES_DB:-binarius}');
  });

  it('C3 mounts the server .env read-only, /dev/null when unset', () => {
    expect(composeServiceChildLines(compose, 'backup', 'volumes')).toEqual([
      '      - ${BACKUP_ENV_FILE:-/dev/null}:/run/backup/env:ro',
    ]);
  });

  it('C4 turns unhealthy only after two hourly runs were missed', () => {
    const healthcheck = composeServiceChildLines(compose, 'backup', 'healthcheck');
    const minutes = Number(
      /find \/run\/backup\/ok -mmin -(\d+) \| grep -q \./.exec(healthcheck.join('\n'))?.[1],
    );
    expect(minutes).toBeGreaterThanOrEqual(2 * HOURLY_RUN_MINUTES + 5);
    expect(healthcheck).toContain('      interval: 30s');
  });

  it("C5 is tagged apart from the app's image", () => {
    expect(composeServiceValue(compose, 'backup', 'image')).toBe('${COMPOSE_PROJECT_NAME}-backup');
  });

  it('C6 every valueless variable is described in .env.example', () => {
    const valueless = [...env].filter(([, value]) => value === '').map(([name]) => name);
    expect(valueless.sort()).toEqual([...VALUELESS].sort());
    for (const name of valueless) {
      expect(envExample, name).toMatch(new RegExp(`^(# )?${name}=`, 'm'));
    }
  });

  it("C7 is built on the postgres service's own image, with age, rclone and curl", () => {
    expect(dockerfile.split('\n')[0]).toBe(
      `FROM ${composeServiceValue(compose, 'postgres', 'image')}`,
    );
    expect(dockerfile).toContain('RUN apk add --no-cache age rclone curl\n');
  });

  it("C8 keeps rclone's B2 upload buffer small", () => {
    expect(dockerfile).toContain('ENV RCLONE_B2_CHUNK_SIZE=5Mi RCLONE_B2_UPLOAD_CONCURRENCY=1\n');
  });

  it("C9 puts every command of the entrypoint on the image's PATH", () => {
    const wrappers = /for c in ([a-z -]+); do/.exec(dockerfile)?.[1]?.split(' ') ?? [];
    const commands = [...entrypoint.matchAll(/^ {2}([a-z-]+)\)/gm)].map((match) => match[1]);
    expect(commands).toContain('loop');
    expect(wrappers.sort()).toEqual(
      commands.filter((command) => command !== 'loop' && command !== 'age-keygen').sort(),
    );
    expect(dockerfile).toContain('ENTRYPOINT ["sh", "/opt/binarius-backup/entrypoint.sh"]\n');
  });
});
