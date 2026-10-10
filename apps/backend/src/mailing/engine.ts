import type { FastifyBaseLogger } from 'fastify';
import { GrammyError } from 'grammy';
import { errorIdentity, errorLogFields } from '@binarius/shared';
import {
  claimMailingJob,
  planMailingJobs,
  settleMailingJob,
  type ClaimedMailingJob,
  type Db,
  type MailingOutcome,
} from '@binarius/db';
import type { ClientPush, ClientPushMessage } from '../auth/client-push';
import { telegramErrorFields } from '../telegram-logging';
import {
  MAILING_CLAIM_SCAN,
  MAILING_MAX_ATTEMPTS,
  MAILING_PLAN_TICK_MS,
  MAILING_RETRY_MS,
  MAILING_SEND_BATCH,
  MAILING_SEND_PER_SECOND,
  MAILING_SEND_TICK_MS,
} from '../timing';
import { recordTelegramSendFailure } from '../users/telegram-delivery';
import { mailingMessage } from './messages';

// docs/mailing.md. Two loops in the backend process: the planner turns facts into
// notification_jobs rows, the sender delivers the due ones through the client push, one at a
// time and at most MAILING_SEND_PER_SECOND. Neither touches a trading or linking write path.

export interface MailingConfig {
  planTickMs: number;
  sendTickMs: number;
  sendBatch: number;
  claimScan: number;
  perSecond: number;
  retryMs: number;
  maxAttempts: number;
}

export const DEFAULT_MAILING_CONFIG: MailingConfig = {
  planTickMs: MAILING_PLAN_TICK_MS,
  sendTickMs: MAILING_SEND_TICK_MS,
  sendBatch: MAILING_SEND_BATCH,
  claimScan: MAILING_CLAIM_SCAN,
  perSecond: MAILING_SEND_PER_SECOND,
  retryMs: MAILING_RETRY_MS,
  maxAttempts: MAILING_MAX_ATTEMPTS,
};

