import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { GrammyError, HttpError, InlineKeyboard } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BotLanguage,
  BOT_MESSAGE_SPACER,
  ButtonRole,
  BOT_TEXT_SOURCES_EN,
  callbackButton,
  confirmButtonLabel,
  defaultBotTextSource,
  keyboardOf,
  formatUsd,
  telegramHtml,
  type DecimalString,
} from '@binarius/shared';
import { UNIT_WAIT_CEILING_MS } from '@binarius/shared/testing';
import {
  captureApi,
  inlineButtons,
  inlineRoles,
  inlineStyles,
  pushedText,
  sentPayload,
} from '../admin/testing';
import {
  createClientPush,
  type ClientPush,
  depositCreditedMessage,
  LinkPushKind,
  linkPushMessage,
  type LinkPushOutcome,
} from './client-push';
import {
  sessionCycleStopKeyboard,
  sessionWaitingMessage,
} from '../trading/session-notice-messages';
import { clientLabelsOf, clientTextsOf, setBotTextSource } from './texts';

// the Russian texts, the language of every user these tests make (#633)
const RU_TEXTS = clientTextsOf(BotLanguage.Ru);
const RU_LABELS = clientLabelsOf(BotLanguage.Ru);

const TOKEN = '123456:AA-link-push-token';
const ACCOUNT_ID = '0b7e3a52-8c1d-4f6e-9a2b-3c4d5e6f7a8b';
// above 2^53, so a conversion through number would round it
const TELEGRAM_USER_ID = 9_007_199_254_740_993n;
const SESSION_ID = '00000000-0000-4000-8000-000000000000';

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
    expect(linkPushMessage({ kind: LinkPushKind.Blocked }, BotLanguage.Ru).text.value).toBe(
      '<b>ЗАГЛУШКА blocked</b>',
    );
  });
});

// #633: every push of this seam in the recipient's language
describe('the pushes in English (#633)', () => {
  const En = BotLanguage.En;
  const EN_TEXTS = clientTextsOf(En);
  const EN_LABELS = clientLabelsOf(En);
  const CYRILLIC = /[А-Яа-яЁё]/u;
  const labelsOf = (message: { reply_markup: unknown }) =>
    inlineButtons({ reply_markup: message.reply_markup }).map((button) => button.text);
  const OUTCOMES: LinkPushOutcome[] = [
    { kind: LinkPushKind.Pending, account: { id: ACCOUNT_ID, email: 'ada@example.test' } },
    { kind: LinkPushKind.Active, email: 'ada@example.test' },
    { kind: LinkPushKind.Blocked },
    { kind: LinkPushKind.Taken },
    { kind: LinkPushKind.ExchangeFailed },
    { kind: LinkPushKind.Mismatch },
  ];

  it.each(OUTCOMES.map((outcome) => [outcome.kind, outcome] as const))(
    'C-lang1 the link push %s: the English text and labels',
    (_kind, outcome) => {
      const message = linkPushMessage(outcome, En);
      expect(message.text.value).not.toMatch(CYRILLIC);
      for (const label of labelsOf(message)) expect(label).not.toMatch(CYRILLIC);
    },
  );

  it('C-lang1 the pending push asks in English with the English confirm label', () => {
    const message = linkPushMessage(OUTCOMES[0]!, En);
    expect(message.text.value).toBe(BOT_TEXT_SOURCES_EN.confirmPrompt);
    expect(labelsOf(message)).toEqual([confirmButtonLabel(EN_LABELS, 'ada@example.test')]);
    expect(linkPushMessage({ kind: LinkPushKind.Taken }, En).text).toBe(EN_TEXTS.accountTaken);
    expect(labelsOf(linkPushMessage({ kind: LinkPushKind.Taken }, En))).toEqual([
      EN_LABELS.connectButton,
      EN_LABELS.menuButton,
    ]);
  });

  it('C-lang2 the deposit push: the English text and the English menu label', () => {
    const message = depositCreditedMessage(null, En);
    expect(message.text.value).toBe(EN_TEXTS.depositCredited({ realBalance: null }).value);
    expect(message.text.value).not.toMatch(CYRILLIC);
    expect(labelsOf(message)).toEqual([BOT_TEXT_SOURCES_EN.menuButton]);
  });

  it('C-lang3 sendLink sends the English confirm prompt', async () => {
    const notifier = createClientPush({ token: TOKEN });
    const { calls } = captureApi(notifier);
    await notifier.sendLink(TELEGRAM_USER_ID, En, OUTCOMES[0]!);
    expect(pushedText(sentPayload(calls, 'sendMessage'))).toBe(BOT_TEXT_SOURCES_EN.confirmPrompt);
  });
});

