import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { errorLogFields, type TradeIntentJobPayload } from '@binarius/shared';
import { OutboxTopic, type TradeIntentRow } from '@binarius/db';
import { withTimeout } from '../broker/session-manager';
import type { FleetRegistry } from '../fleet/registry';
import type { Logger } from './processor';

// Routing an intent to the process that owns its account (#347, docs/trade-intent-transport.md →
// Routing to the owner): a shared job of an account another live process owns is handed to that
// process's own queue once, before the take, so the order goes over the owner's socket. The
// forwarder keeps an insurance job in its own queue: if the owner died with the job, the
// forwarder takes the intent itself after recoveryDelayMs.

// the name of a job requeued to the shared queue at a clean stop: processed where it lands, never
// forwarded, or the survivors would hand it straight back to the stopping process
export const INTENT_DIRECT_JOB = 'intent-direct';

// BullMQ refuses ':' in a queue name, hence the hyphen
export const ownIntentQueueName = (ownerId: string) => `${OutboxTopic.TradingIntents}-${ownerId}`;

// the backend publisher's options (apps/backend/src/outbox/bullmq.ts): the job id is the intent
// id, so a second forward of the same intent adds nothing
const JOB_OPTIONS = { attempts: 1, removeOnComplete: true, removeOnFail: true } as const;

export interface IntentRouterConfig {
  // how long the insurance waits in our own queue (INTENT_RECOVERY_DELAY_MS)
  recoveryDelayMs: number;
  // bounds stop() (INTENT_ROUTER_STOP_BUDGET_MS)
  stopBudgetMs: number;
}

export interface IntentRouter {
  // true when the intent went to its owner's queue; false: process it here. Never rejects
  forward(intent: TradeIntentRow): Promise<boolean>;
  // after our own queue's consumer closed: requeues its jobs to the shared queue as
  // INTENT_DIRECT_JOB, deletes it, closes every queue. Bounded by stopBudgetMs; never rejects
  stop(): Promise<void>;
}

export interface IntentRouterDeps {
  ownerId: string;
  registry: Pick<FleetRegistry, 'ownerOf'>;
  connection: Redis;
  prefix?: string;
  logger: Logger;
  config: IntentRouterConfig;
}

export function createIntentRouter(deps: IntentRouterDeps): IntentRouter {
  const { ownerId, registry, connection, logger, config } = deps;
  const options = deps.prefix === undefined ? { connection } : { connection, prefix: deps.prefix };
  const own = new Queue<TradeIntentJobPayload>(ownIntentQueueName(ownerId), options);
  const shared = new Queue<TradeIntentJobPayload>(OutboxTopic.TradingIntents, options);
  // at most the distinct owners this process has seen: the restarts of its lifetime
  const owners = new Map<string, Queue<TradeIntentJobPayload>>();
  const queueOf = (owner: string) => {
    let queue = owners.get(owner);
    if (queue === undefined) {
      queue = new Queue<TradeIntentJobPayload>(ownIntentQueueName(owner), options);
      owners.set(owner, queue);
    }
    return queue;
  };

  async function requeueAndClose() {
    const left = await own.getJobs(['waiting', 'delayed', 'prioritized']);
    for (const job of left) {
      await shared.add(INTENT_DIRECT_JOB, job.data, { ...JOB_OPTIONS, jobId: job.data.intentId });
    }
    await own.obliterate({ force: true });
    await Promise.all([own, shared, ...owners.values()].map((queue) => queue.close()));
  }

  return {
    async forward(intent) {
      const owner = registry.ownerOf(intent.brokerAccountId);
      if (owner === undefined || owner === ownerId) return false;
      const payload = { intentId: intent.id };
      try {
        await queueOf(owner).add('intent', payload, { ...JOB_OPTIONS, jobId: intent.id });
        await own.add('intent', payload, {
          ...JOB_OPTIONS,
          jobId: intent.id,
          delay: config.recoveryDelayMs,
        });
      } catch (error) {
        // routing is an optimisation: a copy that did land races us on takeIntent's CAS
        logger.warn(
          { ...errorLogFields(error), intentId: intent.id, owner },
          'intent forward failed, processing here',
        );
        return false;
      }
      logger.info(
        { intentId: intent.id, accountId: intent.brokerAccountId, owner },
        'intent forwarded',
      );
      return true;
    },
    async stop() {
      try {
        const result = await withTimeout(requeueAndClose(), config.stopBudgetMs);
        if (result === 'timeout') {
          logger.warn({ timeoutMs: config.stopBudgetMs }, 'intent router stop timed out');
        }
      } catch (error) {
        logger.error(errorLogFields(error), 'intent router stop failed');
      }
    },
  };
}