export interface MailingEngineDeps {
  db: Db;
  push: Pick<ClientPush, 'sendMailing'>;
  logger: FastifyBaseLogger;
  config?: Partial<MailingConfig>;
  // the tests' clock and sleep; the engine's own pacing and pause read only these
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MailingEngine {
  planTick(): Promise<void>;
  sendTick(): Promise<void>;
  start(): void;
  // Ends both loops and waits for the statement or the send in flight: at most one send.
  stop(): Promise<void>;
}

// Spaces the sends `1000 / perSecond` ms apart, across every kind: the gap is the rate.
export function createSendPacer({
  perSecond,
  now,
  sleep,
}: {
  perSecond: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): () => Promise<void> {
  const gapMs = 1000 / perSecond;
  let nextAt = -Infinity;
  return async () => {
    const at = now();
    if (nextAt > at) await sleep(nextAt - at);
    nextAt = Math.max(at, nextAt) + gapMs;
  };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// a name and a code, never Telegram's description (rule 8)
const lastErrorOf = (error: unknown): string => {
  if (error instanceof GrammyError) return `${error.name}:${error.error_code}`;
  const { name, code } = errorIdentity(error);
  return code === undefined ? name : `${name}:${code}`;
};

export function createMailingEngine(deps: MailingEngineDeps): MailingEngine {
  const { db, push, logger } = deps;
  const config = { ...DEFAULT_MAILING_CONFIG, ...deps.config };
  const now = deps.now ?? Date.now;
  const pace = createSendPacer({
    perSecond: config.perSecond,
    now,
    sleep: deps.sleep ?? defaultSleep,
  });
  let stopped = false;
  let pausedUntil = -Infinity;
  let planning: Promise<void> | undefined;
  let sending: Promise<void> | undefined;
  let planTimer: NodeJS.Timeout | undefined;
  let sendTimer: NodeJS.Timeout | undefined;

  async function runPlanTick(): Promise<void> {
    const planned = await planMailingJobs(db);
    if (Object.values(planned).some((count) => count > 0)) {
      logger.info({ planned }, 'mailing planned');
    }
  }

  // What the send's failure means for the job. A send that ended without Telegram's answer is
  // left as the claim wrote it, `sent` with an unknown outcome: it may have been delivered.
  function outcomeOf(error: unknown): MailingOutcome | undefined {
    if (!(error instanceof GrammyError)) return undefined;
    const lastError = lastErrorOf(error);
    if (error.error_code === 403) return { kind: 'refused', lastError };
    if (error.error_code === 429) {
      return { kind: 'deferred', lastError, afterMs: (error.parameters.retry_after ?? 1) * 1000 };
    }
    return { kind: 'retry', lastError, afterMs: config.retryMs, maxAttempts: config.maxAttempts };
  }

  // Resolves to the pause Telegram asked for, if it did.
  async function deliver(job: ClaimedMailingJob): Promise<number | undefined> {
    let message: ClientPushMessage;
    try {
      message = mailingMessage(job.kind, job.payload);
    } catch (error) {
      logger.error(
        { jobId: job.id, kind: job.kind, ...errorLogFields(error) },
        'mailing not built',
      );
      await settleMailingJob(db, job.id, {
        kind: 'retry',
        lastError: lastErrorOf(error),
        afterMs: config.retryMs,
        maxAttempts: config.maxAttempts,
      });
      return undefined;
    }
    try {
      await push.sendMailing(job.telegramUserId, message);
    } catch (error) {
      // identity only: grammY's HttpError wraps a message with the token in its URL
      logger.warn(
        {
          jobId: job.id,
          kind: job.kind,
          ...errorLogFields(error),
          ...telegramErrorFields(error, 'sendMessage'),
        },
        'mailing not delivered',
      );
      const outcome = outcomeOf(error);
      if (outcome === undefined) return undefined;
      await settleMailingJob(db, job.id, outcome);
      if (outcome.kind === 'refused') {
        await recordTelegramSendFailure({ db, log: logger }, job.telegramUserId, error);
      }
      return outcome.kind === 'deferred' ? outcome.afterMs : undefined;
    }
    await settleMailingJob(db, job.id, { kind: 'delivered' });
    return undefined;
  }

  async function runSendTick(): Promise<void> {
    if (now() < pausedUntil) return;
    let sent = 0;
    let canceled = 0;
    for (let index = 0; index < config.sendBatch; index += 1) {
      await pace();
      // after the pace, so a stop during its sleep claims nothing more
      if (stopped) break;
      const claim = await claimMailingJob(db, { scan: config.claimScan });
      canceled += claim.canceled;
      if (claim.job === undefined) break;
      sent += 1;
      const pauseMs = await deliver(claim.job);
      if (pauseMs !== undefined) {
        pausedUntil = now() + pauseMs;
        logger.warn({ pauseMs }, 'mailing paused: Telegram asked to wait');
        break;
      }
    }
    if (sent > 0 || canceled > 0) logger.info({ sent, canceled }, 'mailing sent');
  }

  // a tick longer than its interval makes the next one a no-op
  function planTick(): Promise<void> {
    if (stopped) return Promise.resolve();
    planning ??= runPlanTick()
      .catch((error: unknown) => logger.error(errorLogFields(error), 'mailing plan tick failed'))
      .finally(() => {
        planning = undefined;
      });
    return planning;
  }

  function sendTick(): Promise<void> {
    if (stopped) return Promise.resolve();
    sending ??= runSendTick()
      .catch((error: unknown) => logger.error(errorLogFields(error), 'mailing send tick failed'))
      .finally(() => {
        sending = undefined;
      });
    return sending;
  }

  return {
    planTick,
    sendTick,
    start() {
      if (stopped || planTimer !== undefined) return;
      planTimer = setInterval(() => void planTick(), config.planTickMs);
      sendTimer = setInterval(() => void sendTick(), config.sendTickMs);
    },
    async stop() {
      stopped = true;
      clearInterval(planTimer);
      clearInterval(sendTimer);
      planTimer = undefined;
      sendTimer = undefined;
      await Promise.allSettled([planning, sending]);
    },
  };
}
