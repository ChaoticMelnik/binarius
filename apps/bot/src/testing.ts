// Test-only fixtures and harness for this app's suites. Compiled by `tsc -b` alongside the
// *.test.ts files next to it and imported by no runtime module.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Bot, HttpError } from 'grammy';
import type { ApiError, Update, User, UserFromGetMe } from 'grammy/types';
import { vi, type Mock } from 'vitest';

export const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'Binarius',
  username: 'binarius_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export const USER: User = { id: 4242, is_bot: false, first_name: 'Ada', last_name: 'Lovelace' };

export interface FakeLogger {
  info: Mock;
  warn: Mock;
  error: Mock;
  debug: Mock;
}

export const fakeLogger = (): FakeLogger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

let updateId = 0;

export const startUpdate = (text: string, chatType = 'private', from: User = USER): Update =>
  ({
    update_id: ++updateId,
    message: {
      message_id: ++updateId,
      date: 1,
      chat: { id: from.id, type: chatType, first_name: from.first_name },
      from,
      text,
      entities: [{ type: 'bot_command', offset: 0, length: '/start'.length }],
    },
  }) as unknown as Update;

export const connectUpdate = (data: string, chatType = 'private'): Update =>
  ({
    update_id: ++updateId,
    callback_query: {
      id: 'query-1',
      from: USER,
      chat_instance: 'instance-1',
      data,
      message: {
        message_id: ++updateId,
        date: 1,
        chat: { id: USER.id, type: chatType, first_name: USER.first_name },
        from: { ...BOT_INFO },
      },
    },
  }) as unknown as Update;

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

// A programmed answer: the value becomes the `result` of an `ok: true` response, and throwing
// leaves the call the way the transport leaves it. This is also the only way to inject a failure
// the real transport never produces — apiErrors deliberately cannot, see below.
export type ApiAnswer = (
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => unknown | Promise<unknown>;

export interface CapturedApi {
  calls: ApiCall[];
  // an entry makes that method answer the way Telegram would when it refuses (ApiError, which
  // grammY turns into a GrammyError), or fail the way the transport does — HttpError, the only
  // thing grammY's transport throws (core/client.js, toHttpError)
  apiErrors: Map<string, ApiError | HttpError>;
  answers: Map<string, ApiAnswer>;
}

// Every outgoing Bot API call is recorded here instead of reaching Telegram. Unprogrammed
// methods answer `result: true`, which no handler reads today; the first handler that reads
// what a Bot API call returned has to be given a typed answer here instead.
export function captureApi(bot: Bot): CapturedApi {
  const captured: CapturedApi = { calls: [], apiErrors: new Map(), answers: new Map() };
  bot.api.config.use(((
    _prev,
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    captured.calls.push({ method, payload });
    const failure = captured.apiErrors.get(method);
    if (failure instanceof Error) throw failure;
    const answer = captured.answers.get(method);
    if (answer !== undefined) {
      return Promise.resolve(answer(payload, signal)).then((result) => ({ ok: true, result }));
    }
    return Promise.resolve(failure ?? { ok: true, result: true });
  }) as Parameters<typeof bot.api.config.use>[0]);
  return captured;
}

export const sentPayload = (
  calls: readonly ApiCall[],
  method: string,
): Record<string, unknown> | undefined => calls.find((call) => call.method === method)?.payload;

export const inlineButtons = (payload: Record<string, unknown> | undefined) =>
  (
    payload?.reply_markup as {
      inline_keyboard?: { text: string; callback_data?: string; url?: string }[][];
    }
  )?.inline_keyboard?.flat() ?? [];

// An ephemeral loopback server: `listen` returns the base URL the client should be pointed at.
export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
