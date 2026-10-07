import { describe, expect, it } from 'vitest';
import { parseKillSwitchArgs, runKillSwitchCli, UsageError } from './kill-switch';

describe('parseKillSwitchArgs', () => {
  it('reads the three commands', () => {
    expect(parseKillSwitchArgs(['on', '--reason', '  инцидент брокера '])).toEqual({
      command: 'on',
      reason: 'инцидент брокера',
    });
    expect(parseKillSwitchArgs(['off'])).toEqual({ command: 'off' });
    expect(parseKillSwitchArgs(['off', '--reason', 'брокер в норме'])).toEqual({
      command: 'off',
      reason: 'брокер в норме',
    });
    expect(parseKillSwitchArgs(['status'])).toEqual({ command: 'status' });
  });

  it.each([
    ['no command', []],
    ['an unknown command', ['pause']],
    ['on without --reason', ['on']],
    ['an empty reason', ['on', '--reason', '']],
    ['a reason of spaces', ['on', '--reason', '   ']],
    ['a 201-character reason', ['on', '--reason', 'x'.repeat(201)]],
    ['a line break in the reason', ['on', '--reason', 'а\nб']],
    ['an unknown flag', ['on', '--reason', 'x', '--force']],
    ['status with extra arguments', ['status', 'now']],
    ['status with a reason', ['status', '--reason', 'x']],
    ['--reason without a value', ['on', '--reason']],
  ])('refuses %s', (_label, argv) => {
    expect(() => parseKillSwitchArgs(argv)).toThrow(UsageError);
  });
});

describe('runKillSwitchCli without a database', () => {
  it('prints the usage and exits 2 for a command it does not understand', async () => {
    const lines: string[] = [];
    const code = await runKillSwitchCli(['on'], {}, (line) => lines.push(line));
    expect(code).toBe(2);
    expect(lines[0]).toBe('нужен --reason');
    expect(lines[1]).toMatch(/^Глобальный выключатель торговли/);
  });

  it('exits 1 naming the variable when DATABASE_URL is missing', async () => {
    const lines: string[] = [];
    const code = await runKillSwitchCli(['status'], {}, (line) => lines.push(line));
    expect(code).toBe(1);
    expect(lines).toEqual(['Missing required env DATABASE_URL']);
  });
});
