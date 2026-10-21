import type { Api, Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import {
  BOT_MESSAGE_SPACER,
  ButtonRole,
  callbackButton,
  isBotKeyboard,
  keyboardOf,
  telegramHtml,
} from '@binarius/shared';
import {
  answerInlineQueryPhotoHtml,
  editMessagePhotoByIdHtml,
  editMessagePhotoByIdHtmlWithoutNextStep,
  editMessageTextByIdHtml,
  editMessageTextByIdHtmlWithoutNextStep,
  editMessageTextHtml,
  editMessageTextHtmlWithoutNextStep,
  NO_NEXT_STEP_REASONS,
  replyHtml,
  replyHtmlWithoutNextStep,
  replyWithInvoiceStars,
  replyWithPhotoHtml,
  replyWithPhotoHtmlWithoutNextStep,
  replyWithVideoHtml,
  sendPhotoByIdHtml,
} from './send';

// a text already holding U+2800 inside and ending with a block: the spacer still goes after it
const TEXT = telegramHtml`<b>Привет</b> \u2800 ${'x'}\n<pre>code</pre>`;
const CAPTION = telegramHtml`<b>Карта</b>`;
const keyboard = keyboardOf([callbackButton(ButtonRole.Nav, '🏠 В меню', 'menu')]);
const REASON = NO_NEXT_STEP_REASONS.InProgress;

const fakeCtx = () => {
  const ctx = {
    reply: vi.fn(),
    editMessageText: vi.fn(),
    replyWithPhoto: vi.fn(),
    replyWithVideo: vi.fn(),
    replyWithInvoice: vi.fn(),
    answerInlineQuery: vi.fn(),
  };
  return { ctx, context: ctx as unknown as Context };
};
const fakeApi = () => {
  const api = { editMessageText: vi.fn(), sendPhoto: vi.fn(), editMessageMedia: vi.fn() };
  return { api, typed: api as unknown as Api };
};
const SPACED = TEXT.value + BOT_MESSAGE_SPACER;

describe('the text seam appends the width spacer (#506)', () => {
  it('replyHtml appends the width spacer', () => {
    const { ctx, context } = fakeCtx();
    void replyHtml(context, TEXT, { reply_markup: keyboard });
    expect(ctx.reply).toHaveBeenCalledWith(SPACED, { reply_markup: keyboard, parse_mode: 'HTML' });
  });

  it('replyHtmlWithoutNextStep appends the width spacer', () => {
    const { ctx, context } = fakeCtx();
    void replyHtmlWithoutNextStep(context, TEXT, REASON);
    expect(ctx.reply).toHaveBeenCalledWith(SPACED, { parse_mode: 'HTML' });
  });

  it('editMessageTextHtml appends the width spacer', () => {
    const { ctx, context } = fakeCtx();
    void editMessageTextHtml(context, TEXT, { reply_markup: keyboard });
    expect(ctx.editMessageText).toHaveBeenCalledWith(SPACED, {
      reply_markup: keyboard,
      parse_mode: 'HTML',
    });
  });

  it('editMessageTextHtmlWithoutNextStep appends the width spacer', () => {
    const { ctx, context } = fakeCtx();
    void editMessageTextHtmlWithoutNextStep(context, TEXT, REASON);
    expect(ctx.editMessageText).toHaveBeenCalledWith(SPACED, { parse_mode: 'HTML' });
  });

  it('editMessageTextByIdHtml appends the width spacer', () => {
    const { api, typed } = fakeApi();
    void editMessageTextByIdHtml(typed, 1, 2, TEXT, { reply_markup: keyboard });
    expect(api.editMessageText).toHaveBeenCalledWith(1, 2, SPACED, {
      reply_markup: keyboard,
      parse_mode: 'HTML',
    });
  });

  it('editMessageTextByIdHtmlWithoutNextStep appends the width spacer', () => {
    const { api, typed } = fakeApi();
    void editMessageTextByIdHtmlWithoutNextStep(typed, 1, 2, TEXT, REASON);
    expect(api.editMessageText).toHaveBeenCalledWith(1, 2, SPACED, { parse_mode: 'HTML' });
  });
});

describe('captions, inline answers and the invoice go without it', () => {
  it('a photo and a video caption are the caption as given', () => {
    const { ctx, context } = fakeCtx();
    void replyWithPhotoHtml(context, 'photo', CAPTION, { reply_markup: keyboard });
    void replyWithPhotoHtmlWithoutNextStep(context, 'photo', CAPTION, REASON);
    void replyWithVideoHtml(context, 'video', CAPTION, { reply_markup: keyboard });
    expect(ctx.replyWithPhoto.mock.calls.map(([, extra]) => extra.caption)).toEqual([
      CAPTION.value,
      CAPTION.value,
    ]);
    expect(ctx.replyWithVideo.mock.calls[0]?.[1].caption).toBe(CAPTION.value);
  });

  it('a photo by id and a media edit carry the caption as given', () => {
    const { api, typed } = fakeApi();
    void sendPhotoByIdHtml(typed, 1, 'photo', CAPTION, { reply_markup: keyboard });
    void editMessagePhotoByIdHtml(typed, 1, 2, 'photo', CAPTION, { reply_markup: keyboard });
    void editMessagePhotoByIdHtmlWithoutNextStep(typed, 1, 2, 'photo', CAPTION, REASON);
    expect(api.sendPhoto.mock.calls[0]?.[2].caption).toBe(CAPTION.value);
    expect(api.editMessageMedia.mock.calls.map(([, , media]) => media.caption)).toEqual([
      CAPTION.value,
      CAPTION.value,
    ]);
  });

  it('an inline answer carries the caption as given', () => {
    const { ctx, context } = fakeCtx();
    void answerInlineQueryPhotoHtml(context, { id: 'r', fileId: 'f' }, CAPTION);
    expect(ctx.answerInlineQuery.mock.calls[0]?.[0][0].caption).toBe(CAPTION.value);
  });

  it('an invoice has no braille blank in its title or description', () => {
    const { ctx, context } = fakeCtx();
    void replyWithInvoiceStars(
      context,
      { title: 'Токены', description: '100 токенов', payload: 'p', label: 'l', stars: 1 },
      { pay: 'Оплатить', then: keyboard },
    );
    const [title, description] = ctx.replyWithInvoice.mock.calls[0] ?? [];
    expect(`${title}${description}`).not.toContain('\u2800');
  });

  // #475: the pay button first and alone, green, over `then`'s rows, the whole a BotKeyboard
  it('an invoice keyboard is the pay row stacked over its next step', () => {
    const { ctx, context } = fakeCtx();
    void replyWithInvoiceStars(
      context,
      { title: 'Токены', description: '100 токенов', payload: 'p', label: 'l', stars: 1 },
      { pay: 'Оплатить', then: keyboard },
    );
    const markup = (ctx.replyWithInvoice.mock.calls[0]?.[5] as { reply_markup: unknown })
      .reply_markup;
    expect(isBotKeyboard(markup)).toBe(true);
    expect((markup as typeof keyboard).inline_keyboard).toEqual([
      [{ text: 'Оплатить', pay: true, style: 'success' }],
      ...keyboard.inline_keyboard,
    ]);
  });
});
