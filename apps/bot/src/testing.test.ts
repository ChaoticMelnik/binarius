import { Bot, GrammyError, HttpError } from 'grammy';
import type { ApiError } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { confirmCallbackData, NotificationLevel, TradeAction, TradeMode } from '@binarius/shared';
import { levelCallbackData, RESEND_CALLBACK_DATA } from './bot';
import { cycleStakeCallbackData, sessionStartCallbackData, stakeCallbackData } from './demo';
import { stakePresetCallbackData, stakeResetCallbackData } from './stake-picker';
import { MODE_DEMO_CALLBACK_DATA, MODE_REAL_CALLBACK_DATA } from './trading-mode';
import { sessionStopCallbackData } from './trading-session';
import {
  BOT_INFO,
  USER,
  WRITE_CALLBACK_PREFIXES,
  captureApi,
  refuseWriteRetried,
  rejectionOf,
} from './testing';
import { LABELS } from './texts';

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

// #350: the guard every scene's sends pass through
describe('refuseWriteRetried', () => {
  const keyboard = (text: string, callback_data: string) => ({
    reply_markup: { inline_keyboard: [[{ text, callback_data }]] },
  });

  it.each(WRITE_CALLBACK_PREFIXES)('refuses «🔄 Повторить» carrying %s', (prefix) => {
    expect(() =>
      refuseWriteRetried('sendMessage', keyboard(LABELS.demoRetryButton, `${prefix}x`)),
    ).toThrow('sendMessage repeats a write');
  });

  // #327: a real session's datum is a write as the demo one is
  it.each(['demo:sess:101:15', 'real:sess:101:15'])(
    'refuses «🔄 Повторить» carrying %s',
    (data) => {
      expect(() =>
        refuseWriteRetried('sendMessage', keyboard(LABELS.demoRetryButton, data)),
      ).toThrow('sendMessage repeats a write');
    },
  );

  it('passes a repeat of a read and a write under its own label', () => {
    expect(() =>
      refuseWriteRetried('sendMessage', keyboard(LABELS.demoRetryButton, 'intent:x')),
    ).not.toThrow();
    expect(() =>
      refuseWriteRetried('sendMessage', keyboard(LABELS.sessionAgainButton, 'demo:sess:101:15')),
    ).not.toThrow();
  });
});

// #476: a write's data drawn by its own builder carries a listed prefix, so a «🔄 Повторить» with
// it fails the scene; a builder added without its prefix is caught here
describe('WRITE_CALLBACK_PREFIXES', () => {
  const SETTINGS = { kind: 'settings' } as const;
  it.each([
    ['the stake button', stakeCallbackData(101, 15, TradeAction.Up, '0123456789ab', 'abcdef')],
    ['a demo session', sessionStartCallbackData(TradeMode.Demo, 101, 15)],
    ['a real session', sessionStartCallbackData(TradeMode.Real, 101, 15, true)],
    ['an amount of the amount screen', cycleStakeCallbackData(101, 15, '5', 'l')],
    ['the session stop', sessionStopCallbackData('9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d')],
    ['the login confirm', confirmCallbackData('3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01')],
    ['the code resend', RESEND_CALLBACK_DATA],
    ['the switch to real', MODE_REAL_CALLBACK_DATA],
    ['the switch back to demo', MODE_DEMO_CALLBACK_DATA],
    ['a stake preset', stakePresetCallbackData('5', TradeMode.Demo, SETTINGS)],
    ['the stake reset', stakeResetCallbackData(TradeMode.Demo, SETTINGS)],
    ['a notification level', levelCallbackData(NotificationLevel.All)],
  ])('lists the prefix of %s', (_label, data) => {
    expect(WRITE_CALLBACK_PREFIXES.some((prefix) => data.startsWith(prefix))).toBe(true);
  });
});