describe('the link push message', () => {
  const sent = async (outcome: LinkPushOutcome) => {
    const notifier = createClientPush({ token: TOKEN });
    const { calls } = captureApi(notifier);
    await notifier.sendLink(TELEGRAM_USER_ID, BotLanguage.Ru, outcome);
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
    expect(pushedText(payload)).toBe(RU_TEXTS.confirmPrompt.value);
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
    expect(pushedText(payload)).toBe(RU_TEXTS.confirmPrompt.value);
  });

  // #350: every push has its next step, the bot's own buttons
  const CONNECT_AGAIN = [
    { text: RU_LABELS.connectButton, callback_data: 'connect' },
    { text: RU_LABELS.menuButton, callback_data: 'menu' },
  ];
  it('sends active with the account address in its text, and the demo button', async () => {
    const payload = await sent({ kind: LinkPushKind.Active, email: 'ada@example.test' });
    expect(pushedText(payload)).toBe(RU_TEXTS.linkedActive({ email: 'ada@example.test' }).value);
    expect(inlineButtons(payload)).toEqual([{ text: RU_LABELS.demoButton, callback_data: 'demo' }]);
  });

  // #358 P1: the address an overridden text holds, or its stand-in
  it('puts the address into an overridden linkedActive, escaped, or says it is unknown', async () => {
    setBotTextSource({
      sourceOf: (key) =>
        key === 'linkedActive' ? '✅ {email} подключён' : defaultBotTextSource.sourceOf(key),
    });
    try {
      const known = await sent({ kind: LinkPushKind.Active, email: 'a&b@example.test' });
      expect(pushedText(known)).toBe('✅ a&amp;b@example.test подключён');
      const unknown = await sent({ kind: LinkPushKind.Active, email: null });
      expect(pushedText(unknown)).toBe('✅ адрес неизвестен подключён');
    } finally {
      setBotTextSource(defaultBotTextSource);
    }
  });

  it.each([
    [
      LinkPushKind.Blocked,
      RU_TEXTS.blocked,
      [{ text: RU_LABELS.supportButton, url: 'https://t.me/dimmelya' }],
    ],
    [LinkPushKind.Taken, RU_TEXTS.accountTaken, CONNECT_AGAIN],
    [LinkPushKind.ExchangeFailed, RU_TEXTS.oauthLoginFailed, CONNECT_AGAIN],
    [LinkPushKind.Mismatch, RU_TEXTS.oauthLoginFailed, CONNECT_AGAIN],
  ] as const)('sends %s with its next step', async (kind, text, buttons) => {
    const payload = await sent({ kind });
    expect(pushedText(payload)).toBe(text.value);
    expect(inlineButtons(payload)).toEqual(buttons);
  });
});

