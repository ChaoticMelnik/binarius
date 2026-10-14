import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBrokerRestClient } from '@binarius/broker-rest';
import { AccessTokenRefusal } from '@binarius/shared';
import { startMockBroker, type MockBroker } from '@binarius/mock-broker';
import type { AccessTokenOptions, AccessTokenResult } from '../auth/token-service';
import type { DepositWidgetDeps } from '../deposit/widget-session';
import { runDepositProbe } from './deposit-probe';

const ACCOUNT_ID = '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01';
const TOKEN = 'probe-access-token';

let broker: MockBroker;
let printed: string[];
let logged: unknown[];
let tokenCalls: AccessTokenOptions[];
let tokenAnswer: AccessTokenResult;
let built: number;

const deps = (): DepositWidgetDeps => {
  built += 1;
  return {
    accessToken: (_id, options) => {
      tokenCalls.push(options);
      return Promise.resolve(tokenAnswer);
    },
    rest: createBrokerRestClient({ baseUrl: broker.url }),
    logger: {
      info: (...args: unknown[]) => void logged.push(args),
      warn: (...args: unknown[]) => void logged.push(args),
      error: (...args: unknown[]) => void logged.push(args),
    } as unknown as DepositWidgetDeps['logger'],
    webOrigin: 'https://cashier.example',
    platformOrigin: 'https://binodex.app',
    clientId: 'client-id',
    widgetOrigins: ['https://binodex.app', 'https://pay.binodex.app'],
  };
};

const probe = (demoOnly = false) =>
  runDepositProbe({ demoOnly, accountId: ACCOUNT_ID, widget: deps }, (line) => {
    printed.push(line);
  });

beforeAll(async () => {
  broker = await startMockBroker();
  broker.users.register({ id: 1, accessToken: TOKEN });
});
afterAll(() => broker.close());
beforeEach(() => {
  broker.rest.clearJournal();
  printed = [];
  logged = [];
  tokenCalls = [];
  tokenAnswer = { ok: true, accessToken: TOKEN };
  built = 0;
});

describe('deposit-probe', () => {
  it('P1 reports the outcome and the widget fields, never the session', async () => {
    broker.rest.failNext('widgetSession', {
      status: 200,
      body: {
        session: 'wss_PROBE_SECRET',
        expires_in: 60,
        widget_url: 'https://pay.binodex.app/embed?token=QUERY_SECRET',
        widget_origin: 'https://pay.binodex.app',
        region: 'ru',
      },
    });
    expect(await probe()).toBe(0);
    expect(printed).toEqual([
      'ok',
      'expiresInSec 60',
      'widget_url present, origin https://pay.binodex.app',
      'widget_origin present, https://pay.binodex.app',
      'region ru',
      'widget served from https://pay.binodex.app',
    ]);
    const everything = JSON.stringify([printed, logged]);
    expect(everything).not.toContain('wss_PROBE_SECRET');
    expect(everything).not.toContain('QUERY_SECRET');
    // a probe never exchanges a token
    expect(tokenCalls).toEqual([{ mayRefresh: false }]);
  });

  it('P1 reports absent widget fields and the fallback origin', async () => {
    expect(await probe()).toBe(0);
    expect(printed).toEqual([
      'ok',
      'expiresInSec 60',
      'widget_url absent',
      'widget_origin absent',
      'region absent',
      'widget served from https://binodex.app',
    ]);
    expect(broker.widgetSessions.list()).toEqual([
      { userId: 1, origin: 'https://cashier.example', mode: 'deposit' },
    ]);
  });

  it('P2 refuses on a DEMO_ONLY process before building anything (#396)', async () => {
    expect(await probe(true)).toBe(1);
    expect(printed).toEqual([
      'refused: demo_only (this process runs DEMO_ONLY=true; docs/deposit.md -> The probe)',
    ]);
    expect(built).toBe(0);
    expect(tokenCalls).toEqual([]);
    expect(broker.rest.journal).toEqual([]);
  });

  it('P3 tells the owner how to get a fresh token', async () => {
    tokenAnswer = { ok: false, reason: AccessTokenRefusal.RefreshNeeded };
    expect(await probe()).toBe(1);
    expect(printed).toEqual(['refused: refresh_needed (open the bot balance once, then retry)']);
    expect(broker.rest.journal).toEqual([]);
  });

  it('P4 names a broker refusal with its status', async () => {
    broker.rest.failNext('widgetSession', { status: 403 });
    expect(await probe()).toBe(1);
    expect(printed).toEqual(['broker_rejected: broker rejected HTTP 403']);
  });

  it('P4 names a widget origin outside the allowlist', async () => {
    broker.rest.failNext('widgetSession', {
      status: 200,
      body: { session: 'wss_PROBE_ORIGIN', expires_in: 60, widget_origin: 'https://evil.example' },
    });
    expect(await probe()).toBe(1);
    expect(printed).toEqual([
      'broker_rejected: widget origin https://evil.example is not in DEPOSIT_WIDGET_ORIGINS',
    ]);
    expect(JSON.stringify([printed, logged])).not.toContain('wss_PROBE_ORIGIN');
  });
});
