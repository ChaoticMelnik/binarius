import { eq } from 'drizzle-orm';
import { GrammyError, HttpError } from 'grammy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditAction, StarPaymentStatus, TokenLedgerKind } from '@binarius/shared';
import {
  auditLog,
  creditStarPayment,
  starPayments,
  starRefundRequests,
  StarsCreditSource,
  tokenLedger,
  users,
} from '@binarius/db';
import {
  createTempDatabase,
  seedUser,
  type SeededUser,
  type TempDatabase,
} from '@binarius/db/testing';
import { CHARGE_ALREADY_REFUNDED, parseStarsArgs, runStarsCli, type StarsRefundApi } from './stars';

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

const TOKEN = '123456:AA-stars-refund-token';

interface Call {
  userId: number;
  chargeId: string;
  token: string;
}

// Telegram as the CLI meets it: `answer` decides what refundStarPayment does with each call
function fakeTelegram(answer: (call: Call) => Promise<true>) {
  const calls: Call[] = [];
  const deps = {
    createApi: ({ token }: { token: string }): StarsRefundApi => ({
      refundStarPayment: (userId, chargeId) => {
        const call = { userId, chargeId, token };
        calls.push(call);
        return answer(call);
      },
    }),
  };
  return { calls, deps };
}

const telegramError = (errorCode: number, description: string) =>
  new GrammyError(
    'Call to refundStarPayment failed',
    { ok: false, error_code: errorCode, description },
    'refundStarPayment',
    {},
  );

async function run(
  argv: string[],
  telegram = fakeTelegram(() => Promise.resolve(true)),
  database: TempDatabase = tmp,
) {
  const lines: string[] = [];
  const code = await runStarsCli(
    argv,
    { DATABASE_URL: database.url, TELEGRAM_BOT_TOKEN: TOKEN },
    (line) => lines.push(line),
    telegram.deps,
  );
  return { code, lines, calls: telegram.calls };
}

let seq = 0;
// a paid 50-token purchase (or a held one by another payer), credited as the bot reports it
async function paid(
  user: SeededUser,
  { payer, database = tmp }: { payer?: bigint; database?: TempDatabase } = {},
): Promise<string> {
  const charge = `cli-charge-${++seq}`;
  await database.db.transaction((tx) =>
    creditStarPayment(tx, {
      telegramPaymentChargeId: charge,
      providerPaymentChargeId: null,
      packageCode: 'p50',
      userId: user.userId,
      currency: 'XTR',
      totalAmount: 100,
      payerTelegramUserId: payer ?? BigInt(user.telegramUserId),
      paidAt: new Date(),
      source: StarsCreditSource.Bot,
    }),
  );
  return charge;
}

async function rowOf(charge: string, database: TempDatabase = tmp) {
  const [row] = await database.db
    .select()
    .from(starPayments)
    .where(eq(starPayments.telegramPaymentChargeId, charge));
  return row!;
}
const refundRows = async (userId: string, database: TempDatabase = tmp) =>
  (await database.db.select().from(tokenLedger).where(eq(tokenLedger.userId, userId))).filter(
    (row) => row.kind === TokenLedgerKind.Refund,
  );
async function balanceOf(userId: string): Promise<bigint> {
  const [row] = await tmp.db
    .select({ balance: users.tokenBalance })
    .from(users)
    .where(eq(users.id, userId));
  return row!.balance;
}

