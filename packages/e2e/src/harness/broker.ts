import {
  MockSocketPayload,
  startMockBroker,
  type MockBroker,
  type MockTradeWire,
} from '@binarius/mock-broker';
import { E2E_BROKER_USER_ID, E2E_EMAIL, E2E_PAIR, MOCK_OAUTH } from './env';

export interface RampPricePath {
  originMs: number;
  candleMs: number;
  slopePerCandle: number;
  zigzag: number;
  basePrice: number;
}

// A rising ramp with a two-candle zigzag: base × (1 + slope × k + zigzag × (k mod 2)), k the candle
// index from originMs. The architect's probe (#105 plan, 2026-10-17) ran decider v2 with
// DEFAULT_SIGNAL_PARAMS on candles built the way the mock builds them, at 60 clock positions within
// and across 15 s candles: `signal:up` at all 60 (RSI ≈ 58, ATR ≈ 0.096 %). Without the zigzag RSI
// is 100 (rsi_overbought); the mock's own waves are volatility_too_low. The decision does not
// depend on where in the candle the press falls, so the test does not either.
export function rampPricePath(ramp: RampPricePath) {
  return (_assetId: number, atMs: number): number => {
    const k = Math.floor((atMs - ramp.originMs) / ramp.candleMs);
    const odd = ((k % 2) + 2) % 2;
    return ramp.basePrice * (1 + ramp.slopePerCandle * k + ramp.zigzag * odd);
  };
}

export const E2E_RAMP = {
  candleMs: 15_000,
  slopePerCandle: 0.0001,
  zigzag: 0.0005,
  basePrice: 1.08765,
} as const;

// The broker of the run: E2E_PAIR alone, the ramp as its one price curve, the installation's OAuth
// client, the bytes payload form the live socket uses, and the user the email login signs in to.
export async function startE2eBroker(): Promise<MockBroker> {
  const broker = await startMockBroker({
    socketPayload: MockSocketPayload.Bytes,
    pairs: [E2E_PAIR],
    pricePath: rampPricePath({ originMs: Date.now(), ...E2E_RAMP }),
    oauth: MOCK_OAUTH,
  });
  broker.users.register({ id: E2E_BROKER_USER_ID, email: E2E_EMAIL });
  return broker;
}

export const tradesOf = (broker: MockBroker, userId: number): MockTradeWire[] =>
  broker.trades.list(userId).sort((a, b) => Number(a.id) - Number(b.id));
