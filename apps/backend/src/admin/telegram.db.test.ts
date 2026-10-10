import { and, eq } from 'drizzle-orm';
import { BotError, GrammyError } from 'grammy';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { AuditAction, LinkState } from '@binarius/shared';
import {
  auditLog,
  completeLogin,
  confirmChallengeFromTelegram,
  failChallengeDelivery,
  hashToken,
  inspectLoginLink,
  issueLoginLink,
  markChallengeCodeSent,
  STAFF_LOGIN_LINK_MAX_PER_WINDOW,
  staffLoginChallenges,
  StaffLoginChallengeStatus,
  staffLoginLinks,
  StaffLoginLinkStatus,
  StaffStatus,
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
  ADMIN_BOT_INFO,
  callsTo,
  callbackUpdate,
  captureApi,
  codeFrom,
  commandUpdate,
  fakeLogger,
  inlineButtons,
  sentPayload,
  staffUser,
  TEST_WEB_PUBLIC_URL,
  type CapturedApi,
  type FakeLogger,
} from './testing';
import {
  confirmCallbackData,
  createAdminBot,
  denyCallbackData,
  LOGIN_LINK_CALLBACK,
  type AdminBot,
} from './telegram';
import { ADMIN_TEXTS } from './texts';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
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
  admin = createAdminBot({
    token: '1:token',
    db: tmp.db,
    logger,
    botInfo: ADMIN_BOT_INFO,
    webPublicUrl: TEST_WEB_PUBLIC_URL,
  });
  api = captureApi(admin.bot);
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
    await tmp.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.actorId, staffId))
  ).map((row) => row.action);

const auditCount = async () =>
  (await tmp.db.select({ n: sql<number>`count(*)::int` }).from(auditLog))[0]?.n ?? 0;

const refusalsFor = (staffId: string) =>
  tmp.db
    .select({ payload: auditLog.payload })
    .from(auditLog)
    .where(
      and(eq(auditLog.actorId, staffId), eq(auditLog.action, AuditAction.StaffLoginLinkRefused)),
    );

// a stranger's id: no staff row carries it
const STRANGER = 4242;

describe('/start', () => {
  it('offers an active staff member the login button', async () => {
    const staff = await seedStaff(tmp.db);
    await admin.bot.handleUpdate(commandUpdate('/start', staffUser(staff.telegramUserId)));

    const payload = sentPayload(api.calls, 'sendMessage');
    expect(payload?.text).toBe(ADMIN_TEXTS.start);
    expect(inlineButtons(payload)).toEqual([
      { text: ADMIN_TEXTS.linkButton, callback_data: LOGIN_LINK_CALLBACK },
    ]);
    expect(api.calls).toHaveLength(ADMIN_HANDLER_CALLS.start);
  });

  // one template for everyone else, carrying the sender's own id: the first-setup step that
  // learns the id to create the account with keeps working, and the answer says nothing about
  // whether an account exists
  it('answers a stranger and a disabled account with the same refusal and no button', async () => {
    const disabled = await seedStaff(tmp.db, { status: StaffStatus.Disabled });
    const before = await auditCount();

    await admin.bot.handleUpdate(commandUpdate('/start', staffUser(STRANGER)));
    const strangerCalls = api.calls.splice(0);
    expect(await auditCount()).toBe(before);
    await admin.bot.handleUpdate(commandUpdate('/start', staffUser(disabled.telegramUserId)));

    const stranger = sentPayload(strangerCalls, 'sendMessage');
    const known = sentPayload(api.calls, 'sendMessage');
    expect(stranger?.text).toBe(ADMIN_TEXTS.noAccess(String(STRANGER)));
    expect(known?.text).toBe(ADMIN_TEXTS.noAccess(String(disabled.telegramUserId)));
    expect(String(known?.text).replace(String(disabled.telegramUserId), '<id>')).toBe(
      String(stranger?.text).replace(String(STRANGER), '<id>'),
    );
    expect([stranger?.reply_markup, known?.reply_markup]).toEqual([undefined, undefined]);
    expect([strangerCalls.length, api.calls.length]).toEqual([
      ADMIN_HANDLER_CALLS.start,
      ADMIN_HANDLER_CALLS.start,
    ]);
    // owner's answer В5: a row for the known account only
    expect((await refusalsFor(disabled.staffId)).map((row) => row.payload)).toEqual([
      { reason: 'disabled', via: 'start' },
    ]);
  });

  // the row is written after the reply has gone, so the reply does not wait on it
  it('writes the disabled account’s row only after the reply was sent', async () => {
    const disabled = await seedStaff(tmp.db, { status: StaffStatus.Disabled });
    const rowsDuringSend: number[] = [];
    api.answers.set('sendMessage', async () => {
      rowsDuringSend.push((await refusalsFor(disabled.staffId)).length);
      return true;
    });

    await admin.bot.handleUpdate(commandUpdate('/start', staffUser(disabled.telegramUserId)));

    expect(rowsDuringSend).toEqual([0]);
    expect(await refusalsFor(disabled.staffId)).toHaveLength(1);
  });

  // a reply Telegram refused changes nothing about what happened: the row is still written
  it('records the disabled account’s refusal even when the reply fails', async () => {
    const disabled = await seedStaff(tmp.db, { status: StaffStatus.Disabled });
    api.apiErrors.set('sendMessage', {
      ok: false,
      error_code: 403,
      description: 'bot was blocked',
    });

    await admin.bot.handleUpdate(commandUpdate('/start', staffUser(disabled.telegramUserId)));

    expect(await refusalsFor(disabled.staffId)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ name: 'GrammyError' }) }),
      'the staff bot refusal could not be delivered',
    );
  });

  it('ignores a group chat, where one update cannot name one person', async () => {
    await admin.bot.handleUpdate(commandUpdate('/start', staffUser(4242), 'supergroup'));
    expect(api.calls).toEqual([]);
  });
});

