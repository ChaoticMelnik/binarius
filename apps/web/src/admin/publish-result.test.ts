import { describe, expect, it } from 'vitest';
import { ADMIN_BOT_PROFILE_IDENTITY_MAX, type AdminBotProfileMethodResult } from '@binarius/shared';
import { decodePublishResults, encodePublishResults } from './publish-result';

const through = (results: readonly AdminBotProfileMethodResult[]) =>
  decodePublishResults(
    new URLSearchParams(`?${new URLSearchParams({ publish: encodePublishResults(results) })}`).get(
      'publish',
    ),
  );

describe('the publish result in the query (#361)', () => {
  it('W11 goes through the redirect and back, all three methods', () => {
    const results: AdminBotProfileMethodResult[] = [
      { method: 'setMyCommands', ok: true },
      {
        method: 'setMyDescription',
        ok: false,
        err: { name: 'GrammyError' },
        telegramErrorCode: 400,
      },
      { method: 'setMyShortDescription', ok: false, err: { name: 'HttpError', code: 'ETIMEDOUT' } },
    ];
    expect(encodePublishResults(results)).toBe(
      'setMyCommands:ok,setMyDescription:GrammyError:400,setMyShortDescription:HttpError.ETIMEDOUT',
    );
    expect(through(results)).toEqual(results);
  });

  it("W11 carries a name and a code of the wire's full length", () => {
    const results: AdminBotProfileMethodResult[] = [
      {
        method: 'setMyCommands',
        ok: false,
        err: {
          name: `E${'r'.repeat(ADMIN_BOT_PROFILE_IDENTITY_MAX - 1)}`,
          code: 'C'.repeat(ADMIN_BOT_PROFILE_IDENTITY_MAX),
        },
      },
    ];
    expect(through(results)).toEqual(results);
    // one character more is not sent: the encoder takes the wire's bound too
    expect(
      encodePublishResults([
        {
          method: 'setMyCommands',
          ok: false,
          err: { name: 'E'.repeat(ADMIN_BOT_PROFILE_IDENTITY_MAX + 1) },
        },
      ]),
    ).toBe('setMyCommands:Error');
  });

  it('W11 carries what the page shows: no cause; a name or code outside the grammar falls back', () => {
    expect(
      through([
        {
          method: 'setMyCommands',
          ok: false,
          err: { name: 'Http Error', code: 'a.b' },
          cause: { name: 'AbortError' },
        },
      ]),
    ).toEqual([{ method: 'setMyCommands', ok: false, err: { name: 'Error' } }]);
    expect(
      encodePublishResults([{ method: 'setMyCommands', ok: false, err: { name: 'ok' } }]),
    ).toBe('setMyCommands:Error');
  });

  it.each([
    ['a method twice', 'setMyCommands:ok,setMyCommands:ok'],
    ['an unknown method', 'deleteMyCommands:ok'],
    [
      'four segments by the grammar, a method repeated',
      'setMyCommands:ok,setMyDescription:ok,setMyShortDescription:ok,setMyCommands:ok',
    ],
    ['the key twice', ['setMyCommands:ok', 'setMyCommands:ok']],
    ['nothing', ''],
    ['a two-digit Telegram code', 'setMyCommands:GrammyError:40'],
    ['a name that starts with a digit', 'setMyCommands:1Error'],
    ['a prototype name', 'setMyCommands:__proto__'],
    [
      'a name of one character more than the wire takes',
      `setMyCommands:${'E'.repeat(ADMIN_BOT_PROFILE_IDENTITY_MAX + 1)}`,
    ],
    ['no value', undefined],
  ])('W11 shows nothing for %s', (_label, value) => {
    expect(decodePublishResults(value)).toBeUndefined();
  });
});
