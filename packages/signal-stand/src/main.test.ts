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
    [['run', '--headline-delay', '500'], '--headline-delay must be one of 0, 1000, 3000'],
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

  it('runs a backtest end to end', async () => {
    const dir = cacheWith(secondsPath(T0, 3_600));
    const { code, out } = await call(['run', '--assets', String(PAIR.id), '--out', `${dir}/o`], {
      STAND_DIR: dir,
    });
    expect(code).toBe(0);
    expect(out.at(-1)).toBe(`report: ${dir}/o/report.md`);
  });
});
