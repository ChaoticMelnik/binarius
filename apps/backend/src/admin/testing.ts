// Test-only fixtures and harness for the staff-login suites. Compiled by `tsc -b` alongside
// the *.test.ts files next to it and imported by no runtime module.

import type { Api, HttpError } from 'grammy';
import type { ApiError, Update, User, UserFromGetMe } from 'grammy/types';
import { vi, type Mock } from 'vitest';
import { isBotKeyboard, type BotProfileMethod, type ButtonRole } from '@binarius/shared';
import { botKeyboardProblems, stripMessageSpacer } from '@binarius/shared/testing';
import type { BotProfileApi } from '../bot-texts/publish';
import type { PaymentsRoutesDeps } from '../payments/routes';
import type { AdminRoutesDeps } from './routes';

export const ADMIN_BOT_INFO: UserFromGetMe = {
  id: 7,
  is_bot: true,
  first_name: 'Binarius Staff',
  username: 'binarius_staff_bot',
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

// apps/web's origin as the staff bot sees it (#448)
export const TEST_WEB_PUBLIC_URL = 'https://admin.example';

export interface FakeLogger {
  info: Mock;
  warn: Mock;
  error: Mock;
}

export const fakeLogger = (): FakeLogger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

let updateId = 0;

export const staffUser = (id: bigint | number): User => ({
  id: Number(id),
  is_bot: false,
  first_name: 'Ada',
});

export const commandUpdate = (text: string, from: User, chatType = 'private'): Update =>
  ({
    update_id: ++updateId,
    message: {
      message_id: ++updateId,
      date: 1,
      chat: { id: from.id, type: chatType, first_name: from.first_name },
      from,
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  }) as unknown as Update;

export const callbackUpdate = (data: string, from: User, chatType = 'private'): Update =>
  ({
    update_id: ++updateId,
    callback_query: {
      id: `query-${++updateId}`,
      from,
      chat_instance: 'instance-1',
      data,
      message: {
        message_id: ++updateId,
        date: 1,
        chat: { id: from.id, type: chatType, first_name: from.first_name },
        from: { ...ADMIN_BOT_INFO },
      },
    },
  }) as unknown as Update;

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

export type ApiAnswer = (payload: Record<string, unknown>) => unknown | Promise<unknown>;

export interface CapturedApi {
  calls: ApiCall[];
  // an entry makes that method answer the way Telegram does when it refuses (ApiError, which
  // grammY turns into a GrammyError), or fail the way the transport does (HttpError). Either
  // beats an answer programmed for the same method, on every call, until the entry is deleted.
  apiErrors: Map<string, ApiError | HttpError>;
  answers: Map<string, ApiAnswer>;
}

/**
 * Every outgoing Bot API call is recorded here instead of reaching Telegram — including getMe,
 * which is what `bot.start()` issues first. Takes the staff bot or the client push: both carry
 * the Api they send through. grammY's middleware, its update parsing and
 * handleUpdate are the real ones; only the transport is replaced.
 *
 * What this cannot show is that Telegram accepts the shape of our calls. Whether a button press
 * is genuine is not decided here either: that is a CAS against a real database, joined to the
 * Telegram account the update arrived from.
 */
export function captureApi({ api }: { api: Api }): CapturedApi {
  const captured: CapturedApi = { calls: [], apiErrors: new Map(), answers: new Map() };
  api.config.use(((_prev, method: string, payload: Record<string, unknown>) => {
    captured.calls.push({ method, payload });
    // #475: every keyboard of a push and of the staff bot is built by role (docs/bot-navigation.md
    // → Roles, colours and rows), as the bot's captureApi checks
    if (payload.reply_markup !== undefined) {
      const problems = botKeyboardProblems(payload.reply_markup);
      if (problems.length > 0) throw new Error(`${method}: ${problems.join('; ')}`);
    }
    const failure = captured.apiErrors.get(method);
    if (failure !== undefined) {
      if (failure instanceof Error) throw failure;
      return Promise.resolve(failure);
    }
    const answer = captured.answers.get(method);
    if (answer !== undefined) {
      return Promise.resolve(answer(payload)).then((result) => ({ ok: true, result }));
    }
    return Promise.resolve({ ok: true, result: true });
  }) as Parameters<typeof api.config.use>[0]);
  return captured;
}

export const callsTo = (calls: readonly ApiCall[], method: string): ApiCall[] =>
  calls.filter((call) => call.method === method);

export const sentPayload = (
  calls: readonly ApiCall[],
  method: string,
): Record<string, unknown> | undefined => calls.find((call) => call.method === method)?.payload;

// The text a client push was given, without the width spacer its seam appends (#506); throws when
// the spacer is missing, so a push that skipped it fails the assertion reading it. The staff bot
// sends without one: its suites read payload.text.
export const pushedText = (payload: Record<string, unknown> | undefined): string => {
  const text = stripMessageSpacer(String(payload?.text));
  if (text === undefined) throw new Error('the push sent a text without the width spacer');
  return text;
};

interface WireButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
  style?: string;
}
const markupRows = (payload: Record<string, unknown> | undefined) =>
  (payload?.reply_markup as { inline_keyboard?: WireButton[][] } | undefined)?.inline_keyboard ??
  [];

// the keyboard row by row without the colours (#475), which inlineStyles reads
export const inlineRows = (payload: Record<string, unknown> | undefined) =>
  markupRows(payload).map((row) =>
    row.map((button) => {
      const { style, ...wire } = button;
      void style;
      return wire;
    }),
  );

export const inlineButtons = (payload: Record<string, unknown> | undefined) =>
  inlineRows(payload).flat();

// each button's `style` by row, null where it has none (#475)
export const inlineStyles = (payload: Record<string, unknown> | undefined) =>
  markupRows(payload).map((row) => row.map((button) => button.style ?? null));

// each button's role by row (#475), read from the BotKeyboard sent
export const inlineRoles = (payload: Record<string, unknown> | undefined): ButtonRole[][] => {
  const markup = payload?.reply_markup;
  if (!isBotKeyboard(markup)) throw new Error('the payload carries no keyboard built by role');
  return markup.rows.map((row) => row.map((button) => button.role));
};

/** The six-digit code out of the message the bot sent, so a test never has to guess it. */
export const codeFrom = (text: unknown): string => {
  const match = /(\d{6})/.exec(String(text));
  if (match?.[1] === undefined) throw new Error(`no six-digit code in: ${String(text)}`);
  return match[1];
};

/** A telegram seam that records what the login route asked it to send. */
export const stubTelegram = (polling = true) => {
  const prompts: { challengeId: string; telegramUserId: bigint; login: string; ip: string }[] = [];
  let fail: Error | undefined;
  let before: ((challengeId: string) => Promise<void>) | undefined;
  return {
    prompts,
    setPolling: (value: boolean) => {
      polling = value;
    },
    failWith: (error: Error | undefined) => {
      fail = error;
    },
    // Runs inside sendLoginPrompt, which is the window the route leaves open on purpose: the
    // Bot API call is outside the transaction that created the challenge, so the button can
    // arrive while the message is in flight. Nothing else can place an event there.
    beforeSend: (hook: ((challengeId: string) => Promise<void>) | undefined) => {
      before = hook;
    },
    isPolling: () => polling,
    sendLoginPrompt: async (prompt: {
      challengeId: string;
      telegramUserId: bigint;
      login: string;
      ip: string;
      userAgent: string;
    }) => {
      if (before !== undefined) await before(prompt.challengeId);
      if (fail !== undefined) throw fail;
      prompts.push(prompt);
      await Promise.resolve();
    },
  };
};

/** The admin dependencies for a buildApp whose test is about some other route. */
export const unusedAdminDeps = (): AdminRoutesDeps => ({
  db: {} as never,
  adminWebToken: 'admin-web-token-for-tests',
  telegram: stubTelegram(false),
  botProfileApi: fakeBotProfileApi({
    onCall: () => {
      throw new Error('unused');
    },
  }).api,
  refundStarPayment: () => Promise.reject(new Error('unused')),
});

export interface BotProfileCall {
  method: BotProfileMethod;
  args: unknown[];
}

/**
 * A BotProfileApi that records each call. `fail` names the methods that throw instead, and
 * `onCall` runs inside the call, before it answers — where a test looks at the database.
 */
export function fakeBotProfileApi(
  options: {
    fail?: Partial<Record<BotProfileMethod, unknown>>;
    onCall?: (method: BotProfileMethod) => Promise<void> | void;
  } = {},
) {
  const calls: BotProfileCall[] = [];
  const method =
    (name: BotProfileMethod) =>
    async (...args: unknown[]): Promise<true> => {
      calls.push({ method: name, args });
      await options.onCall?.(name);
      if (options.fail !== undefined && Object.hasOwn(options.fail, name)) {
        throw options.fail[name];
      }
      return true;
    };
  const api: BotProfileApi = {
    setMyCommands: method('setMyCommands'),
    setMyDescription: method('setMyDescription'),
    setMyShortDescription: method('setMyShortDescription'),
  };
  return { api, calls };
}

// For a suite that never reaches /payments/stars/*: the database is never read, and a notice
// would be a failure of the suite.
export const unusedPaymentsDeps = (): PaymentsRoutesDeps => ({
  db: {} as never,
  internalApiToken: 'payments-token-for-tests',
  notifyStaff: () => Promise.reject(new Error('unused')),
});
