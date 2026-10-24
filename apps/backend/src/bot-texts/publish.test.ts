import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOT_PROFILE_METHODS,
  BOT_TEXT_CATALOG,
  BOT_TEXT_SOURCES_EN,
  BotLanguage,
  defaultBotTextSource,
  enBotTextSource,
  type BotTextKey,
  type BotTextSource,
} from '@binarius/shared';
import { UNIT_WAIT_CEILING_MS } from '@binarius/shared/testing';
import { BOT_PROFILE_PUBLISH_CALLS } from '../timing';
import { createBotProfileApi, publishBotProfile } from './publish';

const TOKEN = '123456:AA-profile-publish-token';

interface Received {
  method: string;
  payload: unknown;
}

// A Bot API that records each call and answers it as `answer` says: ok, a refusal, or silence.
let server: Server | undefined;
async function telegram(
  answer: (
    method: string,
    payload: unknown,
  ) => { status: number; body: unknown } | 'silence' = () => ({
    status: 200,
    body: { ok: true, result: true },
  }),
) {
  const received: Received[] = [];
  server = createServer((request: IncomingMessage, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    request.on('end', () => {
      const method = String(request.url).split('/').at(-1) ?? '';
      const payload: unknown = raw === '' ? {} : JSON.parse(raw);
      received.push({ method, payload });
      const reply = answer(method, payload);
      if (reply === 'silence') return;
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { apiRoot: `http://127.0.0.1:${port}`, received };
}

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running === undefined) return;
  running.closeAllConnections();
  await new Promise<void>((resolve) => running.close(() => resolve()));
});

const withOverride = (key: BotTextKey, text: string) => ({
  sourceOf: (k: BotTextKey) => (k === key ? text : defaultBotTextSource.sourceOf(k)),
});
// what readBotProfileSource gives with no override (#508)
const sourcesOf = (ru: BotTextSource<BotTextKey> = defaultBotTextSource) => ({
  [BotLanguage.Ru]: ru,
  [BotLanguage.En]: enBotTextSource,
});
// a method's two calls run side by side, so the server may take them in either order
const byLanguage = (received: readonly Received[]) =>
  [...received].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

const DEFAULT_MENU = [
  { command: 'start', description: 'Начать' },
  { command: 'menu', description: 'Главное меню' },
  { command: 'stop', description: 'Остановить сессию' },
  { command: 'account', description: 'Аккаунт Binodex' },
  { command: 'buy', description: 'Купить токены' },
  { command: 'settings', description: 'Настройки уведомлений' },
  { command: 'language', description: 'Язык бота' },
  { command: 'invite', description: 'Пригласить друга' },
  { command: 'help', description: 'Помощь' },
  { command: 'support', description: 'Поддержка' },
  { command: 'paysupport', description: 'Вопросы по оплате Stars и возврат' },
];

const EN_MENU = [
  { command: 'start', description: 'Start' },
  { command: 'menu', description: 'Main menu' },
  { command: 'stop', description: 'Stop the session' },
  { command: 'account', description: 'Binodex account' },
  { command: 'buy', description: 'Buy tokens' },
  { command: 'settings', description: 'Notification settings' },
  { command: 'language', description: 'Bot language' },
  { command: 'invite', description: 'Invite a friend' },
  { command: 'help', description: 'Help' },
  { command: 'support', description: 'Support' },
  { command: 'paysupport', description: 'Stars payment questions and refunds' },
];

describe('publishBotProfile', () => {
  it('U2 sends the menu, the description and the short description in both languages: Russian from the source under language_code ru, English as the default', async () => {
    const { apiRoot, received } = await telegram();
    const api = createBotProfileApi({ token: TOKEN, apiRoot });
    const source = withOverride('startCommand', 'Поехали');

    const results = await publishBotProfile(api, sourcesOf(source), BOT_PROFILE_METHODS);

    expect(results).toEqual([
      { method: 'setMyCommands', ok: true },
      { method: 'setMyDescription', ok: true },
      { method: 'setMyShortDescription', ok: true },
    ]);
    // equality on the whole payloads: language_code only on the Russian ones
    expect(received.map((call) => call.method)).toEqual(
      BOT_PROFILE_METHODS.flatMap((method) => [method, method]),
    );
    expect(byLanguage(received)).toEqual(
      byLanguage([
        {
          method: 'setMyCommands',
          payload: {
            commands: [{ command: 'start', description: 'Поехали' }, ...DEFAULT_MENU.slice(1)],
            scope: { type: 'all_private_chats' },
            language_code: 'ru',
          },
        },
        {
          method: 'setMyCommands',
          payload: { commands: EN_MENU, scope: { type: 'all_private_chats' } },
        },
        {
          method: 'setMyDescription',
          payload: {
            description: BOT_TEXT_CATALOG.profileDescription.source,
            language_code: 'ru',
          },
        },
        {
          method: 'setMyDescription',
          payload: { description: BOT_TEXT_SOURCES_EN.profileDescription },
        },
        {
          method: 'setMyShortDescription',
          payload: {
            short_description: BOT_TEXT_CATALOG.profileShortDescription.source,
            language_code: 'ru',
          },
        },
        {
          method: 'setMyShortDescription',
          payload: { short_description: BOT_TEXT_SOURCES_EN.profileShortDescription },
        },
      ]),
    );
  });

  it('U3 reports a refusal by identity, and still sends the rest in order', async () => {
    // only the English description is refused (no language_code): the method fails in it
    const { apiRoot, received } = await telegram((method, payload) =>
      method === 'setMyDescription' &&
      (payload as { language_code?: string }).language_code === undefined
        ? {
            status: 400,
            body: { ok: false, error_code: 400, description: 'Bad Request: secret description' },
          }
        : { status: 200, body: { ok: true, result: true } },
    );
    const api = createBotProfileApi({ token: TOKEN, apiRoot });

    const results = await publishBotProfile(api, sourcesOf(), BOT_PROFILE_METHODS);

    expect(results).toEqual([
      { method: 'setMyCommands', ok: true },
      {
        method: 'setMyDescription',
        ok: false,
        err: { name: 'GrammyError' },
        telegramErrorCode: 400,
        language: BotLanguage.En,
      },
      { method: 'setMyShortDescription', ok: true },
    ]);
    expect(received.map((call) => call.method)).toEqual(
      BOT_PROFILE_METHODS.flatMap((method) => [method, method]),
    );
    expect(JSON.stringify(results)).not.toContain('secret');
  });

  it('U4 ends a call Telegram does not answer at the configured timeout, with the cause', async () => {
    const { apiRoot } = await telegram(() => 'silence');
    const api = createBotProfileApi({ token: TOKEN, apiRoot, telegramApiTimeoutMs: 50 });

    const at = Date.now();
    const results = await publishBotProfile(api, sourcesOf(), ['setMyShortDescription']);
    const elapsed = Date.now() - at;

    expect(results).toEqual([
      {
        method: 'setMyShortDescription',
        ok: false,
        err: { name: 'HttpError' },
        cause: { name: 'Error' },
        language: BotLanguage.Ru,
      },
    ]);
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(UNIT_WAIT_CEILING_MS);
  });

  it('U5 sends only the methods asked for', async () => {
    const { apiRoot, received } = await telegram();
    const api = createBotProfileApi({ token: TOKEN, apiRoot });

    const results = await publishBotProfile(api, sourcesOf(), ['setMyCommands']);

    expect(results).toEqual([{ method: 'setMyCommands', ok: true }]);
    expect(received.map((call) => call.method)).toEqual(['setMyCommands', 'setMyCommands']);
  });

  // a save or a reset publishes its key's language only (#634)
  it('U8 sends only the languages asked for', async () => {
    const { apiRoot, received } = await telegram();
    const api = createBotProfileApi({ token: TOKEN, apiRoot });

    const en = await publishBotProfile(api, sourcesOf(), ['setMyCommands'], [BotLanguage.En]);
    expect(en).toEqual([{ method: 'setMyCommands', ok: true }]);
    expect(received).toEqual([
      {
        method: 'setMyCommands',
        payload: { commands: EN_MENU, scope: { type: 'all_private_chats' } },
      },
    ]);

    received.length = 0;
    await publishBotProfile(api, sourcesOf(), ['setMyShortDescription'], [BotLanguage.Ru]);
    expect(received).toEqual([
      {
        method: 'setMyShortDescription',
        payload: {
          short_description: BOT_TEXT_CATALOG.profileShortDescription.source,
          language_code: 'ru',
        },
      },
    ]);
  });

  // a slot a method: its two languages run side by side under one client timeout (#508)
  it('U7 makes as many slots as the timing chain counts', () => {
    expect(BOT_PROFILE_METHODS).toHaveLength(BOT_PROFILE_PUBLISH_CALLS);
  });
});
