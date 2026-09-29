import { describe, expect, it } from 'vitest';
import { parseStaffArgs, UsageError } from './staff';

describe('parseStaffArgs', () => {
  it('reads create with every flag', () => {
    expect(parseStaffArgs(['create', '--login', 'ada.l', '--telegram-id', '4242', '--name', 'Ада'])).toEqual(
      { command: 'create', login: 'ada.l', telegramId: 4242n, name: 'Ада' },
    );
  });

  it('leaves the display name out when it was not given', () => {
    const parsed = parseStaffArgs(['create', '--login', 'ada', '--telegram-id', '1']);
    expect(parsed).toEqual({ command: 'create', login: 'ada', telegramId: 1n });
    expect('name' in parsed).toBe(false);
  });

  it.each(['disable', 'reset-password'])('reads %s', (command) => {
    expect(parseStaffArgs([command, '--login', 'ada'])).toEqual({ command, login: 'ada' });
  });

  it.each([
    ['no command', []],
    ['an unknown command', ['delete', '--login', 'ada']],
    ['a second positional', ['create', 'extra', '--login', 'ada', '--telegram-id', '1']],
    ['no login', ['create', '--telegram-id', '1']],
    ['a login outside the pattern', ['create', '--login', 'ab', '--telegram-id', '1']],
    ['a login with a space', ['create', '--login', 'ada l', '--telegram-id', '1']],
    ['no telegram id on create', ['create', '--login', 'ada']],
    ['a telegram id of zero', ['create', '--login', 'ada', '--telegram-id', '0']],
    ['a negative telegram id', ['create', '--login', 'ada', '--telegram-id', '-1']],
    ['a telegram id that is not a number', ['create', '--login', 'ada', '--telegram-id', 'x']],
    // the flags that only make sense when an account is being created
    ['--telegram-id on disable', ['disable', '--login', 'ada', '--telegram-id', '1']],
    ['--name on reset-password', ['reset-password', '--login', 'ada', '--name', 'Ада']],
  ])('refuses %s', (_label, argv) => {
    expect(() => parseStaffArgs(argv)).toThrow(UsageError);
  });

  // strict:true, so a mistyped flag is refused rather than ignored — and it leaves by the
  // same door as every other misuse, which is what the exit code 2 is keyed on
  it('refuses an unknown flag as a usage error', () => {
    expect(() => parseStaffArgs(['create', '--logn', 'ada', '--telegram-id', '1'])).toThrow(
      UsageError,
    );
  });
});
