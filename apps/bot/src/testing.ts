// Test-only fixtures and harness for this app's suites. Compiled by `tsc -b` alongside the
// *.test.ts files next to it and imported by no runtime module.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Bot, HttpError } from 'grammy';
import type { ApiError, Update, User, UserFromGetMe } from 'grammy/types';
import { vi, type Mock } from 'vitest';
import {
  BrokerAccountStatus,
  UserStatus,
  type ConfirmLoginResponse,
  type EmailSendCodeResponse,
  type LinkedAccountView,
  type PendingLinkedAccountView,
  type StartLoginResponse,
  type UserAccountView,
  type UserStartView,
} from '@binarius/shared';

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

export const USER_VIEW: UserStartView = {
  telegramUserId: String(USER.id),
  status: UserStatus.Active,
  acquisitionSource: null,
  acquiredAt: null,
  hasActiveBrokerAccount: false,
  pendingBrokerAccounts: [],
};

export const userView = (patch: Partial<UserStartView> = {}): UserStartView => ({
  ...USER_VIEW,
  ...patch,
});

export const LOGIN: StartLoginResponse = {
  authorizeUrl: 'https://binodex.app/oauth/authorize?state=abc',
  state: 'abc',
  expiresAt: '2026-09-24T10:10:00.000Z',
  miniAppUrl:
    'https://bot.example/oauth/login?authorize=https%3A%2F%2Fbinodex.app%2Foauth%2Fauthorize%3Fstate%3Dabc',
};

export const PENDING_ACCOUNT_ID = '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01';

// Seven, not the real pack size: a bot that printed its own number instead of the backend's
// would show up as a mismatch.
export const CONFIRMED: ConfirmLoginResponse = {
  account: {
    id: PENDING_ACCOUNT_ID,
    brokerUserId: '101962',
    email: 'ada@example.test',
    isPartnerClient: true,
    status: BrokerAccountStatus.Active,
    createdAt: '2026-10-01T09:28:00.000Z',
  },
  grant: { granted: true, tokens: '7' },
};

// /account (#185): one link of each status, and a user with none
export const LINK_ACTIVE: LinkedAccountView = {
  status: BrokerAccountStatus.Active,
  email: 'ada@example.test',
};
export const LINK_PENDING: PendingLinkedAccountView = {
  status: BrokerAccountStatus.Pending,
  id: PENDING_ACCOUNT_ID,
  email: 'new@example.test',
};
export const LINK_REVOKED: LinkedAccountView = {
  status: BrokerAccountStatus.Revoked,
  email: 'old@example.test',
};
export const ACCOUNT_VIEW: UserAccountView = { status: UserStatus.Active, accounts: [] };
export const accountView = (patch: Partial<UserAccountView> = {}): UserAccountView => ({
  ...ACCOUNT_VIEW,
  ...patch,
});

export const EMAIL = 'ada@example.test';
export const CODE = '123456';
export const CODE_SENT: EmailSendCodeResponse = { codeSent: true };

// the reason a promise rejected with, or undefined when it resolved: what a test needs when the
// assertion is about the error's identity rather than its message
export const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

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

// A plain message, the way the user sends an address or a code. A text starting with `/` carries
// the bot_command entity Telegram attaches to it, so a command reads as a command.
export const textUpdate = (text: string, chatType = 'private', from: User = USER): Update =>
  ({
    update_id: ++updateId,
    message: {
      message_id: ++updateId,
      date: 1,
      chat: { id: from.id, type: chatType, first_name: from.first_name },
      from,
      text,
      ...(text.startsWith('/')
        ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length }] }
        : {}),
    },
  }) as unknown as Update;

// The bot's own membership changing in a chat: in a private chat Telegram sends `kicked` when the
// user blocks the bot and `member` when they unblock it.
export const chatMemberUpdate = (
  newStatus: string,
  {
    oldStatus = newStatus === 'kicked' ? 'member' : 'kicked',
    chatType = 'private',
    from = USER,
  }: { oldStatus?: string; chatType?: string; from?: User } = {},
): Update =>
  ({
    update_id: ++updateId,
    my_chat_member: {
      chat:
        chatType === 'private'
          ? { id: from.id, type: chatType, first_name: from.first_name }
          : { id: -1001, type: chatType, title: 'A group' },
      from,
      date: 1,
      old_chat_member: { status: oldStatus, user: { ...BOT_INFO } },
      new_chat_member: {
        status: newStatus,
        user: { ...BOT_INFO },
        ...(newStatus === 'kicked' ? { until_date: 0 } : {}),
      },
    },
  }) as unknown as Update;

export const callbackUpdate = (data: string, chatType = 'private'): Update =>
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
  // thing grammY's transport throws (core/client.js, toHttpError). Either member beats an
  // answer programmed for the same method, and beats it on every call until the entry is
  // deleted: the precedence is fixed, not one refusal followed by recovery. A scene where
  // getUpdates is refused once and polling then goes on is built by deleting the entry after
  // that call, or by an answer that throws the first time — not by this precedence.
  apiErrors: Map<string, ApiError | HttpError>;
  answers: Map<string, ApiAnswer>;
}

// Every outgoing Bot API call is recorded here instead of reaching Telegram. Unprogrammed
// methods answer `result: true`. The account card reads the message_id of the sendPhoto or
// sendMessage that carried it, so a scene that reaches the pin programs those two with
// messageAnswer; a handler that starts reading another result needs the same.
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
    if (failure !== undefined) {
      if (failure instanceof Error) throw failure;
      return Promise.resolve(failure);
    }
    const answer = captured.answers.get(method);
    if (answer !== undefined) {
      return Promise.resolve(answer(payload, signal)).then((result) => ({ ok: true, result }));
    }
    return Promise.resolve({ ok: true, result: true });
  }) as Parameters<typeof bot.api.config.use>[0]);
  return captured;
}

// The message ids the account card's two carriers answer with, distinct so a test can tell
// which message was pinned.
export const CARD_MESSAGE_ID = 501;
export const TEXT_CARD_MESSAGE_ID = 502;

// The result of a send: grammY passes it through unchecked, and the bot reads only message_id.
export const messageAnswer =
  (message_id: number): ApiAnswer =>
  () => ({
    message_id,
    date: 1,
    chat: { id: USER.id, type: 'private', first_name: USER.first_name },
  });

export const sentPayload = (
  calls: readonly ApiCall[],
  method: string,
): Record<string, unknown> | undefined => calls.find((call) => call.method === method)?.payload;

export const inlineButtons = (payload: Record<string, unknown> | undefined) =>
  (
    payload?.reply_markup as {
      inline_keyboard?: {
        text: string;
        callback_data?: string;
        url?: string;
        web_app?: { url: string };
      }[][];
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
