import { eq } from 'drizzle-orm';
import { GrammyError } from 'grammy';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  auditLog,
  hashToken,
  staffLoginChallenges,
  StaffLoginChallengeStatus,
  startLoginChallenge,
} from '@binarius/db';
import {
  createTempDatabase,
  seedStaff,
  type SeededStaff,
  type TempDatabase,
} from '@binarius/db/testing';
import { ADMIN_HANDLER_CALLS } from '../timing';
import {
  callsTo,
  callbackUpdate,
  captureApi,
  codeFrom,
  commandUpdate,
  fakeLogger,
  sentPayload,
  staffUser,
  type CapturedApi,
  type FakeLogger,
} from './testing';
import {
  confirmCallbackData,
  createAdminBot,
  denyCallbackData,
  type AdminBot,
} from './telegram';
import { ADMIN_TEXTS } from './texts';

const baseUrl = process.env.DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error('DATABASE_URL is required for apps/backend integration tests (see README)');
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

let admin: AdminBot;
let api: CapturedApi;
let logger: FakeLogger;

beforeEach(() => {
  logger = fakeLogger();
  admin = createAdminBot({ token: '1:token', db: tmp.db, logger, botInfo: BOT_INFO() });
  api = captureApi(admin.bot);
});

const BOT_INFO = () => ({
  id: 7,
  is_bot: true as const,
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
});

const openChallenge = async (staff: SeededStaff): Promise<string> => {
  const started = await startLoginChallenge(tmp.db, {
    staffId: staff.staffId,
    passwordHash: staff.passwordHash,
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
  });
  if (!started.ok) throw new Error('startLoginChallenge refused a fresh login');
  return started.challengeId;
};

const challengeRow = async (id: string) => {
  const [row] = await tmp.db
    .select()
    .from(staffLoginChallenges)
    .where(eq(staffLoginChallenges.id, id));
  if (row === undefined) throw new Error(`no challenge ${id}`);
  return row;
};

const actionsFor = async (staffId: string) =>
  (
    await tmp.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.actorId, staffId))
  ).map((row) => row.action);

describe('/start', () => {
  // the only way a staff member learns the id their account has to be created with
  it('answers with the sender’s own Telegram id', async () => {
    const from = staffUser(4242);
    await admin.bot.handleUpdate(commandUpdate('/start', from));

    expect(sentPayload(api.calls, 'sendMessage')?.text).toBe(ADMIN_TEXTS.start('4242'));
    expect(api.calls).toHaveLength(ADMIN_HANDLER_CALLS.start);
  });

  it('ignores a group chat, where one update cannot name one person', async () => {
    await admin.bot.handleUpdate(commandUpdate('/start', staffUser(4242), 'supergroup'));
    expect(api.calls).toEqual([]);
  });
});

