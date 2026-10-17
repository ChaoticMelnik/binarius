import type { Api } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pairLabel,
  type PairsCatalogResponse,
  type TrackedSession,
  BotLanguage,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createSessionResumer } from './session-resume';
import type { ResumeSession } from './trading-session';
import { fakeLogger, PAIR_EURUSD, PAIRS_RESPONSE } from './testing';

const INTERVAL = 600_000;
const API = {} as Api;
const USERNAME = 'binarius_bot';

const row = (id: string, patch: Partial<TrackedSession> = {}): TrackedSession => ({
  id,
  telegramUserId: '4242',
  messageId: 77,
  assetId: PAIR_EURUSD.id,
  startedAt: '2026-10-07T10:00:00.000Z',
  language: BotLanguage.Ru,
  ...patch,
});
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

function setup(
  options: {
    list?: BackendClient['listTrackedSessions'];
    pairs?: BackendClient['readPairs'];
    tracked?: readonly string[];
  } = {},
) {
  const logger = fakeLogger();
  const listTrackedSessions = vi.fn<BackendClient['listTrackedSessions']>(
    options.list ?? (() => Promise.resolve([row(C), row(A, { assetId: null }), row(B)])),
  );
  const readPairs = vi.fn<BackendClient['readPairs']>(
    options.pairs ?? (() => Promise.resolve(PAIRS_RESPONSE as PairsCatalogResponse)),
  );
  const tracked = new Set(options.tracked ?? []);
  const has = vi.fn((id: string) => tracked.has(id));
  const resume = vi.fn<ResumeSession>();
  const resumer = createSessionResumer({
    backend: { listTrackedSessions, readPairs },
    tracker: { has },
    logger,
    intervalMs: INTERVAL,
  });
  resumer.attach(resume);
  return { resumer, resume, listTrackedSessions, readPairs, logger, has };
}

const resumedIds = (resume: ReturnType<typeof setup>['resume']) =>
  resume.mock.calls.map((call) => call[2].id);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the session resumer (#567)', () => {
  it('Q1 at the start reads the list beside the catalog and resumes every row on its label', async () => {
    const scene = setup();
    scene.resumer.start(API, USERNAME);
    expect(scene.listTrackedSessions).toHaveBeenCalledTimes(1);
    expect(scene.readPairs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(scene.resume.mock.calls).toEqual([
      [API, USERNAME, row(C), pairLabel(PAIR_EURUSD)],
      [API, USERNAME, row(A, { assetId: null }), null],
      [API, USERNAME, row(B), pairLabel(PAIR_EURUSD)],
    ]);
    expect(scene.logger.info.mock.calls).toEqual([
      [{ listed: 3, resumed: 3 }, 'trading sessions resumed'],
    ]);
    await scene.resumer.stop();
  });

  it('Q2 passes again once per interval', async () => {
    const scene = setup();
    scene.resumer.start(API, USERNAME);
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(scene.listTrackedSessions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(scene.listTrackedSessions).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(scene.listTrackedSessions).toHaveBeenCalledTimes(3);
    await scene.resumer.stop();
  });

  it('Q3 leaves a session the tracker holds alone', async () => {
    const scene = setup({ tracked: [A] });
    scene.resumer.start(API, USERNAME);
    await vi.advanceTimersByTimeAsync(0);
    expect(resumedIds(scene.resume)).toEqual([C, B]);
    expect(scene.logger.info.mock.calls).toEqual([
      [{ listed: 3, resumed: 2 }, 'trading sessions resumed'],
    ]);
    await scene.resumer.stop();
  });

  it('Q4 a list that cannot be read resumes nothing, warns, and the next pass reads it again', async () => {
    let calls = 0;
    const scene = setup({
      list: () =>
        calls++ === 0
          ? Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status: 503 }))
          : Promise.resolve([row(A)]),
    });
    scene.resumer.start(API, USERNAME);
    await vi.advanceTimersByTimeAsync(0);
    expect(scene.resume).not.toHaveBeenCalled();
    expect(scene.logger.warn.mock.calls.map((call) => [call[0].backendStatus, call[1]])).toEqual([
      [503, 'trading sessions not resumed'],
    ]);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(resumedIds(scene.resume)).toEqual([A]);
    await scene.resumer.stop();
  });

  it('Q5 a catalog that cannot be read resumes every row with no label', async () => {
    const scene = setup({
      pairs: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    scene.resumer.start(API, USERNAME);
    await vi.advanceTimersByTimeAsync(0);
    expect(scene.resume.mock.calls.map((call) => call[3])).toEqual([null, null, null]);
    expect(scene.logger.warn).not.toHaveBeenCalled();
    await scene.resumer.stop();
  });

  it('Q6 an empty list is quiet', async () => {
    const scene = setup({ list: () => Promise.resolve([]) });
    scene.resumer.start(API, USERNAME);
    await vi.advanceTimersByTimeAsync(0);
    expect(scene.resume).not.toHaveBeenCalled();
    expect(scene.logger.info).not.toHaveBeenCalled();
    expect(scene.logger.warn).not.toHaveBeenCalled();
    await scene.resumer.stop();
  });

  it('Q7 stop() waits for the pass in flight, which still resumes what it read, and no pass follows', async () => {
    let release: (rows: TrackedSession[]) => void = () => {};
    const scene = setup({
      list: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    scene.resumer.start(API, USERNAME);
    let stopped = false;
    const stopping = scene.resumer.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release([row(A)]);
    await stopping;
    expect(resumedIds(scene.resume)).toEqual([A]);
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(scene.listTrackedSessions).toHaveBeenCalledTimes(1);
    scene.resumer.start(API, USERNAME);
    expect(scene.listTrackedSessions).toHaveBeenCalledTimes(1);
  });

  it('Q8 one pass at a time: a tick during a slow pass starts none', async () => {
    let release: (rows: TrackedSession[]) => void = () => {};
    const scene = setup({
      list: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    scene.resumer.start(API, USERNAME);
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(scene.listTrackedSessions).toHaveBeenCalledTimes(1);
    release([]);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(scene.listTrackedSessions).toHaveBeenCalledTimes(2);
    release([]);
    await scene.resumer.stop();
  });

  it('refuses to start before a resume was attached', () => {
    const resumer = createSessionResumer({
      backend: { listTrackedSessions: vi.fn(), readPairs: vi.fn() },
      tracker: { has: () => false },
      logger: fakeLogger(),
      intervalMs: INTERVAL,
    });
    expect(() => resumer.start(API, USERNAME)).toThrow('session resumer started before attach()');
  });
});
