import { Bot, GrammyError, HttpError } from 'grammy';
import type { ApiError } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import {
  BOT_MESSAGE_SPACER,
  confirmCallbackData,
  NotificationLevel,
  sessionStopCallbackData,
  TradeAction,
  TradeMode,
} from '@binarius/shared';
import { levelCallbackData, RESEND_CALLBACK_DATA } from './bot';
import { cycleStakeCallbackData, sessionStartCallbackData, stakeCallbackData } from './demo';
import { stakePresetCallbackData, stakeResetCallbackData } from './stake-picker';
import { MODE_DEMO_CALLBACK_DATA, MODE_REAL_CALLBACK_DATA } from './trading-mode';
import {
  BOT_INFO,
  USER,
  WRITE_CALLBACK_PREFIXES,
  captureApi,
  refuseWidthSpacerMisuse,
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
const HI = 'hi' + BOT_MESSAGE_SPACER;

const captured = () => {
  const bot = new Bot(TOKEN, { botInfo: BOT_INFO });
  return { bot, api: captureApi(bot) };
};

describe('captureApi', () => {
  it('refuses with a programmed ApiError even when the same method has an answer', async () => {
    const { bot, api } = captured();
    api.apiErrors.set('sendMessage', REFUSED);
    api.answers.set('sendMessage', () => SENT);

    const error = await rejectionOf(bot.api.sendMessage(USER.id, HI));

    expect(error).toBeInstanceOf(GrammyError);
    expect(error).toMatchObject({ method: 'sendMessage', error_code: 429 });
  });

  it('fails with a programmed HttpError even when the same method has an answer', async () => {
    const { bot, api } = captured();
    const failure = new HttpError("Network request for 'sendMessage' failed!", new Error('reset'));
    api.apiErrors.set('sendMessage', failure);
    api.answers.set('sendMessage', () => SENT);

    // the very instance, because the suites that program one assert on its identity
    expect(await rejectionOf(bot.api.sendMessage(USER.id, HI))).toBe(failure);
  });

  it('returns what the answer returned, as the result of an ok response', async () => {
    const { bot, api } = captured();
    api.answers.set('sendMessage', (payload) => ({ ...SENT, text: payload.text }));

    const result: unknown = await bot.api.sendMessage(USER.id, HI);

    // the answer gets the recorded payload, the width spacer taken off
    expect(result).toEqual({ message_id: 7, text: 'hi' });
  });

  it('answers an unprogrammed method with true, and records the call either way', async () => {
    const { bot, api } = captured();

    const result: unknown = await bot.api.sendMessage(USER.id, HI);

    expect(result).toBe(true);
    // recorded without the width spacer
    expect(api.calls).toEqual([
      { method: 'sendMessage', payload: { chat_id: USER.id, text: 'hi' } },
    ]);
  });

  // the e2e harness keys the message ids it answers with by the payload object (#506)
  it('hands the answer the very payload object it records', async () => {
    const { bot, api } = captured();
    const seen: unknown[] = [];
    api.answers.set('sendMessage', (payload) => {
      seen.push(payload);
      return SENT;
    });

    await bot.api.sendMessage(USER.id, HI);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(api.calls[0]?.payload);
  });

  it('refuses a text sent without the width spacer and records nothing (#506)', async () => {
    const { bot, api } = captured();

    const error = await rejectionOf(bot.api.sendMessage(USER.id, 'raw'));

    expect(String(error)).toContain('sendMessage sends a text without the width spacer');
    expect(api.calls).toEqual([]);
  });
});

describe('refuseWidthSpacerMisuse (#506)', () => {
  const keyboard = { inline_keyboard: [[{ text: 'x', callback_data: 'menu' }]] };

  it('a sendMessage without the spacer throws', () => {
    expect(() => refuseWidthSpacerMisuse('sendMessage', { chat_id: 1, text: 'x' })).toThrow(
      'sendMessage sends a text without the width spacer',
    );
    expect(() => refuseWidthSpacerMisuse('sendMessage', { chat_id: 1 })).toThrow(
      'sendMessage sends a text without the width spacer',
    );
  });

  it('an editMessageText without the spacer, or with it not at the end, throws', () => {
    expect(() => refuseWidthSpacerMisuse('editMessageText', { text: 'x' })).toThrow(
      'editMessageText sends a text without the width spacer',
    );
    expect(() =>
      refuseWidthSpacerMisuse('editMessageText', { text: BOT_MESSAGE_SPACER + 'x' }),
    ).toThrow('editMessageText sends a text without the width spacer');
  });

  it('a text with the spacer is recorded without it, every other field in place', () => {
    const payload = {
      chat_id: 1,
      message_id: 2,
      text: 'x' + BOT_MESSAGE_SPACER,
      reply_markup: keyboard,
    };
    expect(refuseWidthSpacerMisuse('editMessageText', payload)).toEqual({
      chat_id: 1,
      message_id: 2,
      text: 'x',
      reply_markup: keyboard,
    });
    expect(payload.text).toBe('x' + BOT_MESSAGE_SPACER);
  });

  it.each([
    ['sendPhoto', { caption: 'x\u2800' }],
    ['sendVideo', { caption: '\u2800' }],
    ['editMessageMedia', { media: { type: 'photo', caption: 'x' + BOT_MESSAGE_SPACER } }],
    ['answerInlineQuery', { results: [{ type: 'photo', caption: 'x\u2800' }] }],
    ['answerCallbackQuery', { text: 'x' + BOT_MESSAGE_SPACER }],
  ])('%s with a braille blank throws', (method, payload) => {
    expect(() => refuseWidthSpacerMisuse(method, payload)).toThrow(
      `${method} carries the width spacer outside a text message`,
    );
  });

  it('a caption, a toast and any other method without one pass as they are', () => {
    const photo = { caption: 'x', reply_markup: keyboard };
    expect(refuseWidthSpacerMisuse('sendPhoto', photo)).toBe(photo);
    const toast = { text: 'готово' };
    expect(refuseWidthSpacerMisuse('answerCallbackQuery', toast)).toBe(toast);
    const getMe = {};
    expect(refuseWidthSpacerMisuse('getMe', getMe)).toBe(getMe);
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
    [
      'the session stop under the waiting message',
      sessionStopCallbackData('9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', { waiting: true }),
    ],
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