describe('the confirm button', () => {
  it('issues a code to the account the update came from and records the press', async () => {
    const staff = await seedStaff(tmp.db);
    const challengeId = await openChallenge(staff);

    await admin.bot.handleUpdate(
      callbackUpdate(confirmCallbackData(challengeId), staffUser(staff.telegramUserId)),
    );

    const code = codeFrom(sentPayload(api.calls, 'sendMessage')?.text);
    const row = await challengeRow(challengeId);
    expect(row.status).toBe(StaffLoginChallengeStatus.Confirmed);
    expect(row.codeHash).toBe(hashToken(code));
    expect(row.codeSentAt).not.toBeNull();
    expect(await actionsFor(staff.staffId)).toContain(AuditAction.StaffLoginTelegramConfirmed);
    // the declared budget is computed from this number
    expect(api.calls).toHaveLength(ADMIN_HANDLER_CALLS.confirm);
  });

  // authenticity of the press is decided by the CAS, not by anything Telegram told us
  it('issues nothing when the press comes from another Telegram account', async () => {
    const staff = await seedStaff(tmp.db);
    const other = await seedStaff(tmp.db);
    const challengeId = await openChallenge(staff);

    await admin.bot.handleUpdate(
      callbackUpdate(confirmCallbackData(challengeId), staffUser(other.telegramUserId)),
    );

    expect(callsTo(api.calls, 'sendMessage')).toEqual([]);
    expect(sentPayload(api.calls, 'answerCallbackQuery')?.text).toBe(ADMIN_TEXTS.stale);
    const row = await challengeRow(challengeId);
    expect([row.status, row.codeHash]).toEqual([StaffLoginChallengeStatus.Pending, null]);
    expect(await actionsFor(staff.staffId)).not.toContain(AuditAction.StaffLoginTelegramConfirmed);
  });

  it('answers a challenge id nobody issued without touching anything', async () => {
    await admin.bot.handleUpdate(
      callbackUpdate(
        confirmCallbackData('00000000-0000-4000-8000-0000000000aa'),
        staffUser(4242),
      ),
    );
    expect(sentPayload(api.calls, 'answerCallbackQuery')?.text).toBe(ADMIN_TEXTS.stale);
    expect(callsTo(api.calls, 'sendMessage')).toEqual([]);
  });

  // the process died between the CAS and the Bot API call: the code exists and nobody has it
  it('closes the challenge when the code cannot be delivered', async () => {
    const staff = await seedStaff(tmp.db);
    const challengeId = await openChallenge(staff);
    api.apiErrors.set(
      'sendMessage',
      new GrammyError(
        'Call to sendMessage failed!',
        { ok: false, error_code: 403, description: 'bot was blocked by the user' },
        'sendMessage',
        {},
      ),
    );

    await admin.bot.handleUpdate(
      callbackUpdate(confirmCallbackData(challengeId), staffUser(staff.telegramUserId)),
    );

    const row = await challengeRow(challengeId);
    expect([row.status, row.codeSentAt]).toEqual([StaffLoginChallengeStatus.Failed, null]);
    const [entry] = await tmp.db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(eq(auditLog.action, AuditAction.StaffLoginTelegramFailed));
    expect(entry?.payload).toMatchObject({
      reason: 'code_send_failed',
      err: { name: 'GrammyError' },
      telegram: { method: 'sendMessage', telegramErrorCode: 403 },
    });
    // the description names what the bot was sending; it must not survive into a durable row
    expect(JSON.stringify(entry?.payload)).not.toContain('blocked');
  });

  it('keeps delivering the code when only the button spinner fails', async () => {
    const staff = await seedStaff(tmp.db);
    const challengeId = await openChallenge(staff);
    api.apiErrors.set(
      'answerCallbackQuery',
      new GrammyError(
        'Call to answerCallbackQuery failed!',
        { ok: false, error_code: 400, description: 'query is too old' },
        'answerCallbackQuery',
        {},
      ),
    );

    await admin.bot.handleUpdate(
      callbackUpdate(confirmCallbackData(challengeId), staffUser(staff.telegramUserId)),
    );

    expect(codeFrom(sentPayload(api.calls, 'sendMessage')?.text)).toMatch(/^\d{6}$/);
    expect((await challengeRow(challengeId)).codeSentAt).not.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('the deny button', () => {
  it('closes the challenge, records it and says so', async () => {
    const staff = await seedStaff(tmp.db);
    const challengeId = await openChallenge(staff);

    await admin.bot.handleUpdate(
      callbackUpdate(denyCallbackData(challengeId), staffUser(staff.telegramUserId)),
    );

    expect((await challengeRow(challengeId)).status).toBe(StaffLoginChallengeStatus.Denied);
    expect(await actionsFor(staff.staffId)).toContain(AuditAction.StaffLoginDenied);
    expect(sentPayload(api.calls, 'answerCallbackQuery')?.text).toBe(ADMIN_TEXTS.denied);
    expect(api.calls).toHaveLength(ADMIN_HANDLER_CALLS.deny);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('refuses a denial from another Telegram account', async () => {
    const staff = await seedStaff(tmp.db);
    const other = await seedStaff(tmp.db);
    const challengeId = await openChallenge(staff);

    await admin.bot.handleUpdate(
      callbackUpdate(denyCallbackData(challengeId), staffUser(other.telegramUserId)),
    );

    expect((await challengeRow(challengeId)).status).toBe(StaffLoginChallengeStatus.Pending);
    expect(sentPayload(api.calls, 'answerCallbackQuery')?.text).toBe(ADMIN_TEXTS.stale);
  });
});

describe('sendLoginPrompt', () => {
  it('sends the facts the person needs and the two buttons', async () => {
    await admin.sendLoginPrompt({
      challengeId: '00000000-0000-4000-8000-0000000000bb',
      telegramUserId: 4242n,
      login: 'ada',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });

    const payload = sentPayload(api.calls, 'sendMessage');
    expect(payload?.chat_id).toBe(4242);
    expect(String(payload?.text)).toContain('ada');
    expect(String(payload?.text)).toContain('203.0.113.7');
    expect(
      (payload?.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard
        .flat()
        .map((button) => button.callback_data),
    ).toEqual([
      'sl:c:00000000-0000-4000-8000-0000000000bb',
      'sl:d:00000000-0000-4000-8000-0000000000bb',
    ]);
  });

  it('rejects when Telegram refuses, so the caller can close the challenge', async () => {
    api.apiErrors.set('sendMessage', {
      ok: false,
      error_code: 400,
      description: 'chat not found',
    });
    await expect(
      admin.sendLoginPrompt({
        challengeId: '00000000-0000-4000-8000-0000000000cc',
        telegramUserId: 4242n,
        login: 'ada',
        ip: '203.0.113.7',
        userAgent: '',
      }),
    ).rejects.toBeInstanceOf(GrammyError);
  });
});

describe('polling', () => {
  // the flag the login route reads: with polling down, no button can arrive
  it('is false before start and after stop, and true while running', async () => {
    const running = createAdminBot({
      token: '1:token',
      db: tmp.db,
      logger: fakeLogger(),
      botInfo: BOT_INFO(),
    });
    const captured = captureApi(running.bot);
    // the real transport waits ADMIN_POLLING_TIMEOUT_S for updates; a long poll that answered
    // instantly would spin the loop as fast as the event loop allows
    captured.answers.set(
      'getUpdates',
      () => new Promise((resolve) => setTimeout(() => resolve([]), 1_000)),
    );

    expect(running.isPolling()).toBe(false);
    running.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(running.isPolling()).toBe(true);

    await running.stop();
    expect(running.isPolling()).toBe(false);
  });

  // the same path production takes on a bad token: getMe, not getUpdates
  it('survives a token Telegram refuses, and stop() still resolves', async () => {
    const failing = createAdminBot({ token: '1:bad', db: tmp.db, logger });
    const captured = captureApi(failing.bot);
    captured.apiErrors.set('getMe', {
      ok: false,
      error_code: 401,
      description: 'Unauthorized',
    });

    failing.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(failing.isPolling()).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ name: 'GrammyError' }) }),
      'the staff login bot stopped polling',
    );
    await expect(failing.stop()).resolves.toBeUndefined();
  });
});
