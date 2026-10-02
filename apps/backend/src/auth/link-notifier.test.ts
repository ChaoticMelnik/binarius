import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GrammyError, HttpError } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';
import { LINK_TEXTS } from '@binarius/shared';
import { telegramTextProblems } from '@binarius/shared/testing';
import { captureApi, inlineButtons, sentPayload } from '../admin/testing';
import { createLinkNotifier, LinkPushKind, type LinkPushOutcome } from './link-notifier';
import { AUTH_TEXTS } from './texts';

const TOKEN = '123456:AA-link-push-token';
const ACCOUNT_ID = '0b7e3a52-8c1d-4f6e-9a2b-3c4d5e6f7a8b';
// above 2^53, so a conversion through number would round it
const TELEGRAM_USER_ID = 9_007_199_254_740_993n;

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("the backend's own texts", () => {
  it.each(Object.entries(AUTH_TEXTS))(
    'keeps %s valid Telegram HTML, inside the limit, non-empty, with no padded line',
    (_key, text) => {
      expect(telegramTextProblems(text)).toEqual([]);
    },
  );
});

describe('the link push message', () => {
  const sent = async (outcome: LinkPushOutcome) => {
    const notifier = createLinkNotifier({ token: TOKEN });
    const { calls } = captureApi(notifier);
    await notifier.send(TELEGRAM_USER_ID, outcome);
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    const payload = sentPayload(calls, 'sendMessage');
    expect(payload?.chat_id).toBe('9007199254740993');
    expect(payload?.parse_mode).toBe('HTML');
    return payload;
  };

  it('offers the confirm button for the account a pending link made', async () => {
    const payload = await sent({
      kind: LinkPushKind.Pending,
      account: { id: ACCOUNT_ID, email: 'ada@example.test' },
    });
    expect(payload?.text).toBe(LINK_TEXTS.confirmPrompt.value);
    expect(inlineButtons(payload)).toEqual([
      { text: '✅ Подтвердить: ada@example.test', callback_data: `confirm:${ACCOUNT_ID}` },
    ]);
  });

  it('labels the button without an email when the broker sent none', async () => {
    const payload = await sent({
      kind: LinkPushKind.Pending,
      account: { id: ACCOUNT_ID, email: null },
    });
    expect(inlineButtons(payload)).toEqual([
      { text: '✅ Подтвердить привязку', callback_data: `confirm:${ACCOUNT_ID}` },
    ]);
  });

  // the label is not parsed by Telegram, so the broker's email goes into it unescaped; the email
  // is not part of the text at all
  it('puts an email with markup characters into the button as it is', async () => {
    const email = 'a&b<c>_*@example.test';
    const payload = await sent({ kind: LinkPushKind.Pending, account: { id: ACCOUNT_ID, email } });
    expect(inlineButtons(payload)).toEqual([
      { text: `✅ Подтвердить: ${email}`, callback_data: `confirm:${ACCOUNT_ID}` },
    ]);
    expect(payload?.text).toBe(LINK_TEXTS.confirmPrompt.value);
  });

  it.each([
    [LinkPushKind.Active, LINK_TEXTS.linkedActive],
    [LinkPushKind.Blocked, LINK_TEXTS.blocked],
    [LinkPushKind.Taken, LINK_TEXTS.accountTaken],
    [LinkPushKind.ExchangeFailed, AUTH_TEXTS.oauthLoginFailed],
    [LinkPushKind.Mismatch, AUTH_TEXTS.oauthLoginFailed],
  ] as const)('sends %s as text alone, with no button', async (kind, text) => {
    const payload = await sent({ kind });
    expect(payload?.text).toBe(text.value);
    expect(payload?.reply_markup).toBeUndefined();
  });
});

describe('the link push transport', () => {
  let server: Server | undefined;
  afterEach(async () => {
    const running = server;
    server = undefined;
    if (running === undefined) return;
    running.closeAllConnections();
    await new Promise<void>((resolve) => running.close(() => resolve()));
  });

  it('ends a call Telegram does not answer at the configured timeout, not grammY’s 500 s', async () => {
    // accepts the connection and then says nothing: only the client's own timeout ends the call
    server = createServer(() => {});
    const apiRoot = await listen(server);
    const notifier = createLinkNotifier({ token: TOKEN, apiRoot, telegramApiTimeoutMs: 300 });

    const at = Date.now();
    const error = await rejectionOf(notifier.send(TELEGRAM_USER_ID, { kind: LinkPushKind.Active }));
    const elapsed = Date.now() - at;
    expect(error).toBeInstanceOf(HttpError);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('rejects with GrammyError when Telegram refuses the message', async () => {
    server = createServer((_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: false,
          error_code: 403,
          description: 'Forbidden: bot was blocked by the user',
        }),
      );
    });
    const apiRoot = await listen(server);
    const notifier = createLinkNotifier({ token: TOKEN, apiRoot });

    const error = await rejectionOf(notifier.send(TELEGRAM_USER_ID, { kind: LinkPushKind.Active }));
    expect(error).toBeInstanceOf(GrammyError);
    expect((error as GrammyError).error_code).toBe(403);
    expect((error as GrammyError).method).toBe('sendMessage');
  });
});
