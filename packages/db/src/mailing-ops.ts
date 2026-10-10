import { sql } from 'drizzle-orm';
import { NotificationKind } from '@binarius/shared';
import type { Db } from './client';
import { acceptsMailing, deliverable } from './delivery-ops';
import { MAILING_SCENARIOS } from './mailing-scenarios';
import { literal } from './schema/columns';
import {
  NotificationJobStatus,
  notificationJobs,
  notificationKinds,
} from './schema/notification-jobs';
import { users } from './schema/users';

// The mailing engine's statements (docs/mailing.md). Each is one autocommit statement on `Db`:
// none holds a lock past its own end, and none locks `users` (the lock order users →
// notification_jobs of cancelPendingNotificationJobs is never taken the other way round).

// Written by the claim and cleared when Telegram accepted the message: a `sent` row that keeps it
// was handed to Telegram with no answer (a transport error, a timeout, a crash). It is never sent
// again — a lost reminder is cheaper than a duplicate.
export const MAILING_OUTCOME_UNKNOWN = 'outcome_unknown';

const KINDS = Object.values(NotificationKind);

// A scenario with replansCanceled takes a canceled job of its key back. Only a canceled one: a
// canceled job never reached Telegram (only pending jobs are canceled, and a pending one was never
// handed over), while a sent or failed one is final and a pending one already waits.
const replanCanceled = sql`do update set status = ${literal(NotificationJobStatus.Pending)},
    scheduled_at = excluded.scheduled_at, sent_at = null, attempts = 0, last_error = null,
    updated_at = now()
  where ${notificationJobs.status} = ${literal(NotificationJobStatus.Canceled)}`;

// One INSERT … SELECT per kind, idempotent through notification_jobs_dedupe_key_idx: a second
// planner, a restart or a slow tick inserts nothing twice. A job is planned only once due, for a
// fact at or after the kind's plans_from, to a user the bot may reach, while the scenario applies.
// Returns how many jobs each kind gained, re-planned ones included.
export async function planMailingJobs(db: Db): Promise<Record<NotificationKind, number>> {
  const planned = {} as Record<NotificationKind, number>;
  for (const kind of KINDS) {
    const { factAt, afterHours, dedupeKey, stillApplies, replansCanceled } =
      MAILING_SCENARIOS[kind];
    const result = await db.execute(sql`
      insert into ${notificationJobs} (user_id, kind, dedupe_key, scheduled_at)
      select ${users.id}, ${literal(kind)}, ${dedupeKey}, fact.at + make_interval(hours => ${afterHours})
      from ${users}
      cross join lateral (select ${factAt} as at) fact
      join ${notificationKinds} on ${notificationKinds.kind} = ${literal(kind)}
      where fact.at >= ${notificationKinds.plansFrom}
        and fact.at + make_interval(hours => ${afterHours}) <= now()
        and ${deliverable()}
        and ${stillApplies}
      on conflict (user_id, dedupe_key) where dedupe_key is not null
      ${replansCanceled ? replanCanceled : sql`do nothing`}`);
    planned[kind] = result.rowCount ?? 0;
  }
  return planned;
}

export interface ClaimedMailingJob {
  id: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  attempts: number;
  telegramUserId: bigint;
}

const appliesByKind = sql`case ${notificationJobs.kind} ${sql.join(
  KINDS.map((kind) => sql`when ${literal(kind)} then ${MAILING_SCENARIOS[kind].stillApplies}`),
  sql` `,
)} else false end`;

