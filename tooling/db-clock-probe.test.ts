import { describe, expect, it } from 'vitest';
import { classifySample, exitCode, SKEW_LIMIT_MS } from './db-clock-probe';

const HOST_MS = 1_790_933_395_686;
const at = (dbMs: number, hostMs = HOST_MS) => ({ dbUs: BigInt(Math.round(dbMs * 1000)), hostMs });

describe('classifySample', () => {
  it('reports a step back with its size, down to a sub-millisecond one', () => {
    expect(classifySample(at(HOST_MS), at(HOST_MS - 100)).stepBackUs).toBe(100_000n);
    expect(classifySample(at(HOST_MS), at(HOST_MS - 0.5)).stepBackUs).toBe(500n);
  });

  it('reports no step for a clock that stood still or moved on, or for the first sample', () => {
    expect(classifySample(at(HOST_MS), at(HOST_MS)).stepBackUs).toBeUndefined();
    expect(classifySample(at(HOST_MS), at(HOST_MS + 5)).stepBackUs).toBeUndefined();
    expect(classifySample(undefined, at(HOST_MS - 100)).stepBackUs).toBeUndefined();
  });

  // the Colima VM's clock after a Mac sleep: 84 minutes behind, and moving forward all along
  it('flags a database clock far behind the host although it never stepped back', () => {
    const behind = HOST_MS - 84 * 60_000;
    const verdict = classifySample(at(behind - 5), at(behind));
    expect(verdict.stepBackUs).toBeUndefined();
    expect(verdict.skewMs).toBe(-84 * 60_000);
    expect(verdict.skewed).toBe(true);
  });

  it('flags a skew past the limit in either direction, and nothing up to it', () => {
    expect(classifySample(undefined, at(HOST_MS + SKEW_LIMIT_MS)).skewed).toBe(false);
    expect(classifySample(undefined, at(HOST_MS - SKEW_LIMIT_MS)).skewed).toBe(false);
    expect(classifySample(undefined, at(HOST_MS + SKEW_LIMIT_MS + 1)).skewed).toBe(true);
    expect(classifySample(undefined, at(HOST_MS - SKEW_LIMIT_MS - 1)).skewed).toBe(true);
  });
});

describe('exitCode', () => {
  it('is 2 without a sample, whatever else was counted', () => {
    expect(exitCode(0, 0, 0)).toBe(2);
  });

  it('is 1 for a step back or a skewed sample, 0 for neither', () => {
    expect(exitCode(10, 1, 0)).toBe(1);
    expect(exitCode(10, 0, 1)).toBe(1);
    expect(exitCode(10, 0, 0)).toBe(0);
  });
});
