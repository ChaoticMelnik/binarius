import { describe, expect, it } from 'vitest';
import { telegramErrorFields } from './telegram-logging';

function shaped(name: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error('the description and the URL'), { name }, fields);
}

describe('telegramErrorFields', () => {
  it('keeps nothing but the method and the code of a Bot API refusal', () => {
    const refusal = shaped('GrammyError', {
      method: 'sendMessage',
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
      payload: { chat_id: 42, text: 'login and one-time code' },
    });

    expect(telegramErrorFields(refusal, 'other')).toEqual({
      method: 'sendMessage',
      telegramErrorCode: 403,
    });
  });

  it('reduces a transport failure to its identity, with the method from the call site', () => {
    const failure = shaped('HttpError', {
      error: Object.assign(new Error('boom at https://api.telegram.org/bot<token>/'), {
        code: 'ECONNRESET',
      }),
    });

    expect(telegramErrorFields(failure, 'sendPhoto')).toEqual({
      method: 'sendPhoto',
      transportError: { name: 'Error', code: 'ECONNRESET' },
    });
    expect(telegramErrorFields(failure)).toEqual({
      transportError: { name: 'Error', code: 'ECONNRESET' },
    });
  });

  it('reads a refusal off its fields, not its name', () => {
    const renamed = shaped('', { method: 'setMyCommands', error_code: 99, description: 'x' });

    expect(telegramErrorFields(renamed)).toEqual({
      method: 'setMyCommands',
      telegramErrorCode: 99,
    });
  });

  it.each([new Error('plain'), 'a string', undefined])(
    'keeps only the passed method for anything else (%s)',
    (error) => {
      expect(telegramErrorFields(error, 'sendMessage')).toEqual({ method: 'sendMessage' });
      expect(telegramErrorFields(error)).toEqual({});
    },
  );

  it.each([
    ['no description', shaped('GrammyError', { method: 'sendMessage', error_code: 400 })],
    [
      'a string code',
      shaped('GrammyError', { method: 'sendMessage', error_code: '400', description: 'x' }),
    ],
    ['no method', shaped('GrammyError', { error_code: 400, description: 'x' })],
    ['another name and no fields of a refusal', shaped('Error', { error: new Error('wrapped') })],
    ['an HttpError with no wrapped error', shaped('HttpError', {})],
  ])('an error with %s is not a Bot API refusal nor a transport failure', (_label, error) => {
    expect(telegramErrorFields(error)).toEqual({});
  });
});
