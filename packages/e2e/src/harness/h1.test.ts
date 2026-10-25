import { describe, expect, it } from 'vitest';
import { H1_R1_PARAMS, SignalKind, TradeAction } from '@binarius/shared';
import { createH1Detector } from '@binarius/signal';
import { H1_PUMP_HISTORY_SEC, h1PumpPrice } from './h1';

// E2E-H1 (#828): the pump's ramp is checked by the detector itself, not assumed. The demo cycle
// runs for about two minutes past the history, so the check spans ten minutes of seconds.
describe("the e2e's second series pump", () => {
  it('E2E-H1 R1 reads the 5-digit ramp as up on every second of the history and the run', () => {
    const detector = createH1Detector(H1_R1_PARAMS);
    const closes = Float64Array.from({ length: H1_PUMP_HISTORY_SEC + 600 }, (_, t) =>
      h1PumpPrice(t, 5),
    );
    const decisions = [];
    for (let at = H1_R1_PARAMS.sdWindowSec; at < closes.length; at += 1) {
      const window = closes.subarray(at - H1_R1_PARAMS.sdWindowSec, at + 1);
      decisions.push(detector.decide({ closes: window, at: H1_R1_PARAMS.sdWindowSec }));
    }
    expect(decisions).toHaveLength(closes.length - H1_R1_PARAMS.sdWindowSec);
    for (const decision of decisions) {
      expect(decision).toMatchObject({ kind: SignalKind.Signal, action: TradeAction.Up });
    }
  });
});
