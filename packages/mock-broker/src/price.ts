// One deterministic price curve per asset, shared by the chart, open_price and close_price, so a
// test can predict any of them from the asset id and a timestamp alone.

const TWO_PI = Math.PI * 2;
const PERIODS_MS = [6 * 3_600_000, 37 * 60_000, 3 * 60_000] as const;
const WEIGHTS = [0.6, 0.3, 0.1] as const;
// the curve stays within ±0.4% of the asset's base price
const AMPLITUDE = 0.004;

function mix(value: number): number {
  let h = value >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

export function hashAsset(assetId: number, salt = 0): number {
  return mix(mix(assetId) ^ mix(salt + 0x9e3779b9));
}

// a timestamp exceeds 32 bits, so both halves take part
export function hashAt(assetId: number, atMs: number): number {
  return hashAsset(assetId, mix(atMs % 2 ** 32) ^ Math.floor(atMs / 2 ** 32));
}

const unit = (hash: number) => hash / 2 ** 32;

export function basePrice(assetId: number): number {
  return 1 + unit(hashAsset(assetId)) * 999;
}

export function rawPriceAt(assetId: number, atMs: number): number {
  const wave = PERIODS_MS.reduce((sum, period, index) => {
    const phase = unit(hashAsset(assetId, index + 1)) * TWO_PI;
    return sum + (WEIGHTS[index] ?? 0) * Math.sin((TWO_PI * atMs) / period + phase);
  }, 0);
  return basePrice(assetId) * (1 + AMPLITUDE * wave);
}

export function roundTo(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

// the deviation of a candle's high and low beyond its open and close, at most 0.05% of the base
export function wickAt(assetId: number, atMs: number): number {
  return unit(hashAt(assetId, atMs)) * basePrice(assetId) * 0.0005;
}
