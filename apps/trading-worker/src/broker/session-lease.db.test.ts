import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireSessionLease,
  listSessionCandidates,
  releaseSessionLeases,
  renewSessionLeases,
  upsertBalanceSnapshot,
  type Db,
} from '@binarius/db';
import {
  createTempDatabase,
  seedBrokerAccount,
  seedUser,
  type TempDatabase,
} from '@binarius/db/testing';
import { MockSocketPayload, startMockBroker, type MockBroker } from '@binarius/mock-broker';
import { logOptions, type DecimalString } from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import type { SessionManagerConfig } from './session-config';
import {
  createBrokerSessionManager,
  type BrokerSessionManager,
  type SessionLeases,
} from './session-manager';

// The acceptance criteria of #93 on a real database and the mock broker: two managers never
// hold a socket of one account at once, and a lease left by a dead owner lapses so another
// process takes the account over.

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/trading-worker integration tests (see README → Test database)',
  );
}

// one broker user per case: broker_accounts.broker_user_id is unique
let nextBrokerUser = 9;
const tokenOf = (brokerUser: number) => `SECRET-TOKEN-of-user-${brokerUser}`;
const tokenOfAccount = new Map<string, string>();
const TIMING = {
  connectTimeoutMs: 1_000,
  authTimeoutMs: 200,
  reconnectDelayMs: 20,
  reconnectDelayMaxMs: 40,
  jitter: 0,
};
const CONFIG: SessionManagerConfig = {
  tickMs: 1_000,
  idleGraceMs: 10_000,
  retryMs: 300,
  refusalRetryMs: 1_500,
  maxSessions: 10,
  startConcurrency: 4,
  stopBudgetMs: 500,
  watchWindowMs: 600_000,
  leaseTtlMs: 30_000,
  leaseRenewMs: 6_000,
  leaseRenewTimeoutMs: 3_000,
  leaseFenceMs: 25_000,
};

let tmp: TempDatabase;
let broker: MockBroker;
const managers: BrokerSessionManager[] = [];
const events: string[] = [];

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  broker = await startMockBroker({ socketPayload: MockSocketPayload.Bytes });
});
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  events.length = 0;
});
afterAll(async () => {
  await broker.close();
  await tmp.drop();
});

// an account the bot asked about a moment ago: in work, so every manager lists it
async function accountInWork(): Promise<string> {
  const brokerUser = nextBrokerUser++;
  broker.users.register({ id: brokerUser, accessToken: tokenOf(brokerUser) });
  const user = await seedUser(tmp.db);
  const accountId = await seedBrokerAccount(tmp.db, user.userId, {
    brokerUserId: String(brokerUser),
  });
  const money = (value: string) => value as DecimalString;
  await upsertBalanceSnapshot(tmp.db, {
    brokerAccountId: accountId,
    requested: true,
    user: {
      id: String(brokerUser),
      level: { code: 'standard', rank: 1 },
      minTradeAmount: money('1'),
      real: { available: money('0'), held: money('0'), total: money('0') },
      demo: { available: money('1'), held: money('0'), total: money('1') },
    },
  });
  tokenOfAccount.set(accountId, tokenOf(brokerUser));
  return accountId;
}

const leasesOf = (db: Db, ownerId: string): SessionLeases => ({
  acquire: (accountId, ttlMs) => acquireSessionLease(db, { accountId, ownerId, ttlMs }),
  renew: (accountIds, ttlMs) => renewSessionLeases(db, { ownerId, accountIds, ttlMs }),
  release: () => releaseSessionLeases(db, { ownerId }),
});

