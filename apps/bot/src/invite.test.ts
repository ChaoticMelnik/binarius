import { describe, expect, it, vi } from 'vitest';
import {
  commandRetryCallbackData,
  MENU_CALLBACK_DATA,
  supportUrl,
  UserErrorCode,
  UserStatus,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import { INVITE_CALLBACK_DATA } from './keyboards';
import {
  BOT_INFO,
  callbackUpdate,
  captureApi,
  fakeBackend,
  fakeLogger,
  inlineRows,
  REFERRAL_VIEW,
  sentPayload,
  stubSessionTracker,
  stubTracker,
  textUpdate,
  USER,
} from './testing';
import { inviteShareText, LABELS, TEXTS } from './texts';

// The /invite screen (#115, docs/referrals.md → The screen).
const LINK = `https://t.me/${BOT_INFO.username}?start=ref_${REFERRAL_VIEW.code}`;
const MENU_ROW = [{ text: LABELS.menuButton, callback_data: MENU_CALLBACK_DATA }];

function setup(readReferral: BackendClient['readReferral']) {
  const logger = fakeLogger();
  const backend = fakeBackend({ readReferral: vi.fn(readReferral) });
  const bot = createBot({
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
    token: '123456:AA-bot-token',
    backend,
    logger,
    botInfo: BOT_INFO,
  });
  return { bot, backend, logger, api: captureApi(bot) };
}

const ok = () => Promise.resolve(REFERRAL_VIEW);
const notFound = () =>
  Promise.reject(
    new BackendError(BackendErrorCode.HttpStatus, {
      status: 404,
      reason: UserErrorCode.UserNotFound,
    }),
  );

describe('/invite', () => {
  it('I1 shows the link and the count, with the share button and then the menu', async () => {
    const { bot, backend, api, logger } = setup(ok);
    await bot.handleUpdate(textUpdate('/invite'));
    expect(backend.readReferral).toHaveBeenCalledWith(String(USER.id));
    expect(api.calls.map((call) => call.method)).toEqual(['sendMessage']);
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(
      TEXTS.inviteScreen({ referralLink: LINK, count: String(REFERRAL_VIEW.invited) }).value,
    );
    expect(message?.text).toContain(LINK);
    expect(message?.text).toContain('Приглашено: 2');
    const [shareRow, menuRow, ...rest] = inlineRows(message) as { text: string; url?: string }[][];
    expect(rest).toEqual([]);
    expect(menuRow).toEqual(MENU_ROW);
    expect(shareRow).toHaveLength(1);
    expect(shareRow![0]!.text).toBe(LABELS.inviteShareButton);
    const share = new URL(shareRow![0]!.url ?? '');
    expect(`${share.origin}${share.pathname}`).toBe('https://t.me/share/url');
    expect(share.searchParams.get('url')).toBe(LINK);
    // encoded, so the link's own `?start=` stays inside the `url` parameter
    expect(shareRow![0]!.url).toContain(
      `url=https%3A%2F%2Ft.me%2F${BOT_INFO.username}%3Fstart%3Dref_${REFERRAL_VIEW.code}&text=`,
    );
    expect(share.searchParams.get('text')).toBe(inviteShareText());
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('I2 sends a blocked user to support', async () => {
    const { bot, api } = setup(() =>
      Promise.resolve({ status: UserStatus.Blocked, code: null, invited: 3 }),
    );
    await bot.handleUpdate(textUpdate('/invite'));
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.blocked.value);
    expect(inlineRows(message)).toEqual([[{ text: LABELS.supportButton, url: supportUrl() }]]);
  });

  it('I3 asks a user the backend does not know yet to press /start, under the menu', async () => {
    const { bot, api, logger } = setup(notFound);
    await bot.handleUpdate(textUpdate('/invite'));
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.inviteNeedsStart.value);
    expect(inlineRows(message)).toEqual([MENU_ROW]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('I4 answers a failure with the repeat of /invite, logs it, and the repeat reads again', async () => {
    const error = new BackendError(BackendErrorCode.Unreachable);
    const { bot, backend, api, logger } = setup(() => Promise.reject(error));
    await bot.handleUpdate(textUpdate('/invite'));
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.unavailable.value);
    expect(inlineRows(message)).toEqual([
      [{ text: LABELS.demoRetryButton, callback_data: commandRetryCallbackData('invite') }],
      MENU_ROW,
    ]);
    expect(logger.warn.mock.calls).toEqual([
      [
        expect.objectContaining({
          err: expect.objectContaining({ code: BackendErrorCode.Unreachable }),
        }),
        '/invite not read',
      ],
    ]);

    api.calls.length = 0;
    vi.mocked(backend.readReferral).mockImplementation(ok);
    await bot.handleUpdate(callbackUpdate(commandRetryCallbackData('invite')));
    expect(backend.readReferral).toHaveBeenCalledTimes(2);
    expect(api.calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(sentPayload(api.calls, 'sendMessage')?.text).toContain(LINK);
  });

  it('I5 answers the invite button, then sends the screen as a new message', async () => {
    const { bot, backend, api } = setup(ok);
    await bot.handleUpdate(callbackUpdate(INVITE_CALLBACK_DATA));
    expect(api.calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(backend.readReferral).toHaveBeenCalledWith(String(USER.id));
    expect(sentPayload(api.calls, 'sendMessage')?.text).toContain(LINK);
  });

  it('ignores /invite outside a private chat', async () => {
    const { bot, backend, api } = setup(ok);
    await bot.handleUpdate(textUpdate('/invite', 'group'));
    expect(backend.readReferral).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  });
});