describe('parseStarsArgs', () => {
  it.each([
    [[], 'нет команды'],
    [['refund'], 'нужен charge id'],
    [['refund', 'c1'], 'нужен --reason'],
    [['refund', 'c1', 'c2', '--reason', 'r'], 'лишние аргументы'],
    [['refund', 'c1', '--reason', 'a\nb'], '--reason'],
    [['refund', 'c1', '--reason', ''], '--reason'],
    [['requests', 'x'], 'лишние аргументы'],
    [['requests', '--reason', 'r'], '--reason не нужен'],
    [['refunds'], 'неизвестная команда'],
    [['refund', 'c1', '--reason', 'r', '--force'], 'force'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseStarsArgs(argv)).toThrow(message);
  });

  it('takes a refund with its reason, trimmed, and requests', () => {
    expect(parseStarsArgs(['refund', 'c1', '--reason', ' просьба '])).toEqual({
      command: 'refund',
      chargeId: 'c1',
      reason: 'просьба',
    });
    expect(parseStarsArgs(['requests'])).toEqual({ command: 'requests' });
  });

  it('C8 answers a usage error with exit 2 and the usage, before anything is read', async () => {
    const { code, lines, calls } = await run(['refund', 'c1']);
    expect(code).toBe(2);
    expect(lines[1]).toContain('stars refund <charge id>');
    expect(calls).toEqual([]);
  });

  it('refuses a refund without the bot token, before anything is read', async () => {
    const lines: string[] = [];
    const code = await runStarsCli(
      ['refund', 'c1', '--reason', 'r'],
      { DATABASE_URL: tmp.url },
      (line) => lines.push(line),
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('TELEGRAM_BOT_TOKEN');
  });
});

describe('stars refund', () => {
  it('C1 refunds a paid charge to its payer and records it once', async () => {
    const user = await seedUser(tmp.db, { balance: 4n });
    const charge = await paid(user);
    const { code, lines, calls } = await run(['refund', charge, '--reason', 'просьба']);
    expect(code).toBe(0);
    expect(calls).toEqual([
      { userId: Number(user.telegramUserId), chargeId: charge, token: TOKEN },
    ]);
    expect(lines.join('\n')).toBe(
      'Возврат выполнен и записан.\nТокенов списано: 50, не возвращено (потрачены или в резерве): 0. Баланс: 4.',
    );
    const row = await rowOf(charge);
    expect(row.status).toBe(StarPaymentStatus.Refunded);
    expect(await refundRows(user.userId)).toHaveLength(1);
    expect(await balanceOf(user.userId)).toBe(4n);
    const [audit] = (
      await tmp.db.select().from(auditLog).where(eq(auditLog.entityId, row.id))
    ).filter((a) => a.action === AuditAction.StarsRefunded);
    expect(audit?.payload).toMatchObject({
      via: 'cli',
      telegramAnswer: 'refunded',
      reason: 'просьба',
    });
  });

  it('a repeat after a recorded refund says so and does not call Telegram', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const charge = await paid(user);
    await run(['refund', charge, '--reason', 'r']);
    const again = await run(['refund', charge, '--reason', 'r']);
    expect(again.code).toBe(0);
    expect(again.calls).toEqual([]);
    expect(again.lines[0]).toMatch(/^Уже возвращена \d{4}-\d\d-\d\dT.* — Telegram не вызывался\.$/);
    expect(await refundRows(user.userId)).toHaveLength(1);
  });

  it(`C2 records a refund Telegram answers ${CHARGE_ALREADY_REFUNDED} to, once`, async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const charge = await paid(user);
    const { code, lines } = await run(
      ['refund', charge, '--reason', 'r'],
      fakeTelegram(() =>
        Promise.reject(telegramError(400, `Bad Request: ${CHARGE_ALREADY_REFUNDED}`)),
      ),
    );
    expect(code).toBe(0);
    expect(lines[0]).toBe('Оплата уже возвращена в Telegram — возврат записан.');
    expect(await refundRows(user.userId)).toHaveLength(1);
    const row = await rowOf(charge);
    const [audit] = (
      await tmp.db.select().from(auditLog).where(eq(auditLog.entityId, row.id))
    ).filter((a) => a.action === AuditAction.StarsRefunded);
    expect(audit?.payload).toMatchObject({ telegramAnswer: 'already_refunded' });
  });

  // C3: the reconciler recorded the refund between the pre-read and Telegram's answer
  it('C3 writes no second row when the refund was recorded while Telegram answered', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const charge = await paid(user);
    const first = await run(
      ['refund', charge, '--reason', 'r'],
      fakeTelegram(async () => {
        // the other recorder, inside the CLI's call
        await run(['refund', charge, '--reason', 'r']);
        throw telegramError(400, `Bad Request: ${CHARGE_ALREADY_REFUNDED}`);
      }),
    );
    expect(first.code).toBe(0);
    expect(first.lines[0]).toMatch(/^Уже возвращена .* — второй раз не записано\.$/);
    expect(await refundRows(user.userId)).toHaveLength(1);
  });

  it.each([
    ['another 400', 400, 'Bad Request: CHARGE_NOT_FOUND'],
    ['the name in other case', 400, 'Bad Request: charge_already_refunded'],
    [`${CHARGE_ALREADY_REFUNDED} with another code`, 403, `Forbidden: ${CHARGE_ALREADY_REFUNDED}`],
    ['a 5xx', 502, 'Bad Gateway'],
  ])('C4 writes nothing for %s and prints Telegram’s answer', async (_label, errorCode, text) => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const charge = await paid(user);
    const { code, lines } = await run(
      ['refund', charge, '--reason', 'r'],
      fakeTelegram(() => Promise.reject(telegramError(errorCode, text))),
    );
    expect(code).toBe(1);
    expect(lines).toEqual([
      `Telegram отказал в возврате: ${String(errorCode)} ${text}. Ничего не записано.`,
    ]);
    expect((await rowOf(charge)).status).toBe(StarPaymentStatus.Paid);
    expect(await refundRows(user.userId)).toEqual([]);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('C5 writes nothing on a timeout and says the outcome is unknown', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const charge = await paid(user);
    const { code, lines } = await run(
      ['refund', charge, '--reason', 'r'],
      fakeTelegram(() =>
        Promise.reject(
          new HttpError('Network request for refundStarPayment failed', new Error('timeout')),
        ),
      ),
    );
    expect(code).toBe(1);
    expect(lines[0]).toMatch(
      /^Исход неизвестен \(HttpError\)\. Ничего не записано\. Повторите команду/,
    );
    expect((await rowOf(charge)).status).toBe(StarPaymentStatus.Paid);
    expect(await refundRows(user.userId)).toEqual([]);
  });

  it('C6 says the refund went through and the record did not when the database fails after it', async () => {
    const own = await createTempDatabase(baseUrl!);
    try {
      const user = await seedUser(own.db, { balance: 0n });
      const charge = await paid(user, { database: own });
      const { code, lines } = await run(
        ['refund', charge, '--reason', 'r'],
        fakeTelegram(async () => {
          // the record's ledger insert fails from here on, in this database only
          await own.pool.query(
            `alter table token_ledger add constraint c6_no_refund check (kind <> 'refund')`,
          );
          return true;
        }),
        own,
      );
      expect(code).toBe(1);
      expect(lines[0]).toMatch(
        /^Возврат в Telegram выполнен, запись в БД не сделана \(.*23514.*\) — повторите команду \(безопасно\) или дождитесь сверки\.$/,
      );
      expect((await rowOf(charge, own)).status).toBe(StarPaymentStatus.Paid);
      expect(await refundRows(user.userId, own)).toEqual([]);
    } finally {
      await own.drop();
    }
  });

  it('C7 refunds a held forwarded payment to its payer, not to the users row', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const charge = await paid(user, { payer: 555_001n });
    expect((await rowOf(charge)).status).toBe(StarPaymentStatus.Held);
    const { code, lines, calls } = await run(['refund', charge, '--reason', 'r']);
    expect(code).toBe(0);
    expect(calls.map((call) => call.userId)).toEqual([555_001]);
    expect(lines[1]).toBe('Оплата была задержана: токены не начислялись, списано 0.');
    expect(await refundRows(user.userId)).toEqual([]);
  });

  it('answers an unknown charge with «Оплата не найдена», exit 1, without Telegram', async () => {
    const { code, lines, calls } = await run(['refund', 'cli-charge-never', '--reason', 'r']);
    expect([code, lines, calls]).toEqual([1, ['Оплата не найдена'], []]);
  });
});