// docs/staff-login.md → Logging in by a link from the bot (#448)
describe('the login link button', () => {
  const LINK_PREFIX = `${TEST_WEB_PUBLIC_URL}/admin/login/link/`;
  const tokenIn = (text: unknown): string => {
    const at = String(text).indexOf(LINK_PREFIX);
    const token =
      at < 0
        ? undefined
        : /^[A-Za-z0-9_-]{43}/.exec(String(text).slice(at + LINK_PREFIX.length))?.[0];
    if (token === undefined) throw new Error(`no login link in: ${String(text)}`);
    return token;
  };
  const allLogged = () =>
    JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);

  it('sends the link without a preview, then answers the button', async () => {
    const staff = await seedStaff(tmp.db);

    await admin.bot.handleUpdate(
      callbackUpdate(LOGIN_LINK_CALLBACK, staffUser(staff.telegramUserId)),
    );

    expect(api.calls.map((call) => call.method)).toEqual(['sendMessage', 'answerCallbackQuery']);
    expect(api.calls).toHaveLength(ADMIN_HANDLER_CALLS.link);
    const payload = sentPayload(api.calls, 'sendMessage');
    expect(payload?.link_preview_options).toEqual({ is_disabled: true });
    const token = tokenIn(payload?.text);
    expect(payload?.text).toBe(ADMIN_TEXTS.link(`${LINK_PREFIX}${token}`));
    // the token in the message is the one whose hash was stored, and it is live
    expect(await inspectLoginLink(tmp.db, token)).toBe(LinkState.Live);
    const [row] = await tmp.db
      .select({ staffId: staffLoginLinks.staffId })
      .from(staffLoginLinks)
      .where(eq(staffLoginLinks.tokenHash, hashToken(token)));
    expect(row?.staffId).toBe(staff.staffId);
    expect(allLogged()).not.toContain(token);
  });

  it('refuses a stranger with the /start refusal and records nothing', async () => {
    const before = await auditCount();

    await admin.bot.handleUpdate(callbackUpdate(LOGIN_LINK_CALLBACK, staffUser(STRANGER)));

    expect(sentPayload(api.calls, 'sendMessage')?.text).toBe(
      ADMIN_TEXTS.noAccess(String(STRANGER)),
    );
    expect(api.calls.map((call) => call.method)).toEqual(['sendMessage', 'answerCallbackQuery']);
    expect(await auditCount()).toBe(before);
  });

  // a button left in an old message after the account was disabled
  it('refuses a disabled account, records it after the reply and issues nothing', async () => {
    const disabled = await seedStaff(tmp.db, { status: StaffStatus.Disabled });
    const rowsDuringSend: number[] = [];
    api.answers.set('sendMessage', async () => {
      rowsDuringSend.push((await refusalsFor(disabled.staffId)).length);
      return true;
    });

    await admin.bot.handleUpdate(
      callbackUpdate(LOGIN_LINK_CALLBACK, staffUser(disabled.telegramUserId)),
    );

    expect(sentPayload(api.calls, 'sendMessage')?.text).toBe(
      ADMIN_TEXTS.noAccess(String(disabled.telegramUserId)),
    );
    expect(sentPayload(api.calls, 'sendMessage')?.reply_markup).toBeUndefined();
    expect(rowsDuringSend).toEqual([0]);
    expect((await refusalsFor(disabled.staffId)).map((row) => row.payload)).toEqual([
      { reason: 'disabled', via: 'button' },
    ]);
    expect(
      await tmp.db
        .select()
        .from(staffLoginLinks)
        .where(eq(staffLoginLinks.staffId, disabled.staffId)),
    ).toEqual([]);
  });

  it('answers the rate limit with an alert and sends no message', async () => {
    const staff = await seedStaff(tmp.db);
    for (let press = 1; press <= STAFF_LOGIN_LINK_MAX_PER_WINDOW; press += 1) {
      await issueLoginLink(tmp.db, { telegramUserId: staff.telegramUserId });
    }

    await admin.bot.handleUpdate(
      callbackUpdate(LOGIN_LINK_CALLBACK, staffUser(staff.telegramUserId)),
    );

    expect(callsTo(api.calls, 'sendMessage')).toEqual([]);
    expect(sentPayload(api.calls, 'answerCallbackQuery')).toMatchObject({
      text: ADMIN_TEXTS.linkRateLimited,
      show_alert: true,
    });
  });

  // review round 1, m1: no spinner is left on the button when the refusal cannot be sent
  it('answers the button even when the refusal cannot be sent, and still records it', async () => {
    const disabled = await seedStaff(tmp.db, { status: StaffStatus.Disabled });
    api.apiErrors.set('sendMessage', {
      ok: false,
      error_code: 403,
      description: 'bot was blocked',
    });

    await admin.bot.handleUpdate(
      callbackUpdate(LOGIN_LINK_CALLBACK, staffUser(disabled.telegramUserId)),
    );

    expect(api.calls.map((call) => call.method)).toEqual(['sendMessage', 'answerCallbackQuery']);
    expect(await refusalsFor(disabled.staffId)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ name: 'GrammyError' }) }),
      'the staff bot refusal could not be delivered',
    );
  });

  // review round 1, m2: a refused answer ("query is too old") is a warn, not a failed update
  it('keeps a refused rate-limit answer out of the update error handler', async () => {
    const staff = await seedStaff(tmp.db);
    for (let press = 1; press <= STAFF_LOGIN_LINK_MAX_PER_WINDOW; press += 1) {
      await issueLoginLink(tmp.db, { telegramUserId: staff.telegramUserId });
    }
    api.apiErrors.set('answerCallbackQuery', {
      ok: false,
      error_code: 400,
      description: 'query is too old',
    });

    await admin.bot.handleUpdate(
      callbackUpdate(LOGIN_LINK_CALLBACK, staffUser(staff.telegramUserId)),
    );

    expect(callsTo(api.calls, 'answerCallbackQuery')).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ telegramErrorCode: 400 }),
      'answering the staff login callback failed',
    );
  });

  // the URL is the credential for five minutes: the failure line names the link by id only
  it('says so when the link cannot be delivered, and logs neither the token nor the URL', async () => {
    const staff = await seedStaff(tmp.db);
    api.apiErrors.set('sendMessage', {
      ok: false,
      error_code: 403,
      description: 'bot was blocked by the user',
    });

    await admin.bot.handleUpdate(
      callbackUpdate(LOGIN_LINK_CALLBACK, staffUser(staff.telegramUserId)),
    );

    expect(sentPayload(api.calls, 'answerCallbackQuery')).toMatchObject({
      text: ADMIN_TEXTS.linkFailed,
      show_alert: true,
    });
    const token = tokenIn(sentPayload(api.calls, 'sendMessage')?.text);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ linkId: expect.any(String) }),
      'the staff login link could not be delivered',
    );
    expect(allLogged()).not.toContain(token);
    expect(allLogged()).not.toContain('/admin/login/link/');
    // issued and unreachable; the next press supersedes it
    const [row] = await tmp.db
      .select({ status: staffLoginLinks.status })
      .from(staffLoginLinks)
      .where(eq(staffLoginLinks.tokenHash, hashToken(token)));
    expect(row?.status).toBe(StaffLoginLinkStatus.Issued);
  });
});