// `filtered: false` lists every account in work for both managers, so only the acquire can keep
// them apart: the scan's lease filter is an optimisation, not the guarantee
function managerOf(
  name: string,
  config: Partial<SessionManagerConfig> = {},
  { filtered = true }: { filtered?: boolean } = {},
) {
  const ownerId = randomUUID();
  const manager = createBrokerSessionManager({
    url: broker.url,
    deadLetters: { add: () => Promise.resolve() },
    leases: leasesOf(tmp.db, ownerId),
    candidates: (options) =>
      listSessionCandidates(tmp.db, filtered ? { ...options, ownerId } : options),
    tokens: {
      accessToken: (accountId) =>
        Promise.resolve({ ok: true, accessToken: tokenOfAccount.get(accountId)! }),
    },
    writers: {
      snapshot: () => Promise.resolve({ written: true }),
      balanceEvent: () => Promise.resolve({ written: true }),
      closedTrades: () => Promise.resolve([]),
    },
    logger: pino(logOptions('debug'), {
      write: (line: string) => {
        // every line of a case's own account carries it; another case's account may be in work
        // too and is picked up as well
        const { msg, accountId } = JSON.parse(line) as { msg: string; accountId?: string };
        events.push(`${name}: ${msg}${accountId === undefined ? '' : ` ${accountId}`}`);
      },
    }),
    config: { ...CONFIG, ...config },
    timing: TIMING,
  });
  managers.push(manager);
  return manager;
}

describe('the session lease across processes (#93)', () => {
  it('M1 two managers over one database open one socket for an account', async () => {
    const accountId = await accountInWork();
    const a = managerOf('A', {}, { filtered: false });
    const b = managerOf('B', {}, { filtered: false });
    // the first round, before any renewal: the acquire alone keeps one of them out
    await Promise.all([a.tick(), b.tick()]);
    await until('the loser told the account is busy', () =>
      events.some((e) => e.endsWith(`broker session lease busy ${accountId}`)),
    );
    expect([a, b].filter((m) => m.size === 1)).toHaveLength(1);
    for (let round = 0; round < 3; round += 1) {
      await Promise.all([a.renewLeases(), b.renewLeases()]);
      await Promise.all([a.tick(), b.tick()]);
    }
    await until('the winner holds the account', () =>
      [a, b].some((m) => m.clientFor(accountId) !== undefined),
    );
    expect([a, b].filter((m) => m.clientFor(accountId) !== undefined)).toHaveLength(1);
    const userOfAccount = Number(tokenOfAccount.get(accountId)!.split('-').at(-1));
    const socketsOfAccount = () =>
      broker.socket.sockets().filter((sock) => sock.userId === userOfAccount);
    await until('the socket', () => socketsOfAccount().length === 1);
    expect(socketsOfAccount()).toHaveLength(1);
    await a.stop();
    await b.stop();
    await until('no socket after both stopped', () => socketsOfAccount().length === 0);
  });

  it('M2 a dead owner’s lease lapses: its socket is fenced first, then another process takes the account', async () => {
    const accountId = await accountInWork();
    // short leases; the owner never renews, the way a process that died does
    const lease = { leaseTtlMs: 600, leaseFenceMs: 450, leaseRenewMs: 100, retryMs: 700 };
    const dead = managerOf('dead', lease);
    await dead.tick();
    await until('the dead owner’s client', () => dead.clientFor(accountId) !== undefined);
    const next = managerOf('next', lease);
    // while the lease lives, the scan does not even list the account for the next process
    await next.tick();
    expect(next.size).toBe(0);
    await until('the account taken over', async () => {
      await next.tick();
      return next.clientFor(accountId) !== undefined;
    });
    // the dead owner's socket closed before the next one's opened: the fence fires before the
    // lease lapses, and the database refused the account until it did
    const fenced = events.indexOf(`dead: broker session lease fenced ${accountId}`);
    const nextSocket = events.indexOf(`next: broker socket state ${accountId}`);
    expect(fenced).toBeGreaterThan(-1);
    expect(nextSocket).toBeGreaterThan(fenced);
    expect(dead.clientFor(accountId)).toBeUndefined();
    const userOfAccount = Number(tokenOfAccount.get(accountId)!.split('-').at(-1));
    await until('one socket of the account', () => {
      return broker.socket.sockets().filter((sock) => sock.userId === userOfAccount).length === 1;
    });
  });
});
