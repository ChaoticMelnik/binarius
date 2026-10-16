import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GrammyError, HttpError, InlineKeyboard } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultBotTextSource,
  formatUsd,
  telegramHtml,
  type DecimalString,
} from '@binarius/shared';
import { UNIT_WAIT_CEILING_MS } from '@binarius/shared/testing';
import { captureApi, inlineButtons, sentPayload } from '../admin/testing';
import {
  createClientPush,
  type ClientPush,
  LinkPushKind,
  linkPushMessage,
  type LinkPushOutcome,
} from './client-push';
import { CLIENT_LABELS, CLIENT_TEXTS, setBotTextSource } from './texts';

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

// The texts are the catalog's (bot-texts.test.ts checks every default); what is checked here is
// that a push reads the source when it is built, so an override source reaches it.
describe('the text source', () => {
  afterEach(() => setBotTextSource(defaultBotTextSource));

  it('builds a push from the source in place at the moment it is built', () => {
    setBotTextSource({
      sourceOf: (key) =>
        key === 'blocked' ? '<b>ЗАГЛУШКА blocked</b>' : defaultBotTextSource.sourceOf(key),
    });
    expect(linkPushMessage({ kind: LinkPushKind.Blocked }).text.value).toBe(
      '<b>ЗАГЛУШКА blocked</b>',
    );
  });
});

describe('the link push message', () => {
  const sent = async (outcome: LinkPushOutcome) => {
    const notifier = createClientPush({ token: TOKEN });
    const { calls } = captureApi(notifier);
    await notifier.sendLink(TELEGRAM_USER_ID, outcome);
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
    expect(payload?.text).toBe(CLIENT_TEXTS.confirmPrompt.value);
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
    expect(payload?.text).toBe(CLIENT_TEXTS.confirmPrompt.value);
  });

  // #350: every push has its next step, the bot's own buttons
  const CONNECT_AGAIN = [
    { text: CLIENT_LABELS.connectButton, callback_data: 'connect' },
    { text: CLIENT_LABELS.menuButton, callback_data: 'menu' },
  ];
  it('sends active with the account address in its text, and the demo button', async () => {
    const payload = await sent({ kind: LinkPushKind.Active, email: 'ada@example.test' });
    expect(payload?.text).toBe(CLIENT_TEXTS.linkedActive({ email: 'ada@example.test' }).value);
    expect(inlineButtons(payload)).toEqual([
      { text: CLIENT_LABELS.demoButton, callback_data: 'demo' },
    ]);
  });

  // #358 P1: the address an overridden text holds, or its stand-in
  it('puts the address into an overridden linkedActive, escaped, or says it is unknown', async () => {
    setBotTextSource({
      sourceOf: (key) =>
        key === 'linkedActive' ? '✅ {email} подключён' : defaultBotTextSource.sourceOf(key),
    });
    try {
      const known = await sent({ kind: LinkPushKind.Active, email: 'a&b@example.test' });
      expect(known?.text).toBe('✅ a&amp;b@example.test подключён');
      const unknown = await sent({ kind: LinkPushKind.Active, email: null });
      expect(unknown?.text).toBe('✅ адрес неизвестен подключён');
    } finally {
      setBotTextSource(defaultBotTextSource);
    }
  });

  it.each([
    [
      LinkPushKind.Blocked,
      CLIENT_TEXTS.blocked,
      [{ text: CLIENT_LABELS.supportButton, url: 'https://t.me/dimmelya' }],
    ],
    [LinkPushKind.Taken, CLIENT_TEXTS.accountTaken, CONNECT_AGAIN],
    [LinkPushKind.ExchangeFailed, CLIENT_TEXTS.oauthLoginFailed, CONNECT_AGAIN],
    [LinkPushKind.Mismatch, CLIENT_TEXTS.oauthLoginFailed, CONNECT_AGAIN],
  ] as const)('sends %s with its next step', async (kind, text, buttons) => {
    const payload = await sent({ kind });
    expect(payload?.text).toBe(text.value);
    expect(inlineButtons(payload)).toEqual(buttons);
  });
});

describe('the mailing push', () => {
  it('sends the message as Telegram HTML with its keyboard, to the chat as a string', async () => {
    const push = createClientPush({ token: TOKEN });
    const { calls } = captureApi(push);
    const reply_markup = new InlineKeyboard().text(CLIENT_LABELS.demoButton, 'demo');
    await push.sendMailing(TELEGRAM_USER_ID, {
      text: telegramHtml`<b>a &amp; b</b>`,
      reply_markup,
    });
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    const payload = sentPayload(calls, 'sendMessage');
    expect(payload?.chat_id).toBe('9007199254740993');
    expect(payload?.parse_mode).toBe('HTML');
    expect(payload?.text).toBe('<b>a &amp; b</b>');
    expect(inlineButtons(payload)).toEqual([
      { text: CLIENT_LABELS.demoButton, callback_data: 'demo' },
    ]);
  });
});

