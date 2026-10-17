import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { main } from './main';
import { cacheWith, PAIR, secondsPath, T0, tempDir } from './testing';

async function call(
  argv: string[],
  env: Record<string, string | undefined> = { STAND_DIR: tempDir() },
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err: err.join('\n') };
}

describe('the stand CLI', () => {
  it.each([
    [[], 'one command expected'],
    [['replay'], 'unknown command replay'],
    [['run', '--bogus'], "Unknown option '--bogus'"],
    [['run', '--days', '3'], '--days is not an option of run'],
    [['fetch', '--days', '31'], '--days must be an integer from 1 to 30'],
    [['fetch', '--assets', '1,x'], '--assets: "x" is not an id'],
    [['fetch', '--intervals', '1s,2s'], '--intervals: 2s is not a stand interval'],
    [['fetch', '--intervals', 'constructor'], '--intervals: constructor is not a stand interval'],
    [['fetch', '--intervals', '__proto__'], '--intervals: __proto__ is not a stand interval'],
    [['run', '--headline-delay', '500'], '--headline-delay must be one of 0, 1000, 3000'],
    [['run', '--variants', 'v1,nope'], '--variants: nope is not a variant'],
    [['run', '--variants', 'v2+macd'], '--variants: v2+macd compares with v2; add v2'],
    [['run', '--variants', 'v2,v2+ma+macd'], '--variants: v2+ma+macd is not a variant'],
    [['run', '--variants', 'v2,v2'], '--variants: a name is repeated'],
    [['run', '--intervals', '5s,2s'], '--intervals: 2s is not a trade interval'],
    [['run', '--intervals', '1s'], '--intervals: 1s is not a trade interval'],
    [['run', '--intervals', 'constructor'], '--intervals: constructor is not a trade interval'],
    [['run', '--intervals', '15s,15s'], '--intervals: an interval is repeated'],
    [['fetch', '--variants', 'v2'], '--variants is not an option of fetch'],
  ])('refuses %j with exit 2 and the usage', async (argv, message) => {
    const { code, err } = await call(argv);
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(err).toContain('usage: stand');
  });

  it('refuses a missing or empty STAND_DIR with exit 2', async () => {
    expect((await call(['run'], {})).err).toContain('Missing required env STAND_DIR');
    expect((await call(['run'], { STAND_DIR: '' })).code).toBe(2);
  });

  it.each(['0', '601', 'x'])(
    'F9 refuses STAND_MAX_GETS_PER_MINUTE=%s before any GET',
    async (value) => {
      const { code, err } = await call(['fetch'], {
        STAND_DIR: tempDir(),
        BROKER_API_BASE_URL: 'http://127.0.0.1:9',
        STAND_MAX_GETS_PER_MINUTE: value,
      });
      expect(code).toBe(2);
      expect(err).toContain('STAND_MAX_GETS_PER_MINUTE');
    },
  );

  it('ends a refusal with exit 1 and its message', async () => {
    const { code, err } = await call(['run', '--assets', '7']);
    expect(code).toBe(1);
    expect(err).toBe('run: asset 7 is not in pairs.json; fetch it');
  });

  it('ends a damaged pairs.json with exit 1 and its message', async () => {
    const dir = tempDir();
    writeFileSync(`${dir}/pairs.json`, '[{"id": 16');
    const { code, err } = await call(['run'], { STAND_DIR: dir });
    expect(code).toBe(1);
    expect(err).toBe(`${dir}/pairs.json: not a pairs snapshot`);
  });

  it('runs a backtest end to end', async () => {
    const dir = cacheWith(secondsPath(T0, 3_600));
    const { code, out } = await call(['run', '--assets', String(PAIR.id), '--out', `${dir}/o`], {
      STAND_DIR: dir,
    });
    expect(code).toBe(0);
    expect(out.at(-1)).toBe(`report: ${dir}/o/report.md`);
  });

  it('runs only the variants and intervals asked for', async () => {
    const dir = cacheWith(secondsPath(T0, 3_600));
    const { code } = await call(
      [
        'run',
        '--assets',
        String(PAIR.id),
        '--out',
        `${dir}/o`,
        '--variants',
        'v2,v2+ma',
        '--intervals',
        '5s',
      ],
      { STAND_DIR: dir },
    );
    expect(code).toBe(0);
    const json = JSON.parse(readFileSync(`${dir}/o/report.json`, 'utf8')) as {
      selections: { variant: string; interval: string }[];
      variants: string[];
      intervals: string[];
    };
    expect(json.selections.map((s) => `${s.variant} ${s.interval}`)).toEqual(['v2 5s', 'v2+ma 5s']);
    expect([json.variants, json.intervals]).toEqual([['v2', 'v2+ma'], ['5s']]);
    expect(readFileSync(`${dir}/o/report.md`, 'utf8')).toContain(
      'Variants: v2, v2+ma; intervals: 5s.',
    );
  });
});