describe('stars requests', () => {
  it('C9 lists the open requests with their command and hides a refunded one', async () => {
    const empty = await createTempDatabase(baseUrl!);
    try {
      const none = await run(['requests'], undefined, empty);
      expect([none.code, none.lines]).toEqual([0, ['Заявок нет']]);

      const user = await seedUser(empty.db, { balance: 0n });
      const open = await paid(user, { database: empty });
      const done = await paid(user, { database: empty });
      for (const charge of [open, done]) {
        await empty.db.insert(starRefundRequests).values({
          starPaymentId: (await rowOf(charge, empty)).id,
          requestedByTelegramUserId: BigInt(user.telegramUserId),
        });
      }
      await run(['refund', done, '--reason', 'r'], undefined, empty);
      const { code, lines } = await run(['requests'], undefined, empty);
      expect(code).toBe(0);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(
        new RegExp(
          `^\\d{4}-\\d\\d-\\d\\dT\\S+Z  ${open}  p50  100 ⭐  paid  плательщик ${user.telegramUserId}$`,
        ),
      );
      expect(lines[1]).toBe(`  pnpm --filter @binarius/backend stars refund ${open} --reason "…"`);
    } finally {
      await empty.drop();
    }
  });
});

// The one door against a database the CLI cannot reach (#150): a line and exit 1, no throw, and
// Telegram is never asked.
describe('stars against an unreachable database', () => {
  it.each([
    [['requests'], 'Не удалось прочитать заявки: Error (Error ECONNREFUSED).'],
    [
      ['refund', 'charge-unreachable', '--reason', 'x'],
      'Не удалось прочитать оплату: Error (Error ECONNREFUSED). Telegram не вызывался.',
    ],
  ])('%j answers 1 with the error name and code', async (argv, line) => {
    const telegram = fakeTelegram(() => Promise.resolve(true));
    let created = 0;
    const lines: string[] = [];
    const code = await runStarsCli(
      argv,
      {
        DATABASE_URL: 'postgres://binarius:secret@127.0.0.1:1/binarius',
        TELEGRAM_BOT_TOKEN: TOKEN,
      },
      (printed) => lines.push(printed),
      {
        createApi: (options) => {
          created += 1;
          return telegram.deps.createApi(options);
        },
      },
    );

    expect([code, lines]).toEqual([1, [line]]);
    expect(created).toBe(0);
    expect(telegram.calls).toEqual([]);
  });
});