describe('the session notices (#464)', () => {
  it('sends a trade as Telegram HTML without sound and without a keyboard, answering its message_id', async () => {
    const push = createClientPush({ token: TOKEN });
    const { calls, answers } = captureApi(push);
    answers.set('sendMessage', () => ({ message_id: 4242 }));
    expect(await push.sendSessionTrade(TELEGRAM_USER_ID, telegramHtml`<pre>a &amp; b</pre>`)).toBe(
      4242,
    );
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    expect(sentPayload(calls, 'sendMessage')).toEqual({
      chat_id: '9007199254740993',
      text: '<pre>a &amp; b</pre>',
      parse_mode: 'HTML',
      disable_notification: true,
    });
  });

  it('edits the cycle message (#551) as Telegram HTML without a keyboard', async () => {
    const push = createClientPush({ token: TOKEN });
    const { calls } = captureApi(push);
    await push.editSessionTrade(TELEGRAM_USER_ID, 4242, telegramHtml`<pre>a &amp; b</pre>`);
    expect(calls.map((call) => call.method)).toEqual(['editMessageText']);
    expect(sentPayload(calls, 'editMessageText')).toEqual({
      chat_id: '9007199254740993',
      message_id: 4242,
      text: '<pre>a &amp; b</pre>',
      parse_mode: 'HTML',
    });
  });

  it('sends the summary with its keyboard and with sound', async () => {
    const push = createClientPush({ token: TOKEN });
    const { calls } = captureApi(push);
    const reply_markup = new InlineKeyboard().text(CLIENT_LABELS.menuButton, 'menu');
    await push.sendSessionSummary(TELEGRAM_USER_ID, { text: telegramHtml`итог`, reply_markup });
    const payload = sentPayload(calls, 'sendMessage');
    expect(payload?.disable_notification).toBeUndefined();
    expect(inlineButtons(payload)).toEqual([
      { text: CLIENT_LABELS.menuButton, callback_data: 'menu' },
    ]);
  });
});

describe('the deposit push', () => {
  const money = (value: string) => value as DecimalString;
  const sent = async (balance: Parameters<ClientPush['sendDepositCredited']>[1]) => {
    const push = createClientPush({ token: TOKEN });
    const { calls } = captureApi(push);
    await push.sendDepositCredited(TELEGRAM_USER_ID, balance);
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    const payload = sentPayload(calls, 'sendMessage');
    expect(payload?.chat_id).toBe('9007199254740993');
    expect(payload?.parse_mode).toBe('HTML');
    expect(inlineButtons(payload)).toEqual([
      { text: CLIENT_LABELS.menuButton, callback_data: 'menu' },
    ]);
    return payload;
  };

  it('prints a fresh real balance from its DecimalString, with the menu button', async () => {
    const payload = await sent({ amount: money('1234.50000000'), fresh: true });
    expect(payload?.text).toBe(
      `💳 <b>Пополнение получено</b>\nРеальный баланс: ${formatUsd('1234.50000000')}`,
    );
    expect(payload?.text).toMatch(/\$1\D234\.50$/);
  });

  it('says there is no fresh data for a stale or missing snapshot', async () => {
    const stale = await sent({ amount: money('1234.5'), fresh: false });
    expect(stale?.text).toBe(
      CLIENT_TEXTS.depositCredited({ realBalance: { amount: money('1234.5'), fresh: false } })
        .value,
    );
    expect(stale?.text).not.toContain('1234');
    const missing = await sent(null);
    expect(missing?.text).toBe(stale?.text);
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
    const notifier = createClientPush({ token: TOKEN, apiRoot, telegramApiTimeoutMs: 500 });

    const at = Date.now();
    const error = await rejectionOf(
      notifier.sendLink(TELEGRAM_USER_ID, { kind: LinkPushKind.Active, email: null }),
    );
    const elapsed = Date.now() - at;
    expect(error).toBeInstanceOf(HttpError);
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(UNIT_WAIT_CEILING_MS);
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
    const notifier = createClientPush({ token: TOKEN, apiRoot });

    const error = await rejectionOf(
      notifier.sendLink(TELEGRAM_USER_ID, { kind: LinkPushKind.Active, email: null }),
    );
    expect(error).toBeInstanceOf(GrammyError);
    expect((error as GrammyError).error_code).toBe(403);
    expect((error as GrammyError).method).toBe('sendMessage');
  });
});
