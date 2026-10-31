import type { FastifyBaseLogger } from 'fastify';
import { GrammyError } from 'grammy';
import { errorIdentity, errorLogFields, fileRefusal, telegramErrorFields } from '@binarius/shared';
import {
  claimMailingJob,
  planMailingJobs,
  settleMailingJob,
  type ClaimedMailingJob,
  type Db,
  type MailingOutcome,
} from '@binarius/db';
import type { ClientPush } from '../auth/client-push';
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
import { enabledKinds, type HelpLinks } from './help-links';
import { mailingMessage, type MailingMessage, type MailingPhoto } from './messages';
import type { PhotoMedia } from './photo-media';

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

const DEFAULT_MAILING_CONFIG: MailingConfig = {
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
  push: Pick<ClientPush, 'sendMailing' | 'sendMailingPhoto'>;
  logger: FastifyBaseLogger;
  config?: Partial<MailingConfig>;
  // the cashier's Mini App URL for the low-token nudges' «💳 Пополнить» (#123) and the
  // demo-to-real chain's (#880): cashierUrlOf of WEB_PUBLIC_URL, undefined without https, when the
  // chain is neither planned nor claimed (enabledKinds). Required, so no caller leaves it out by
  // accident.
  cashierUrl: string | undefined;
  // the help push's links (#879, docs/mailing.md → The help push): without one the kind is neither
  // planned nor claimed (enabledKinds). Required, as cashierUrl.
  helpLinks: HelpLinks;
  // each mailing picture's file and file_id (#879, photo-media.ts)
  photos: Record<MailingPhoto, PhotoMedia>;
  // the tests' clock and sleep; the engine's own pacing and pause read only these. The clock is
  // monotonic (performance.now by default): a wall-clock step neither stretches nor cuts a gap or
  // Telegram's pause
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // the tests' planner pass, to hold one in flight (#686); planMailingJobs by default
  plan?: typeof planMailingJobs;
}

