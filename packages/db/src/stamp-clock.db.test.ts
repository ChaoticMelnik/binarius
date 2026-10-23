import { sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditAction } from '@binarius/shared';
import { type Db } from './client';
import { consumeOAuthState, createOAuthState, hashToken } from './oauth-ops';
import { completeLinkLogin, issueLoginLink } from './staff-link-ops';
import {
  applyStaffPasswordChange,
  confirmChallengeFromTelegram,
  disableStaffAccount,
  endStaffSession,
  insertStaffSession,
  markChallengeCodeSent,
  markChallengePromptSent,
  revokeStaffSession,
  runAsStaff,
  startLoginChallenge,
} from './staff-ops';
import { hashPassword } from './staff-password';
import { oauthStates, staffLoginChallenges, staffLoginLinks, staffSessions } from './schema/index';
import {
  createTempDatabase,
  seedStaff,
  type SeededStaff,
  type TempDatabase,
  TEST_SCRYPT_PARAMS,
} from './testing';

// #158: the refuting form of #149 for every writer of a column a CHECK orders against
// created_at. The transaction the writer runs in is opened before the row exists; the row is
// created and committed by another connection of the pool; then the writer runs in the older
// transaction, whose now() is before the row's created_at. Under statementNow() the CHECK holds;
// under now() it aborts with 23514. `foreknown` proves the form took place - without it a row
// created before the transaction would pass for any clock. All three comparisons are SQL, since a
// JS Date drops the microseconds (#159).

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

const IP = '203.0.113.7';
const UA = 'Mozilla/5.0';
const REDIRECT_URI = 'https://example.test/callback';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

interface Stamp {
  table: PgTable;
  id: AnyPgColumn;
  createdAt: AnyPgColumn;
  column: AnyPgColumn;
}

const challengeStamp = (column: AnyPgColumn): Stamp => ({
  table: staffLoginChallenges,
  id: staffLoginChallenges.id,
  createdAt: staffLoginChallenges.createdAt,
  column,
});
const sessionStamp = (column: AnyPgColumn): Stamp => ({
  table: staffSessions,
  id: staffSessions.id,
  createdAt: staffSessions.createdAt,
  column,
});

interface Seeded {
  rowId: string;
  token?: string;
  code?: string;
  state?: string;
  keptSessionId?: string;
}

const session = async (s: SeededStaff): Promise<Seeded> => {
  const inserted = await tmp.db.transaction((tx) =>
    insertStaffSession(tx, { staffId: s.staffId, ip: IP, userAgent: UA }),
  );
  return { rowId: inserted.id, token: inserted.token };
};

const challenge = async (s: SeededStaff): Promise<string> => {
  const started = await startLoginChallenge(tmp.db, {
    staffId: s.staffId,
    passwordHash: s.passwordHash,
    ip: IP,
    userAgent: UA,
  });
  if (!started.ok) throw new Error(`startLoginChallenge refused: ${started.reason}`);
  return started.challengeId;
};

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`seed gave no ${what}`);
  return value;
};

interface Case {
  name: string;
  seed: (s: SeededStaff) => Promise<Seeded>;
  write: (outer: Tx, s: SeededStaff, seeded: Seeded) => Promise<unknown>;
  stamp: Stamp;
  check: (result: unknown, s: SeededStaff) => void;
}

const otherPasswordHash = hashPassword('another password', TEST_SCRYPT_PARAMS);

