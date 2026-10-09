import { describe, expect, it } from 'vitest';
import type { AdminBotProfileMethodResult } from '@binarius/shared';
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
    ['four segments', 'setMyCommands:ok,setMyDescription:ok,setMyShortDescription:ok,x:ok'],
    ['the key twice', ['setMyCommands:ok', 'setMyCommands:ok']],
    ['nothing', ''],
    ['a two-digit Telegram code', 'setMyCommands:GrammyError:40'],
    ['a name that starts with a digit', 'setMyCommands:1Error'],
    ['a prototype name', 'setMyCommands:__proto__'],
    ['too long a value', `setMyCommands:${'E'.repeat(1100)}`],
    ['no value', undefined],
  ])('W11 shows nothing for %s', (_label, value) => {
    expect(decodePublishResults(value)).toBeUndefined();
  });
});
