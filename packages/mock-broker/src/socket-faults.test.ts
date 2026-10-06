import { describe, expect, it } from 'vitest';
import { FaultQueue } from './faults';
import {
  assertSocketScript,
  socketScriptKind,
  type MockAuthScript,
  type MockConnectScript,
  type MockOpenTradeScript,
  type MockSocketEndpoint,
  type MockSocketScript,
} from './socket-faults';

const queue = () =>
  new FaultQueue<MockSocketEndpoint, MockSocketScript<MockSocketEndpoint>>(assertSocketScript);

describe('socket scripts', () => {
  it.each<[MockSocketEndpoint, MockConnectScript | MockAuthScript | MockOpenTradeScript, unknown]>([
    ['connect', { error: { message: 'no' } }, { kind: 'error', message: 'no' }],
    ['auth', { error: { message: 'no' } }, { kind: 'error', message: 'no' }],
    ['auth', { silent: true }, { kind: 'silent', open: false }],
    ['auth', { disconnect: true }, { kind: 'disconnect', open: false }],
    [
      'openTrade',
      { fail: [{ message: 'no', field: 'amount' }] },
      { kind: 'fail', failures: [{ message: 'no', field: 'amount' }] },
    ],
    ['openTrade', { silent: true }, { kind: 'silent', open: false }],
    ['openTrade', { silent: true, open: true }, { kind: 'silent', open: true }],
    ['openTrade', { disconnect: true, open: true }, { kind: 'disconnect', open: true }],
    ['openTrade', { delayMs: 0 }, { kind: 'delay', delayMs: 0 }],
  ])('%s accepts %j', (endpoint, script, played) => {
    const faults = queue();
    faults.push(endpoint, script);
    expect(faults.shift(endpoint)).toBe(script);
    expect(socketScriptKind(script)).toEqual(played);
  });

  it.each<[MockSocketEndpoint, unknown, ErrorConstructor]>([
    ['openTrade', { fail: [{ message: 'x' }], silent: true }, TypeError],
    ['openTrade', { silent: true, delayMs: 1 }, TypeError],
    ['openTrade', { disconnect: false }, TypeError],
    ['openTrade', { open: true }, TypeError],
    ['openTrade', { delayMs: 1, open: true }, TypeError],
    ['openTrade', { fail: [{ message: 'x' }], open: true }, TypeError],
    ['openTrade', { fail: [{}] }, TypeError],
    ['openTrade', { silent: true, open: 'yes' }, TypeError],
    ['openTrade', { delayMs: -1 }, RangeError],
    ['openTrade', { delayMs: 1.5 }, RangeError],
    ['openTrade', { error: { message: 'x' } }, TypeError],
    ['connect', { error: {} }, TypeError],
    ['connect', { silent: true }, TypeError],
    ['connect', { disconnect: true }, TypeError],
    ['auth', { error: {} }, TypeError],
    ['auth', { silent: true, open: true }, TypeError],
    ['auth', { delayMs: 1 }, TypeError],
    ['auth', { fail: [] }, TypeError],
    ['auth', null, TypeError],
    ['nope' as MockSocketEndpoint, { silent: true }, TypeError],
  ])('%s refuses %j', (endpoint, script, error) => {
    const faults = queue();
    expect(() => faults.push(endpoint, script as MockSocketScript<MockSocketEndpoint>)).toThrow(
      error,
    );
    expect(faults.shift(endpoint)).toBeUndefined();
  });

  it('keeps the mixed shapes out of the type', () => {
    const scripts: MockOpenTradeScript[] = [
      // @ts-expect-error fail and silent exclude each other
      { fail: [{ message: 'x' }], silent: true },
      // @ts-expect-error silent and delayMs exclude each other
      { silent: true, delayMs: 1 },
      // @ts-expect-error disconnect is true only
      { disconnect: false },
      // @ts-expect-error open needs silent or disconnect
      { open: true },
      // @ts-expect-error delayMs takes no open
      { delayMs: 1, open: true },
    ];
    const auth: MockAuthScript[] = [
      // @ts-expect-error error is { message }
      { error: {} },
      // @ts-expect-error auth has no open
      { silent: true, open: true },
      // @ts-expect-error auth has no delayMs
      { delayMs: 1 },
    ];
    expect(scripts.length + auth.length).toBe(8);
  });
});
