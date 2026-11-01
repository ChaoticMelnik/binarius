import type { PairsCatalogResponse } from '@binarius/shared';
import type { BackendClient } from './backend-client';

// The pairs catalog read once for every reader of the process (#875): the demo's screens, the
// stake press, the wait for a signal's tick, the session start and its recovery. A read in flight
// is shared by every caller meanwhile; its answer is given for `ttlMs` from the moment it came,
// `fresh: false` too (that is the backend's verdict on its own snapshot); a failure is not kept,
// so the next call reads again. The answer object is shared: its readers only read it.
export function withPairsCache(
  backend: BackendClient,
  { ttlMs, now = Date.now }: { ttlMs: number; now?: () => number },
): BackendClient {
  let inFlight: Promise<PairsCatalogResponse> | undefined;
  let kept: { answer: PairsCatalogResponse; at: number } | undefined;
  const readPairs = (): Promise<PairsCatalogResponse> => {
    if (kept !== undefined && now() - kept.at < ttlMs) return Promise.resolve(kept.answer);
    if (inFlight !== undefined) return inFlight;
    const reading = backend.readPairs().then(
      (answer) => {
        kept = { answer, at: now() };
        inFlight = undefined;
        return answer;
      },
      (error: unknown) => {
        inFlight = undefined;
        throw error;
      },
    );
    inFlight = reading;
    return reading;
  };
  return { ...backend, readPairs };
}
