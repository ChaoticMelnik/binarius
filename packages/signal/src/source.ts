import type { Candle, SignalInterval } from '@binarius/shared';

// The candle window of the data socket's ring (#404, docs/market-data.md), as the feed reads it.
export interface CandleWindow {
  // closed candles of the window, ascending: tick-built, or REST rows fill() put into empty buckets
  candles: Candle[];
  // the latest bucket of the window the ring has not closed, when the pair has a candle in it: the
  // current bucket of nowMs, or the one before it until the watermark or the clock margin closes it
  // (docs/market-data.md -> Closing a candle); the feed uses it only when it is the current one
  forming?: Candle;
  // buckets ending at or before this are closed (docs/market-data.md -> Closing a candle)
  closedUntil: number;
  // the first bucket of the window: chartWindow(nowMs, interval, capacity).startTime
  startTime: number;
  // the closed buckets of the window that have no candle, ascending
  gaps: number[];
}

// docs/signal.md -> Feed and journal (#405). read is undefined when the source has no window for
// the key: no ready socket, an interval the ring does not build, or no source at all; the feed then
// reads REST. request asks for a refill of the window and never throws.
export interface SignalCandleSource {
  read(assetId: number, interval: SignalInterval, nowMs: number): CandleWindow | undefined;
  request(assetId: number, interval: SignalInterval): void;
}

// the gate of the feed's REST GETs (docs/signal.md -> The budget); the backend's ScanPacer fits
export interface SignalRestPacer {
  tryTake(): boolean;
  onRateLimited(retryAfterSec: number | undefined): number;
  onDecided(): void;
  pausedUntil(): number | undefined;
}