// Takes the earliest due job of a user the bot may mail now (acceptsMailing) and marks it `sent`
// with MAILING_OUTCOME_UNKNOWN before anything reaches Telegram, so no restart or second process
// sends it again. Among the `scan` earliest due jobs, those whose scenario no longer applies are
// canceled in the same statement. One job per call: the next claim of the same user sees this
// one's sent_at, which is what the `reduced` window reads.
export async function claimMailingJob(
  db: Db,
  { scan }: { scan: number },
): Promise<{ job: ClaimedMailingJob | undefined; canceled: number }> {
  const result = await db.execute<{
    canceled: number;
    id: string | null;
    kind: NotificationKind | null;
    payload: Record<string, unknown> | null;
    attempts: number | null;
    telegram_user_id: string | null;
  }>(sql`
    with due as (
      select ${notificationJobs.id} as id, ${notificationJobs.scheduledAt} as scheduled_at,
        ${appliesByKind} as applies
      from ${notificationJobs}
      join ${users} on ${users.id} = ${notificationJobs.userId}
      where ${notificationJobs.status} = ${literal(NotificationJobStatus.Pending)}
        and ${notificationJobs.scheduledAt} <= now()
        and ${acceptsMailing()}
      order by ${notificationJobs.scheduledAt}, ${notificationJobs.id}
      limit ${scan}
      for update of ${notificationJobs} skip locked
    ), canceled as (
      update ${notificationJobs}
      set status = ${literal(NotificationJobStatus.Canceled)}, updated_at = now()
      where id in (select id from due where not applies)
      returning id
    ), claimed as (
      update ${notificationJobs}
      set status = ${literal(NotificationJobStatus.Sent)}, sent_at = now(),
        last_error = ${MAILING_OUTCOME_UNKNOWN}, updated_at = now()
      where id = (select id from due where applies order by scheduled_at, id limit 1)
      returning id, user_id, kind, payload, attempts
    )
    select (select count(*)::int from canceled) as canceled, claimed.id, claimed.kind,
      claimed.payload, claimed.attempts, ${users.telegramUserId}::text as telegram_user_id
    from (select 1) one
    left join claimed on true
    left join ${users} on ${users.id} = claimed.user_id`);
  const row = result.rows[0];
  const canceled = row?.canceled ?? 0;
  if (row?.id == null || row.kind === null || row.telegram_user_id === null) {
    return { job: undefined, canceled };
  }
  return {
    job: {
      id: row.id,
      kind: row.kind,
      payload: row.payload ?? {},
      attempts: row.attempts ?? 0,
      telegramUserId: BigInt(row.telegram_user_id),
    },
    canceled,
  };
}

// What became of a claimed job. `lastError` is a name and a code only (rule 8).
export type MailingOutcome =
  // Telegram accepted it
  | { kind: 'delivered' }
  // Telegram refused it for good (403): `failed`, never retried
  | { kind: 'refused'; lastError: string }
  // Telegram asked to wait (429): back to `pending` after `afterMs`, no attempt counted
  | { kind: 'deferred'; lastError: string; afterMs: number }
  // Telegram refused it otherwise, or it could not be built: `pending` after `afterMs`, or
  // `failed` once this attempt reaches maxAttempts
  | { kind: 'retry'; lastError: string; afterMs: number; maxAttempts: number };

// Writes the outcome onto the row the claim marked; a row no longer in that state is left alone.
export async function settleMailingJob(db: Db, id: string, outcome: MailingOutcome): Promise<void> {
  const claimed = sql`${notificationJobs.id} = ${id}
    and ${notificationJobs.status} = ${literal(NotificationJobStatus.Sent)}
    and ${notificationJobs.lastError} = ${MAILING_OUTCOME_UNKNOWN}`;
  const set = (() => {
    switch (outcome.kind) {
      case 'delivered':
        return sql`last_error = null`;
      case 'refused':
        return sql`status = ${literal(NotificationJobStatus.Failed)}, sent_at = null,
          attempts = attempts + 1, last_error = ${outcome.lastError}`;
      case 'deferred':
        return sql`status = ${literal(NotificationJobStatus.Pending)}, sent_at = null,
          last_error = ${outcome.lastError},
          scheduled_at = now() + make_interval(secs => ${outcome.afterMs / 1000})`;
      case 'retry':
        return sql`status = case when attempts + 1 >= ${outcome.maxAttempts}
            then ${literal(NotificationJobStatus.Failed)}
            else ${literal(NotificationJobStatus.Pending)} end,
          sent_at = null, attempts = attempts + 1, last_error = ${outcome.lastError},
          scheduled_at = now() + make_interval(secs => ${outcome.afterMs / 1000})`;
    }
  })();
  await db.execute(sql`update ${notificationJobs} set ${set}, updated_at = now() where ${claimed}`);
}
