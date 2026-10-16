import type { Api } from 'grammy';
import {
  errorLogFields,
  pairLabel,
  type PairLabel,
  type PairsCatalogResponse,
} from '@binarius/shared';
import { backendErrorFields, type BackendClient } from './backend-client';
import type { Logger } from './logging';
import type { SessionTracker } from './session-tracker';
import type { ResumeSession } from './trading-session';

// The recovery of session tracking after a restart (#567, docs/bot-session.md → Recovery after a
// restart). At the bot's start and every intervalMs after it, one pass reads the backend's list of
// sessions with a recorded status message and no card, beside the pairs catalog for their labels,
// and tracks each session the tracker does not hold on its message. One pass at a time; the list
// and the catalog are the pass's only calls, nothing per session.

export interface SessionResumer {
  // the session composer's resume, wired once by createBot
  attach(resume: ResumeSession): void;
  // the first pass now, not awaited, then one every intervalMs
  start(api: Api, botUsername: string): void;
  // no pass after it; waits for the one in flight
  stop(): Promise<void>;
}

export interface SessionResumerOptions {
  backend: Pick<BackendClient, 'listTrackedSessions' | 'readPairs'>;
  tracker: Pick<SessionTracker, 'has'>;
  logger: Logger;
  intervalMs: number;
}

// the pair's label from any catalog, a stale one included; null names the asset by its id
const labelOf = (
  catalog: PromiseSettledResult<PairsCatalogResponse>,
  assetId: number | null,
): PairLabel | null => {
  if (catalog.status !== 'fulfilled' || assetId === null) return null;
  const pair = catalog.value.pairs.find((listed) => listed.id === assetId);
  return pair === undefined ? null : pairLabel(pair);
};

export function createSessionResumer({
  backend,
  tracker,
  logger,
  intervalMs,
}: SessionResumerOptions): SessionResumer {
  let resume: ResumeSession | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopping = false;

  async function pass(api: Api, botUsername: string, attached: ResumeSession): Promise<void> {
    const [listed, catalog] = await Promise.allSettled([
      backend.listTrackedSessions(),
      backend.readPairs(),
    ]);
    if (listed.status !== 'fulfilled') {
      logger.warn(
        { ...errorLogFields(listed.reason), ...backendErrorFields(listed.reason) },
        'trading sessions not resumed',
      );
      return;
    }
    let resumed = 0;
    for (const session of listed.value) {
      if (tracker.has(session.id)) continue;
      attached(api, botUsername, session, labelOf(catalog, session.assetId));
      resumed += 1;
    }
    if (resumed > 0) {
      logger.info({ listed: listed.value.length, resumed }, 'trading sessions resumed');
    }
  }

  const run = (api: Api, botUsername: string, attached: ResumeSession): void => {
    if (stopping || inFlight !== undefined) return;
    const current = pass(api, botUsername, attached)
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'trading sessions resume failed');
      })
      .finally(() => {
        inFlight = undefined;
      });
    inFlight = current;
  };

  return {
    attach(next) {
      resume = next;
    },
    start(api, botUsername) {
      const attached = resume;
      if (attached === undefined) throw new Error('session resumer started before attach()');
      if (stopping || timer !== undefined) return;
      run(api, botUsername, attached);
      timer = setInterval(() => run(api, botUsername, attached), intervalMs);
    },
    async stop() {
      stopping = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
