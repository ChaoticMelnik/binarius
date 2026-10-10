import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOT_PROFILE_METHODS,
  BOT_TEXT_CATALOG,
  defaultBotTextSource,
  type BotTextKey,
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
  answer: (method: string) => { status: number; body: unknown } | 'silence' = () => ({
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
      received.push({ method, payload: raw === '' ? {} : JSON.parse(raw) });
      const reply = answer(method);
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

const DEFAULT_MENU = [
  { command: 'start', description: 'Начать' },
  { command: 'menu', description: 'Главное меню' },
  { command: 'stop', description: 'Остановить сессию' },
  { command: 'account', description: 'Аккаунт Binodex' },
  { command: 'settings', description: 'Настройки уведомлений' },
  { command: 'help', description: 'Помощь' },
  { command: 'support', description: 'Поддержка' },
];

describe('publishBotProfile', () => {
  it('U2 sends the menu, the description and the short description from the source', async () => {
    const { apiRoot, received } = await telegram();
    const api = createBotProfileApi({ token: TOKEN, apiRoot });
    const source = withOverride('startCommand', 'Поехали');

    const results = await publishBotProfile(api, source, BOT_PROFILE_METHODS);

    expect(results).toEqual([
      { method: 'setMyCommands', ok: true },
      { method: 'setMyDescription', ok: true },
      { method: 'setMyShortDescription', ok: true },
    ]);
    // equality on the whole payload: a language_code would fail it
    expect(received).toEqual([
      {
        method: 'setMyCommands',
        payload: {
          commands: [{ command: 'start', description: 'Поехали' }, ...DEFAULT_MENU.slice(1)],
          scope: { type: 'all_private_chats' },
        },
      },
      {
        method: 'setMyDescription',
        payload: { description: BOT_TEXT_CATALOG.profileDescription.source },
      },
      {
        method: 'setMyShortDescription',
        payload: { short_description: BOT_TEXT_CATALOG.profileShortDescription.source },
      },
    ]);
  });

  it('U3 reports a refusal by identity, and still sends the rest in order', async () => {
    const { apiRoot, received } = await telegram((method) =>
      method === 'setMyDescription'
        ? {
            status: 400,
            body: { ok: false, error_code: 400, description: 'Bad Request: secret description' },
          }
        : { status: 200, body: { ok: true, result: true } },
    );
    const api = createBotProfileApi({ token: TOKEN, apiRoot });

    const results = await publishBotProfile(api, defaultBotTextSource, BOT_PROFILE_METHODS);

    expect(results).toEqual([
      { method: 'setMyCommands', ok: true },
      {
        method: 'setMyDescription',
        ok: false,
        err: { name: 'GrammyError' },
        telegramErrorCode: 400,
      },
      { method: 'setMyShortDescription', ok: true },
    ]);
    expect(received.map((call) => call.method)).toEqual(BOT_PROFILE_METHODS);
    expect(JSON.stringify(results)).not.toContain('secret');
  });

  it('U4 ends a call Telegram does not answer at the configured timeout, with the cause', async () => {
    const { apiRoot } = await telegram(() => 'silence');
    const api = createBotProfileApi({ token: TOKEN, apiRoot, telegramApiTimeoutMs: 50 });

    const at = Date.now();
    const results = await publishBotProfile(api, defaultBotTextSource, ['setMyShortDescription']);
    const elapsed = Date.now() - at;

    expect(results).toEqual([
      {
        method: 'setMyShortDescription',
        ok: false,
        err: { name: 'HttpError' },
        cause: { name: 'Error' },
      },
    ]);
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(UNIT_WAIT_CEILING_MS);
  });

  it('U5 sends only the methods asked for', async () => {
    const { apiRoot, received } = await telegram();
    const api = createBotProfileApi({ token: TOKEN, apiRoot });

    const results = await publishBotProfile(api, defaultBotTextSource, ['setMyCommands']);

    expect(results).toEqual([{ method: 'setMyCommands', ok: true }]);
    expect(received.map((call) => call.method)).toEqual(['setMyCommands']);
  });

  it('U7 makes as many calls as the timing chain counts', () => {
    expect(BOT_PROFILE_METHODS).toHaveLength(BOT_PROFILE_PUBLISH_CALLS);
  });
});
