import { Bot, GrammyError, HttpError } from 'grammy';
import type { ApiError } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { BOT_INFO, USER, captureApi, rejectionOf } from './testing';

// captureApi is itself a double, so the premise every other suite reads through it — that a
// transformer's return value is what the caller of bot.api.<method> gets, and that a thrown
// ApiError comes back as a GrammyError — is proved here against the real grammY Bot rather
// than assumed. These scenes also fix the one thing the type cannot say: which of the two maps
// wins when the same method is in both.
const TOKEN = '123456:AA-bot-token';
const REFUSED: ApiError = { ok: false, error_code: 429, description: 'Too Many Requests' };
const SENT = { message_id: 7 };

const captured = () => {
  const bot = new Bot(TOKEN, { botInfo: BOT_INFO });
  return { bot, api: captureApi(bot) };
};

describe('captureApi', () => {
  it('refuses with a programmed ApiError even when the same method has an answer', async () => {
    const { bot, api } = captured();
    api.apiErrors.set('sendMessage', REFUSED);
    api.answers.set('sendMessage', () => SENT);

    const error = await rejectionOf(bot.api.sendMessage(USER.id, 'hi'));

    expect(error).toBeInstanceOf(GrammyError);
    expect(error).toMatchObject({ method: 'sendMessage', error_code: 429 });
  });

  it('fails with a programmed HttpError even when the same method has an answer', async () => {
    const { bot, api } = captured();
    const failure = new HttpError("Network request for 'sendMessage' failed!", new Error('reset'));
    api.apiErrors.set('sendMessage', failure);
    api.answers.set('sendMessage', () => SENT);

    // the very instance, because the suites that program one assert on its identity
    expect(await rejectionOf(bot.api.sendMessage(USER.id, 'hi'))).toBe(failure);
  });

  it('returns what the answer returned, as the result of an ok response', async () => {
    const { bot, api } = captured();
    api.answers.set('sendMessage', (payload) => ({ ...SENT, text: payload.text }));

    const result: unknown = await bot.api.sendMessage(USER.id, 'hi');

    expect(result).toEqual({ message_id: 7, text: 'hi' });
  });

  it('answers an unprogrammed method with true, and records the call either way', async () => {
    const { bot, api } = captured();

    const result: unknown = await bot.api.sendMessage(USER.id, 'hi');

    expect(result).toBe(true);
    expect(api.calls).toEqual([
      { method: 'sendMessage', payload: { chat_id: USER.id, text: 'hi' } },
    ]);
  });
});