const cases: Case[] = [
  {
    name: 'markChallengePromptSent',
    seed: async (s) => ({ rowId: await challenge(s) }),
    write: (outer, _s, seeded) => markChallengePromptSent(outer, seeded.rowId),
    stamp: challengeStamp(staffLoginChallenges.promptSentAt),
    check: (result) => expect(result).toBeUndefined(),
  },
  {
    name: 'confirmChallengeFromTelegram',
    seed: async (s) => ({ rowId: await challenge(s) }),
    write: (outer, s, seeded) =>
      confirmChallengeFromTelegram(outer, {
        challengeId: seeded.rowId,
        telegramUserId: s.telegramUserId,
      }),
    stamp: challengeStamp(staffLoginChallenges.confirmedAt),
    check: (result, s) => expect(result).toMatchObject({ staffId: s.staffId, repeat: false }),
  },
  {
    name: 'markChallengeCodeSent',
    seed: async (s) => {
      const rowId = await challenge(s);
      const confirmed = await confirmChallengeFromTelegram(tmp.db, {
        challengeId: rowId,
        telegramUserId: s.telegramUserId,
      });
      return { rowId, code: need(confirmed, 'confirmation').code };
    },
    write: (outer, _s, seeded) =>
      markChallengeCodeSent(outer, seeded.rowId, need(seeded.code, 'code')),
    stamp: challengeStamp(staffLoginChallenges.codeSentAt),
    check: (result) => expect(result).toBe(true),
  },
  {
    name: 'runAsStaff',
    seed: session,
    write: (outer, _s, seeded) =>
      runAsStaff(outer, { token: need(seeded.token, 'token') }, async (_tx, ctx) => ({
        result: ctx.login,
        audit: { action: AuditAction.StaffSessionsViewed, payload: {} },
      })),
    stamp: sessionStamp(staffSessions.lastSeenAt),
    check: (result, s) => expect(result).toBe(s.login),
  },
  {
    name: 'revokeStaffSession',
    seed: session,
    write: (outer, s, seeded) =>
      revokeStaffSession(outer, { sessionId: seeded.rowId, byStaffId: s.staffId }),
    stamp: sessionStamp(staffSessions.revokedAt),
    check: (result, s) => expect(result).toEqual({ staffId: s.staffId }),
  },
  {
    name: 'endStaffSession',
    seed: session,
    write: (outer, s, seeded) => endStaffSession(outer, seeded.rowId, s.staffId),
    stamp: sessionStamp(staffSessions.revokedAt),
    check: (result) => expect(result).toBeUndefined(),
  },
  {
    name: 'disableStaffAccount (invalidateIssued)',
    seed: session,
    write: (outer, s) => disableStaffAccount(outer, s.login),
    stamp: sessionStamp(staffSessions.revokedAt),
    check: (result) =>
      expect(result).toEqual({ closedChallenges: 0, closedLinks: 0, revokedSessions: 1 }),
  },
  {
    name: 'applyStaffPasswordChange (invalidateIssued)',
    seed: async (s) => {
      const kept = await session(s);
      const revoked = await session(s);
      return { rowId: revoked.rowId, keptSessionId: kept.rowId };
    },
    write: async (outer, s, seeded) =>
      applyStaffPasswordChange(outer, {
        staffId: s.staffId,
        sessionId: need(seeded.keptSessionId, 'kept session'),
        passwordHashSeen: s.passwordHash,
        newPasswordHash: await otherPasswordHash,
      }),
    stamp: sessionStamp(staffSessions.revokedAt),
    check: (result) =>
      expect(result).toEqual({ ok: true, closedChallenges: 0, closedLinks: 0, revokedSessions: 1 }),
  },
  {
    name: 'consumeOAuthState',
    seed: async (s) => {
      const { state } = await createOAuthState(tmp.db, {
        telegramUserId: s.telegramUserId,
        redirectUri: REDIRECT_URI,
        ttlMs: 60_000,
      });
      const { rows } = await tmp.db.execute<{ id: string }>(
        sql`select ${oauthStates.id} as id from ${oauthStates} where ${oauthStates.stateHash} = ${hashToken(state)}`,
      );
      return { rowId: need(rows[0], 'state row').id, state };
    },
    write: (outer, _s, seeded) => consumeOAuthState(outer, need(seeded.state, 'state')),
    stamp: {
      table: oauthStates,
      id: oauthStates.id,
      createdAt: oauthStates.createdAt,
      column: oauthStates.usedAt,
    },
    check: (result, s) =>
      expect(result).toEqual({ telegramUserId: s.telegramUserId, redirectUri: REDIRECT_URI }),
  },
  {
    name: 'completeLinkLogin',
    seed: async (s) => {
      const issued = await issueLoginLink(tmp.db, { telegramUserId: s.telegramUserId });
      if (!issued.ok) throw new Error(`issueLoginLink refused: ${issued.reason}`);
      return { rowId: issued.linkId, token: issued.token };
    },
    write: (outer, _s, seeded) =>
      completeLinkLogin(outer, { token: need(seeded.token, 'token'), ip: IP, userAgent: UA }),
    stamp: {
      table: staffLoginLinks,
      id: staffLoginLinks.id,
      createdAt: staffLoginLinks.createdAt,
      column: staffLoginLinks.usedAt,
    },
    check: (result) => expect(result).toMatchObject({ ok: true }),
  },
];

describe('a stamp ordered against created_at, written by a transaction older than the row', () => {
  it.each(cases)('$name', async (c) => {
    const s = await seedStaff(tmp.db);
    let outerNow = '';
    let seeded: Seeded | undefined;
    let result: unknown;
    await tmp.db.transaction(async (outer) => {
      const { rows } = await outer.execute<{ now: string }>(sql`select now()::text as now`);
      outerNow = need(rows[0], 'now()').now;
      seeded = await c.seed(s);
      result = await c.write(outer, s, seeded);
    });
    c.check(result, s);
    const { table, id, createdAt, column } = c.stamp;
    const { rows } = await tmp.db.execute<{
      ordered: boolean;
      foreknown: boolean;
      stamped: boolean;
    }>(sql`
      select (${column} >= ${createdAt}) as ordered,
             (${createdAt} > ${outerNow}::timestamptz) as foreknown,
             (${column} is not null) as stamped
        from ${table}
       where ${id} = ${need(seeded, 'row').rowId}
    `);
    expect(rows).toEqual([{ ordered: true, foreknown: true, stamped: true }]);
  });
});
