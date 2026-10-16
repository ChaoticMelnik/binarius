import { describe, expect, it } from 'vitest';
import { TradingSessionDbErrorCode } from '@binarius/db';
import { BrokerAccountStatus, type DecimalString } from '@binarius/shared';
import { pickSessionAccount, planSessionStart, SESSION_START_REFUSALS } from './start';

const A = '0b8f3c62-7a1e-4d2b-9a55-3c1f2e4d5a6b';
const B = '1c9f4d73-8b2f-4e3c-8b66-4d2f3e5e6b7c';
const C = '2da05e84-9c30-4f4d-9c77-5e304f6f7c8d';

describe('pickSessionAccount (#287)', () => {
  it('C1 takes the only active account, whatever else the user has', () => {
    expect(
      pickSessionAccount([
        { id: A, status: BrokerAccountStatus.Revoked },
        { id: B, status: BrokerAccountStatus.Active },
        { id: C, status: BrokerAccountStatus.Pending },
      ]),
    ).toEqual({ ok: true, brokerAccountId: B });
  });

  it('C2 refuses two active accounts and lists both, without anything else of the row', () => {
    const pick = pickSessionAccount([
      { id: A, status: BrokerAccountStatus.Active, email: 'a@example.com' } as never,
      { id: B, status: BrokerAccountStatus.Active, email: 'b@example.com' } as never,
    ]);
    expect(pick).toEqual({
      ok: false,
      reason: 'ambiguous_account',
      accounts: [
        { id: A, status: BrokerAccountStatus.Active },
        { id: B, status: BrokerAccountStatus.Active },
      ],
    });
    expect(JSON.stringify(pick)).not.toContain('example.com');
  });

  it('C3 without an active account: account_not_confirmed when one is pending, else no_active_account', () => {
    expect(pickSessionAccount([{ id: A, status: BrokerAccountStatus.Pending }])).toEqual({
      ok: false,
      reason: 'account_not_confirmed',
    });
    expect(pickSessionAccount([{ id: A, status: BrokerAccountStatus.Revoked }])).toEqual({
      ok: false,
      reason: 'no_active_account',
    });
    expect(pickSessionAccount([])).toEqual({ ok: false, reason: 'no_active_account' });
  });

  it('C7 takes ACCOUNT_ID only when it is one of the user’s accounts (review m1)', () => {
    const own = [{ id: A, status: BrokerAccountStatus.Active }];
    expect(pickSessionAccount(own, A)).toEqual({ ok: true, brokerAccountId: A });
    expect(pickSessionAccount(own, C)).toEqual({ ok: false, reason: 'account_not_found' });
    // pg answers uuids in lower case; the pick hands on the listed spelling
    expect(pickSessionAccount(own, A.toUpperCase())).toEqual({ ok: true, brokerAccountId: A });
  });
});

const plan = (patch: Partial<Parameters<typeof planSessionStart>[0]> = {}) =>
  planSessionStart({
    assetId: 101,
    durationSec: 60,
    cycles: 5,
    minTradeAmount: '1.00000000' as DecimalString,
    strategy: 'fixed',
    ...patch,
  });

describe('planSessionStart (#287)', () => {
  it('C4 refuses a session that cannot fit the deadline, the start route’s predicate', () => {
    expect(plan({ cycles: 20, durationSec: 600 })).toEqual({
      ok: false,
      reason: 'session_too_long',
    });
    expect(plan()).toMatchObject({ ok: true });
  });

  // #552: the worst case of the CLI's strategy, as the start route
  it('counts martingale cycles at MARTINGALE_MAX_STEPS trades, fixed ones at one', () => {
    expect(plan({ cycles: 5, durationSec: 300, strategy: 'fixed' })).toMatchObject({ ok: true });
    expect(plan({ cycles: 5, durationSec: 300, strategy: 'martingale' })).toEqual({
      ok: false,
      reason: 'session_too_long',
    });
    expect(plan({ cycles: 5, durationSec: 60, strategy: 'martingale' })).toMatchObject({
      ok: true,
      settings: { version: 3, cycles: 5 },
    });
  });

  it.each([
    ['1.00000000', { baseStake: '1', stakeScale: 0 }],
    ['0.50000000', { baseStake: '0.5', stakeScale: 1 }],
    ['1.25000000', { baseStake: '1.25', stakeScale: 2 }],
    ['0.00000001', { baseStake: '0.00000001', stakeScale: 8 }],
  ])('C5 builds settings v3 fixed from a minimum of %s', (minTradeAmount, stake) => {
    expect(plan({ minTradeAmount: minTradeAmount as DecimalString })).toEqual({
      ok: true,
      settings: {
        version: 3,
        assetId: 101,
        durationSec: 60,
        cycles: 5,
        stake: { strategy: 'fixed', ...stake },
      },
    });
  });

  // #450: the CLI's SESSION_STAKE_STRATEGY, with the default limits of the minimum
  it('C8 builds settings v3 martingale with the limits of its base stake', () => {
    expect(plan({ minTradeAmount: '1.25000000' as DecimalString, strategy: 'martingale' })).toEqual(
      {
        ok: true,
        settings: {
          version: 3,
          assetId: 101,
          durationSec: 60,
          cycles: 5,
          stake: {
            strategy: 'martingale',
            baseStake: '1.25',
            stakeScale: 2,
            limits: {
              maxSteps: 4,
              maxStake: '15',
              maxSessionLoss: '25',
              maxSessionDurationMs: 3_600_000,
            },
          },
        },
      },
    );
  });

  it('C9 refuses a martingale minimum whose limits leave numeric(20,8) as invalid_settings', () => {
    expect(
      plan({ minTradeAmount: '100000000000' as DecimalString, strategy: 'martingale' }),
    ).toEqual({ ok: false, reason: 'invalid_settings' });
    expect(plan({ minTradeAmount: '100000000000' as DecimalString })).toMatchObject({ ok: true });
  });

  it.each(['0.00000000', '0', '00.000'])(
    'C5a refuses a zero minimum %s with its own reason (#130 n1)',
    (minTradeAmount) => {
      expect(plan({ minTradeAmount: minTradeAmount as DecimalString })).toEqual({
        ok: false,
        reason: 'zero_min_trade_amount',
      });
    },
  );

  it('refuses a duration the intent schema refuses as invalid_settings', () => {
    expect(plan({ durationSec: 4, cycles: 1 })).toEqual({ ok: false, reason: 'invalid_settings' });
  });
});

describe('SESSION_START_REFUSALS (#287)', () => {
  it('C6 has a non-empty Russian text for every refusal of createTradingSession', () => {
    for (const code of Object.values(TradingSessionDbErrorCode)) {
      expect(SESSION_START_REFUSALS[code]).toMatch(/[а-яА-Я]/);
    }
  });

  // #327: the CLI creates demo sessions only, and a session only in its user's mode
  it('names the way out for a user in real mode', () => {
    expect(SESSION_START_REFUSALS[TradingSessionDbErrorCode.ModeNotAllowed]).toBe(
      'Пользователь в реальном режиме: CLI создаёт только demo-сессии — запустите сессию из бота или верните пользователя в demo',
    );
  });
});