describe('the confirm button', () => {
  it('issues a code to the account the update came from and records the press', async () => {
    const staff = await seedStaff(tmp.db);
    const challengeId = await openChallenge(staff);
    // observed, not asserted, inside the seam: a throw there is a refused answerCallbackQuery,
    // which the handler swallows
    let sentWhenAnswered: boolean | undefined;
    api.answers.set('answerCallbackQuery', async () => {
      sentWhenAnswered = (await challengeRow(challengeId)).codeSentAt !== null;
      return true;
    });

    await admin.bot.handleUpdate(
      callbackUpdate(confirmCallbackData(challengeId), staffUser(staff.telegramUserId)),
    );

    // the toast promises a code completeLogin will take, so it waits for code_sent_at
    expect(api.calls.map((call) => call.method)).toEqual(['sendMessage', 'answerCallbackQuery']);
    expect(sentPayload(api.calls, 'answerCallbackQuery')?.text).toBe(ADMIN_TEXTS.confirmed);
    expect(sentWhenAnswered).toBe(true);
    const code = codeFrom(sentPayload(api.calls, 'sendMessage')?.text);
    const row = await challengeRow(challengeId);
    expect(String(sentPayload(api.calls, 'sendMessage')?.text)).toContain('Никому не сообщайте');
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
      callbackUpdate(confirmCallbackData('00000000-0000-4000-8000-0000000000aa'), staffUser(4242)),
    );
    expect(sentPayload(api.calls, 'answerCallbackQuery')?.text).toBe(ADMIN_TEXTS.stale);
    expect(callsTo(api.calls, 'sendMessage')).toEqual([]);
  });

  // the process died between the CAS and the Bot API call: the code exists and nobody has it
  it('closes the challenge when the code cannot be delivered', async () => {
    const staff = await seedStaff(tmp.db);
    const challengeId = await openChallenge(staff);
    // somebody else's failure of the same action, so the read below has to be filtered by actor
    // rather than by action alone
    const other = await seedStaff(tmp.db);
    await failChallengeDelivery(tmp.db, {
      challengeId: await openChallenge(other),
      staffId: other.staffId,
      from: StaffLoginChallengeStatus.Pending,
      reason: 'polling_down',
      err: { name: 'Error' },
      telegram: {},
    });
    api.apiErrors.set(
      'sendMessage',
      new GrammyError(
        'Call to sendMessage failed!',
        { ok: false, error_code: 403, description: 'bot was blocked by the user' },
        'sendMessage',
        {},
      ),
    );
    let statusWhenAnswered: string | undefined;
    api.answers.set('answerCallbackQuery', async () => {
      statusWhenAnswered = (await challengeRow(challengeId)).status;
      return true;
    });

    await admin.bot.handleUpdate(
      callbackUpdate(confirmCallbackData(challengeId), staffUser(staff.telegramUserId)),
    );

    // one answer, after the close: an alert telling them to start over, not "code sent"
    expect(api.calls.map((call) => call.method)).toEqual(['sendMessage', 'answerCallbackQuery']);
    expect(sentPayload(api.calls, 'answerCallbackQuery')).toMatchObject({
      text: ADMIN_TEXTS.codeFailed,
      show_alert: true,
    });
    expect(statusWhenAnswered).toBe(StaffLoginChallengeStatus.Failed);
    const row = await challengeRow(challengeId);
    expect([row.status, row.codeSentAt]).toEqual([StaffLoginChallengeStatus.Failed, null]);
    const failures = await tmp.db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, AuditAction.StaffLoginTelegramFailed),
          eq(auditLog.actorId, staff.staffId),
        ),
      );
    expect(failures).toHaveLength(1);
    const [entry] = failures;
    expect(entry?.payload).toMatchObject({
      reason: 'code_send_failed',
      err: { name: 'GrammyError' },
      telegram: { method: 'sendMessage', telegramErrorCode: 403 },
    });
    // the description names what the bot was sending; it must not survive into a durable row
    expect(JSON.stringify(entry?.payload)).not.toContain('blocked');
  });

  // The second press lands inside the flight of the first press's reply: the code the first
  // reply is carrying has already been replaced by one that arrives, so the first reply's
  // failure must close nothing — someone is holding a code that works.
  it('keeps a challenge whose newer code was delivered when the older reply fails', async () => {
    const staff = await seedStaff(tmp.db);
    const challengeId = await openChallenge(staff);
    let secondCode = '';
    api.answers.set('sendMessage', async () => {
      api.answers.delete('sendMessage');
      const second = await confirmChallengeFromTelegram(tmp.db, {
        challengeId,
        telegramUserId: staff.telegramUserId,
      });
      if (second === undefined) throw new Error('the second press matched no challenge');
      await markChallengeCodeSent(tmp.db, challengeId, second.code);
      secondCode = second.code;
      throw new GrammyError(
        'Call to sendMessage failed!',
        { ok: false, error_code: 403, description: 'bot was blocked by the user' },
        'sendMessage',
        {},
      );
    });

    await admin.bot.handleUpdate(
      callbackUpdate(confirmCallbackData(challengeId), staffUser(staff.telegramUserId)),
    );

    // the second press is the one that tells them; this one closed nothing and says nothing
    expect(api.calls.map((call) => call.method)).toEqual(['sendMessage', 'answerCallbackQuery']);
    expect(sentPayload(api.calls, 'answerCallbackQuery')?.text).toBeUndefined();
    const row = await challengeRow(challengeId);
    expect(row.status).toBe(StaffLoginChallengeStatus.Confirmed);
    expect(row.codeSentAt).not.toBeNull();
    expect(row.codeHash).toBe(hashToken(secondCode));
    expect(
      await completeLogin(tmp.db, {
        challengeId,
        code: secondCode,
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
      }),
    ).toMatchObject({ ok: true });
    const failures = await tmp.db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, AuditAction.StaffLoginTelegramFailed),
          eq(auditLog.actorId, staff.staffId),
        ),
      );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.payload).toMatchObject({ reason: 'code_send_failed', closed: false });
  });

  // The mirror of the case above: the older reply arrives, but the code it carried has been
  // replaced, so it is not marked sent and completeLogin would refuse it.
  it('says nothing when the delivered code was already replaced by a later press', async () => {
    const staff = await seedStaff(tmp.db);
    const challengeId = await openChallenge(staff);
    let secondCode = '';
    api.answers.set('sendMessage', async () => {
      api.answers.delete('sendMessage');
      const second = await confirmChallengeFromTelegram(tmp.db, {
        challengeId,
        telegramUserId: staff.telegramUserId,
      });
      if (second === undefined) throw new Error('the second press matched no challenge');
      await markChallengeCodeSent(tmp.db, challengeId, second.code);
      secondCode = second.code;
      return true;
    });

    await admin.bot.handleUpdate(
      callbackUpdate(confirmCallbackData(challengeId), staffUser(staff.telegramUserId)),
    );

    expect(api.calls.map((call) => call.method)).toEqual(['sendMessage', 'answerCallbackQuery']);
    expect(sentPayload(api.calls, 'answerCallbackQuery')?.text).toBeUndefined();
    expect((await challengeRow(challengeId)).codeHash).toBe(hashToken(secondCode));
    expect(
      await completeLogin(tmp.db, {
        challengeId,
        code: secondCode,
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
      }),
    ).toMatchObject({ ok: true });
  });

  // Accepted risk: with the database down there is nothing true to say, so the button is left
  // to Telegram's own timeout and the error leaves the handler (bot.catch while polling).
  it('answers nothing and rethrows when recording the delivery fails', async () => {
    const staff = await seedStaff(tmp.db);
    const challengeId = await openChallenge(staff);
    // confirmChallengeFromTelegram runs in a transaction; markChallengeCodeSent is a bare update
    const failingDb = new Proxy(tmp.db, {
      get: (target, property, receiver) =>
        property === 'update'
          ? () => {
              throw new Error('db down');
            }
          : Reflect.get(target, property, receiver),
    });
    const failing = createAdminBot({
      token: '1:token',
      db: failingDb,
      logger,
      botInfo: ADMIN_BOT_INFO,
    });
    const failingApi = captureApi(failing.bot);

    const handled = failing.bot.handleUpdate(
      callbackUpdate(confirmCallbackData(challengeId), staffUser(staff.telegramUserId)),
    );

    await expect(handled).rejects.toBeInstanceOf(BotError);
    await expect(handled).rejects.toMatchObject({
      error: expect.objectContaining({ message: 'db down' }),
    });
    expect(callsTo(failingApi.calls, 'sendMessage')).toHaveLength(1);
    expect(callsTo(failingApi.calls, 'answerCallbackQuery')).toEqual([]);
    expect((await challengeRow(challengeId)).codeSentAt).toBeNull();
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

    expect(api.calls.map((call) => call.method)).toEqual(['sendMessage', 'answerCallbackQuery']);
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
      // 2^53 - 1, the largest id the CLI accepts: the wire form is a string at the boundary too
      telegramUserId: 9007199254740991n,
      login: 'ada',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });

    const payload = sentPayload(api.calls, 'sendMessage');
    expect(payload?.chat_id).toBe('9007199254740991');
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
      botInfo: ADMIN_BOT_INFO,
      webPublicUrl: TEST_WEB_PUBLIC_URL,
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
    const failing = createAdminBot({
      token: '1:bad',
      db: tmp.db,
      logger,
      webPublicUrl: TEST_WEB_PUBLIC_URL,
    });
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