describe('the mailing push', () => {
  it('sends the message as Telegram HTML with its keyboard, to the chat as a string', async () => {
    const push = createClientPush({ token: TOKEN });
    const { calls } = captureApi(push);
    const reply_markup = keyboardOf([
      callbackButton(ButtonRole.Forward, RU_LABELS.demoButton, 'demo'),
    ]);
    await push.sendMailing(TELEGRAM_USER_ID, {
      text: telegramHtml`<b>a &amp; b</b>`,
      reply_markup,
    });
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    const payload = sentPayload(calls, 'sendMessage');
    expect(payload?.chat_id).toBe('9007199254740993');
    expect(payload?.parse_mode).toBe('HTML');
    expect(pushedText(payload)).toBe('<b>a &amp; b</b>');
    expect(inlineButtons(payload)).toEqual([{ text: RU_LABELS.demoButton, callback_data: 'demo' }]);
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
    const payload = sentPayload(calls, 'sendMessage');
    expect({ ...payload, text: pushedText(payload) }).toEqual({
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
    const payload = sentPayload(calls, 'editMessageText');
    expect({ ...payload, text: pushedText(payload) }).toEqual({
      chat_id: '9007199254740993',
      message_id: 4242,
      text: '<pre>a &amp; b</pre>',
      parse_mode: 'HTML',
    });
  });

  it("sends and edits the cycle message with the open block's «⏹» when given one (#722)", async () => {
    const push = createClientPush({ token: TOKEN });
    const { calls, answers } = captureApi(push);
    answers.set('sendMessage', () => ({ message_id: 4242 }));
    const reply_markup = sessionCycleStopKeyboard(SESSION_ID, BotLanguage.Ru);
    await push.sendSessionTrade(TELEGRAM_USER_ID, telegramHtml`<b>open</b>`, reply_markup);
    await push.editSessionTrade(TELEGRAM_USER_ID, 4242, telegramHtml`<b>open</b>`, reply_markup);
    expect(calls.map((call) => call.method)).toEqual(['sendMessage', 'editMessageText']);
    const stop = [
      { text: RU_LABELS.sessionStopButton, callback_data: `session:stop:${SESSION_ID}:c` },
    ];
    expect(inlineButtons(sentPayload(calls, 'sendMessage'))).toEqual(stop);
    expect(inlineButtons(sentPayload(calls, 'editMessageText'))).toEqual(stop);
    expect(sentPayload(calls, 'sendMessage')?.disable_notification).toBe(true);
  });

  it('sends the summary with its keyboard and with sound', async () => {
    const push = createClientPush({ token: TOKEN });
    const { calls } = captureApi(push);
    const reply_markup = keyboardOf([callbackButton(ButtonRole.Nav, RU_LABELS.menuButton, 'menu')]);
    await push.sendSessionSummary(TELEGRAM_USER_ID, { text: telegramHtml`итог`, reply_markup });
    const payload = sentPayload(calls, 'sendMessage');
    expect(payload?.disable_notification).toBeUndefined();
    expect(inlineButtons(payload)).toEqual([{ text: RU_LABELS.menuButton, callback_data: 'menu' }]);
  });
});

describe('the waiting message (#536)', () => {
  it('sends it as Telegram HTML without sound, with its keyboard, answering its message_id', async () => {
    const push = createClientPush({ token: TOKEN });
    const { calls, answers } = captureApi(push);
    answers.set('sendMessage', () => ({ message_id: 4243 }));
    const reply_markup = keyboardOf([
      callbackButton(ButtonRole.Danger, RU_LABELS.sessionStopButton, 'session:x'),
    ]);
    expect(
      await push.sendSessionWaiting(TELEGRAM_USER_ID, {
        text: telegramHtml`<b>ждём</b>`,
        reply_markup,
      }),
    ).toBe(4243);
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    const payload = sentPayload(calls, 'sendMessage');
    expect({ ...payload, text: pushedText(payload) }).toMatchObject({
      chat_id: '9007199254740993',
      text: '<b>ждём</b>',
      parse_mode: 'HTML',
      disable_notification: true,
    });
    expect(inlineButtons(payload)).toEqual([
      { text: RU_LABELS.sessionStopButton, callback_data: 'session:x' },
    ]);
  });

  it('deletes it by its id', async () => {
    const push = createClientPush({ token: TOKEN });
    const { calls } = captureApi(push);
    await push.deleteSessionWaiting(TELEGRAM_USER_ID, 4243);
    expect(calls.map((call) => call.method)).toEqual(['deleteMessage']);
    expect(sentPayload(calls, 'deleteMessage')).toEqual({
      chat_id: '9007199254740993',
      message_id: 4243,
    });
  });
});

describe('the deposit push', () => {
  const money = (value: string) => value as DecimalString;
  const sent = async (balance: Parameters<ClientPush['sendDepositCredited']>[2]) => {
    const push = createClientPush({ token: TOKEN });
    const { calls } = captureApi(push);
    await push.sendDepositCredited(TELEGRAM_USER_ID, BotLanguage.Ru, balance);
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    const payload = sentPayload(calls, 'sendMessage');
    expect(payload?.chat_id).toBe('9007199254740993');
    expect(payload?.parse_mode).toBe('HTML');
    expect(inlineButtons(payload)).toEqual([{ text: RU_LABELS.menuButton, callback_data: 'menu' }]);
    return payload;
  };

  it('prints a fresh real balance from its DecimalString, with the menu button', async () => {
    const payload = await sent({ amount: money('1234.50000000'), fresh: true });
    expect(pushedText(payload)).toBe(
      `💳 <b>Пополнение получено</b>\nРеальный баланс: ${formatUsd('1234.50000000')}`,
    );
    expect(pushedText(payload)).toMatch(/\$1\D234\.50$/);
  });

  it('says there is no fresh data for a stale or missing snapshot', async () => {
    const stale = await sent({ amount: money('1234.5'), fresh: false });
    expect(pushedText(stale)).toBe(
      RU_TEXTS.depositCredited({ realBalance: { amount: money('1234.5'), fresh: false } }).value,
    );
    expect(pushedText(stale)).not.toContain('1234');
    const missing = await sent(null);
    expect(pushedText(missing)).toBe(pushedText(stale));
  });
});

// #506: every text of this seam ends with the width spacer, read here as sent
describe('the width spacer (#506)', () => {
  const SPACED = '<b>x</b>' + BOT_MESSAGE_SPACER;
  const reply_markup = keyboardOf([callbackButton(ButtonRole.Nav, RU_LABELS.menuButton, 'menu')]);
  const pushed = () => {
    const push = createClientPush({ token: TOKEN });
    return { push, ...captureApi(push) };
  };

  it('send appends the width spacer', async () => {
    const { push, calls } = pushed();
    await push.sendMailing(TELEGRAM_USER_ID, { text: telegramHtml`<b>x</b>`, reply_markup });
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(SPACED);
  });

  it('sendSessionTrade appends the width spacer', async () => {
    const { push, calls, answers } = pushed();
    answers.set('sendMessage', () => ({ message_id: 1 }));
    await push.sendSessionTrade(TELEGRAM_USER_ID, telegramHtml`<b>x</b>`);
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(SPACED);
  });

  it('editSessionTrade appends the width spacer', async () => {
    const { push, calls } = pushed();
    await push.editSessionTrade(TELEGRAM_USER_ID, 1, telegramHtml`<b>x</b>`);
    expect(sentPayload(calls, 'editMessageText')?.text).toBe(SPACED);
  });

  it('sendSessionWaiting appends the width spacer', async () => {
    const { push, calls, answers } = pushed();
    answers.set('sendMessage', () => ({ message_id: 1 }));
    await push.sendSessionWaiting(TELEGRAM_USER_ID, { text: telegramHtml`<b>x</b>`, reply_markup });
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(SPACED);
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
      notifier.sendLink(TELEGRAM_USER_ID, BotLanguage.Ru, {
        kind: LinkPushKind.Active,
        email: null,
      }),
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
      notifier.sendLink(TELEGRAM_USER_ID, BotLanguage.Ru, {
        kind: LinkPushKind.Active,
        email: null,
      }),
    );
    expect(error).toBeInstanceOf(GrammyError);
    expect((error as GrammyError).error_code).toBe(403);
    expect((error as GrammyError).method).toBe('sendMessage');
  });
});

// #475 (docs/bot-navigation.md → Roles, colours and rows): each push's buttons by role
describe('the roles of the pushes (#475)', () => {
  const ACCOUNT = { id: ACCOUNT_ID, email: 'ada@example.test' };
  const roles = (message: { reply_markup: unknown }) => inlineRoles({ ...message });
  const styles = (message: { reply_markup: unknown }) => inlineStyles({ ...message });

  it('C1 pending: the confirm green, its own row', () => {
    const message = linkPushMessage(
      { kind: LinkPushKind.Pending, account: ACCOUNT },
      BotLanguage.Ru,
    );
    expect(roles(message)).toEqual([[ButtonRole.Forward]]);
    expect(styles(message)).toEqual([['success']]);
  });

  it('C2 active: the demo green', () => {
    const message = linkPushMessage({ kind: LinkPushKind.Active, email: null }, BotLanguage.Ru);
    expect(roles(message)).toEqual([[ButtonRole.Forward]]);
    expect(styles(message)).toEqual([['success']]);
  });

  it('C3 blocked: support, no colour', () => {
    const message = linkPushMessage({ kind: LinkPushKind.Blocked }, BotLanguage.Ru);
    expect(roles(message)).toEqual([[ButtonRole.Nav]]);
    expect(styles(message)).toEqual([[null]]);
  });

  it.each([LinkPushKind.Taken, LinkPushKind.ExchangeFailed, LinkPushKind.Mismatch] as const)(
    'C4 %s: connect again green on its own row, then the menu',
    (kind) => {
      const message = linkPushMessage({ kind }, BotLanguage.Ru);
      expect(roles(message)).toEqual([[ButtonRole.Forward], [ButtonRole.Nav]]);
      expect(styles(message)).toEqual([['success'], [null]]);
    },
  );

  it('C5 a credited deposit: the menu, no colour', () => {
    const message = depositCreditedMessage(null, BotLanguage.Ru);
    expect(roles(message)).toEqual([[ButtonRole.Nav]]);
  });

  it('C6 the waiting message: its «⏹» red', () => {
    const message = sessionWaitingMessage('00000000-0000-4000-8000-000000000000', BotLanguage.Ru);
    expect(roles(message)).toEqual([[ButtonRole.Danger]]);
    expect(styles(message)).toEqual([['danger']]);
  });

  it("C8 the open block's «⏹» (#722): red, its own row", () => {
    const message = { reply_markup: sessionCycleStopKeyboard(SESSION_ID, BotLanguage.Ru) };
    expect(roles(message)).toEqual([[ButtonRole.Danger]]);
    expect(styles(message)).toEqual([['danger']]);
  });

  it("C7 the suites refuse a keyboard built outside keyboardOf, as the bot's do", async () => {
    const push = createClientPush({ token: TOKEN });
    captureApi(push);
    const error = await rejectionOf(
      push.api.sendMessage('1', 'x', { reply_markup: new InlineKeyboard().text('x', 'menu') }),
    );
    expect(String(error)).toContain('sendMessage: a keyboard built outside keyboardOf');
  });

  // the backend's code, comment lines dropped, tests and their helpers out: every keyboard of a
  // push and of the staff bot is a BotKeyboard
  it('no grammY InlineKeyboard in the backend', () => {
    const SRC = fileURLToPath(new URL('..', import.meta.url));
    const sources = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter(
        (file) =>
          file.endsWith('.ts') &&
          !file.endsWith('.test.ts') &&
          !file.endsWith('.typecheck.ts') &&
          !file.endsWith('testing.ts'),
      )
      .map((file) => ({
        file,
        code: readFileSync(`${SRC}/${file}`, 'utf8').replace(/^\s*\/\/.*$/gm, ''),
      }));
    expect(sources.length).toBeGreaterThan(50);
    expect(
      sources
        .filter(({ code }) => /\bInlineKeyboard\b|inline_keyboard\s*:/.test(code))
        .map(({ file }) => file),
    ).toEqual([]);
  });
});