export interface MailingEngine {
  planTick(): Promise<void>;
  // After a commit whose fact a scenario plans at once (#686): a pass now, or one more right
  // after the pass in flight, which may have read past the commit. Wakes merge; no-op after stop().
  wakePlan(): void;
  sendTick(): Promise<void>;
  start(): void;
  // Ends both loops and waits for the planner tick and the sender's job in flight: at most one
  // send, with its pace, claim, settle and 403 bookkeeping (docs/mailing.md → Stop).
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

// What Telegram's answer to a failed send means, for the mailing engine and the session notices
// (#620): refused for good to this user (403), asked to wait (429, not delivered), refused this
// call (another 4xx, not delivered), or unknown (5xx, a timeout, the transport: it may have been
// delivered).
export type SendFailure =
  { kind: 'forbidden' } | { kind: 'wait'; ms: number } | { kind: 'refused' } | { kind: 'unknown' };

export function sendFailureOf(error: unknown): SendFailure {
  if (!(error instanceof GrammyError) || error.error_code >= 500) return { kind: 'unknown' };
  if (error.error_code === 403) return { kind: 'forbidden' };
  if (error.error_code === 429) {
    return { kind: 'wait', ms: (error.parameters.retry_after ?? 1) * 1000 };
  }
  return { kind: 'refused' };
}

export function createMailingEngine(deps: MailingEngineDeps): MailingEngine {
  const { db, push, logger } = deps;
  const config = { ...DEFAULT_MAILING_CONFIG, ...deps.config };
  const now = deps.now ?? (() => performance.now());
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
  const plan = deps.plan ?? planMailingJobs;
  // a constant of the process: the env is read once at start
  const kinds = enabledKinds({ helpLinks: deps.helpLinks, cashierUrl: deps.cashierUrl });
  let planWoken = 0;

  async function runPlanTick(): Promise<void> {
    // before the first await: a wakePlan() after this line is served by the next pass
    planWoken = 0;
    const planned = await plan(db, { kinds });
    if (Object.values(planned).some((count) => count > 0)) {
      logger.info({ planned }, 'mailing planned');
    }
  }

  const retryOutcome = (error: unknown): MailingOutcome => ({
    kind: 'retry',
    lastError: lastErrorOf(error),
    afterMs: config.retryMs,
    maxAttempts: config.maxAttempts,
  });

  // What the send's failure means for the job. A send that ended without Telegram's answer is
  // left as the claim wrote it, `sent` with an unknown outcome: it may have been delivered. A 5xx
  // is the same: Telegram may have delivered the message before it failed to answer.
  function outcomeOf(error: unknown): MailingOutcome | undefined {
    const failure = sendFailureOf(error);
    switch (failure.kind) {
      case 'unknown':
        return undefined;
      case 'forbidden':
        return { kind: 'refused', lastError: lastErrorOf(error) };
      case 'wait':
        return { kind: 'deferred', lastError: lastErrorOf(error), afterMs: failure.ms };
      case 'refused':
        return retryOutcome(error);
    }
  }

  // A settle that fails leaves the job as the claim wrote it, `sent` with an unknown outcome, so
  // it is never sent again; what the answer asks of the sender (the pause, the 403 mark) still
  // happens.
  async function settle(job: ClaimedMailingJob, outcome: MailingOutcome): Promise<void> {
    try {
      await settleMailingJob(db, job.id, outcome);
    } catch (error) {
      logger.error(
        { jobId: job.id, kind: job.kind, ...errorLogFields(error) },
        'mailing not settled',
      );
    }
  }

  // Sends the message by its shape: a picture's by its file_id once one is known, else the file;
  // a refused file forgets its id, so the retry uploads it again (docs/mailing.md → The sender).
  async function send(job: ClaimedMailingJob, message: MailingMessage): Promise<void> {
    if (!('photo' in message)) {
      await push.sendMailing(job.telegramUserId, message);
      return;
    }
    const media = deps.photos[message.photo];
    let sent;
    try {
      sent = await push.sendMailingPhoto(job.telegramUserId, {
        photo: media.photo(),
        caption: message.caption,
        reply_markup: message.reply_markup,
      });
    } catch (error) {
      if (error instanceof GrammyError && fileRefusal(error)) media.forget();
      throw error;
    }
    media.remember(sent);
  }

  // Resolves to what became of the job; undefined when Telegram's answer is unknown.
  async function deliver(job: ClaimedMailingJob): Promise<MailingOutcome | undefined> {
    let message: MailingMessage;
    try {
      message = mailingMessage(job.kind, job.payload, {
        cashierUrl: deps.cashierUrl,
        helpLinks: deps.helpLinks,
        tradingMode: job.tradingMode,
        language: job.language,
      });
    } catch (error) {
      logger.error(
        { jobId: job.id, kind: job.kind, ...errorLogFields(error) },
        'mailing not built',
      );
      const outcome = retryOutcome(error);
      await settle(job, outcome);
      return outcome;
    }
    try {
      await send(job, message);
    } catch (error) {
      // identity only: grammY's HttpError wraps a message with the token in its URL
      logger.warn(
        {
          jobId: job.id,
          kind: job.kind,
          ...errorLogFields(error),
          ...telegramErrorFields(error, 'photo' in message ? 'sendPhoto' : 'sendMessage'),
        },
        'mailing not delivered',
      );
      const outcome = outcomeOf(error);
      if (outcome === undefined) return undefined;
      await settle(job, outcome);
      if (outcome.kind === 'refused') {
        await recordTelegramSendFailure({ db, log: logger }, job.telegramUserId, error);
      }
      return outcome;
    }
    const delivered: MailingOutcome = { kind: 'delivered' };
    await settle(job, delivered);
    return delivered;
  }

  async function runSendTick(): Promise<void> {
    if (now() < pausedUntil) return;
    const counts = { delivered: 0, refused: 0, deferred: 0, retry: 0, unknown: 0, canceled: 0 };
    for (let index = 0; index < config.sendBatch; index += 1) {
      await pace();
      // after the pace, so a stop during its sleep claims nothing more
      if (stopped) break;
      const claim = await claimMailingJob(db, { scan: config.claimScan, kinds });
      counts.canceled += claim.canceled;
      if (claim.job === undefined) break;
      const outcome = await deliver(claim.job);
      counts[outcome?.kind ?? 'unknown'] += 1;
      if (outcome?.kind === 'deferred') {
        const pauseMs = outcome.afterMs;
        pausedUntil = now() + pauseMs;
        logger.warn({ pauseMs }, 'mailing paused: Telegram asked to wait');
        break;
      }
    }
    // what Telegram answered for each claimed job; only `delivered` reached a user for certain
    if (Object.values(counts).some((count) => count > 0)) logger.info(counts, 'mailing tick');
  }

  // a tick longer than its interval makes the next one a no-op
  function planTick(): Promise<void> {
    if (stopped) return Promise.resolve();
    planning ??= runPlanTick()
      .catch((error: unknown) => logger.error(errorLogFields(error), 'mailing plan tick failed'))
      .finally(() => {
        planning = undefined;
        // through planTick, so a stop() during the pass ends the wakes too
        if (planWoken > 0) void planTick();
      });
    return planning;
  }

  function wakePlan(): void {
    if (stopped) return;
    planWoken += 1;
    if (planning === undefined) void planTick();
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
    wakePlan,
    sendTick,
    // the planner's first tick at start() (#874, Rule 65); the sender's on its short interval
    start() {
      if (stopped || planTimer !== undefined) return;
      planTimer = setInterval(() => void planTick(), config.planTickMs);
      sendTimer = setInterval(() => void sendTick(), config.sendTickMs);
      void planTick();
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
