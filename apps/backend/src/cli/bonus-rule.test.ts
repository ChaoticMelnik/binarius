import { describe, expect, it } from 'vitest';
import { parseBonusRuleArgs, runBonusRuleCli, UsageError } from './bonus-rule';

describe('parseBonusRuleArgs', () => {
  it('reads the four commands', () => {
    expect(parseBonusRuleArgs(['list'])).toEqual({ command: 'list' });
    expect(
      parseBonusRuleArgs(['new-version', 'link_bonus', '--params', '{"tokens":"150"}']),
    ).toEqual({ command: 'new-version', code: 'link_bonus', params: { tokens: '150' } });
    expect(
      parseBonusRuleArgs([
        'new-version',
        'deposit_bonus',
        '--kind',
        'deposit_bonus',
        '--params',
        '{"tokensPerUsd":"1","minAmountUsd":"0","maxTokens":"100"}',
      ]),
    ).toEqual({
      command: 'new-version',
      code: 'deposit_bonus',
      kind: 'deposit_bonus',
      params: { tokensPerUsd: '1', minAmountUsd: '0', maxTokens: '100' },
    });
    expect(parseBonusRuleArgs(['activate', 'link_bonus', '2'])).toEqual({
      command: 'activate',
      code: 'link_bonus',
      version: 2,
    });
    expect(parseBonusRuleArgs(['deactivate', 'link_bonus'])).toEqual({
      command: 'deactivate',
      code: 'link_bonus',
    });
  });

  it.each([
    ['no command', []],
    ['an unknown command', ['edit', 'link_bonus']],
    ['list with arguments', ['list', 'link_bonus']],
    ['a missing code', ['deactivate']],
    ['a code with capitals', ['deactivate', 'Link_bonus']],
    ['a code with a quote', ['deactivate', "link'"]],
    ['activate without a version', ['activate', 'link_bonus']],
    ['version 0', ['activate', 'link_bonus', '0']],
    ['a fractional version', ['activate', 'link_bonus', '1.5']],
    ['new-version without --params', ['new-version', 'link_bonus']],
    ['params that are not JSON', ['new-version', 'link_bonus', '--params', '{tokens:1}']],
    ['an unknown kind', ['new-version', 'promo', '--kind', 'promo', '--params', '{}']],
    ['--params on activate', ['activate', 'link_bonus', '1', '--params', '{}']],
    ['--kind on deactivate', ['deactivate', 'link_bonus', '--kind', 'link_bonus']],
    ['an extra argument', ['deactivate', 'link_bonus', '1']],
    ['an unknown flag', ['list', '--force']],
  ])('refuses %s', (_label, argv) => {
    expect(() => parseBonusRuleArgs(argv)).toThrow(UsageError);
  });
});

describe('runBonusRuleCli without a database', () => {
  it('prints the reason and the usage, and exits 2, for a command it does not understand', async () => {
    const lines: string[] = [];
    const code = await runBonusRuleCli(['activate', 'link_bonus'], {}, (line) => lines.push(line));
    expect(code).toBe(2);
    expect(lines[0]).toBe('нет номера версии');
    expect(lines[1]).toContain('bonus-rule activate <код> <версия>');
  });

  it('exits 1 without DATABASE_URL, naming the variable', async () => {
    const lines: string[] = [];
    const code = await runBonusRuleCli(['list'], {}, (line) => lines.push(line));
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('DATABASE_URL');
  });

  it('exits 1 with the failure by name and code when the database cannot be reached', async () => {
    const lines: string[] = [];
    const code = await runBonusRuleCli(
      ['deactivate', 'link_bonus'],
      { DATABASE_URL: 'postgres://nobody:MARKER-SECRET@127.0.0.1:1/none' },
      (line) => lines.push(line),
    );
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Не удалось выполнить команду: \w+/);
    expect(lines[0]).not.toContain('MARKER-SECRET');
  });
});
