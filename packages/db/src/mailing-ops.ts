import { sql } from 'drizzle-orm';
import { NotificationKind, type BotLanguage, type TradeMode } from '@binarius/shared';
import type { Db } from './client';
import { acceptsMailing, deliverable, reachable } from './delivery-ops';
import {
  IMPORTANT_NOTIFICATION_KINDS,
  MAILING_SCENARIOS,
  type MailingScenario,
} from './mailing-scenarios';
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
    payload = excluded.payload, scheduled_at = excluded.scheduled_at, sent_at = null,
    attempts = 0, last_error = null, updated_at = now()
  where ${notificationJobs.status} = ${literal(NotificationJobStatus.Canceled)}`;

// One INSERT … SELECT per kind, idempotent through notification_jobs_dedupe_key_idx: a second
// planner, a restart or a slow tick inserts nothing twice. A job is planned only once due, for a
// fact at or after the kind's plans_from, to a user the bot may mail (an important kind: reach,
// whatever the level, #686), while the scenario applies.
// Returns how many jobs each kind gained, re-planned ones included.
export async function planMailingJobs(db: Db): Promise<Record<NotificationKind, number>> {
  const planned = {} as Record<NotificationKind, number>;
  for (const kind of KINDS) planned[kind] = await planMailingKind(db, kind);
  return planned;
}

// One kind's statement. `scenario` is the kind's own; a test passes the same scenario built over a
// literal moment (weeklySummaryAt, #124), so a calendar rule is planned at a moment it chooses.
export async function planMailingKind(
  db: Db,
  kind: NotificationKind,
  scenario: MailingScenario = MAILING_SCENARIOS[kind],
): Promise<number> {
  const { facts, afterMs, dedupeKey, stillApplies, replansCanceled, important } = scenario;
  const payload = scenario.payload ?? sql`'{}'::jsonb`;
  const after = sql`make_interval(secs => ${afterMs / 1000})`;
  const result = await db.execute(sql`
    insert into ${notificationJobs} (user_id, kind, dedupe_key, payload, scheduled_at)
    select ${users.id}, ${literal(kind)}, ${dedupeKey}, ${payload}, fact.at + ${after}
    from ${users}
    cross join lateral ${facts} fact
    join ${notificationKinds} on ${notificationKinds.kind} = ${literal(kind)}
    where fact.at >= ${notificationKinds.plansFrom}
      and fact.at + ${after} <= now()
      and ${important === true ? reachable() : deliverable()}
      and ${stillApplies}
    on conflict (user_id, dedupe_key) where dedupe_key is not null
    ${replansCanceled === true ? replanCanceled : sql`do nothing`}`);
  return result.rowCount ?? 0;
}

export interface ClaimedMailingJob {
  id: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  attempts: number;
  telegramUserId: bigint;
  // the user's mode at the claim, for a button whose label follows it (#123)
  tradingMode: TradeMode;
  // the user's language at the claim: every kind is written in it (#686, #633)
  language: BotLanguage;
}

// A job applies while its scenario holds and its key is one the scenario would plan now
// (keyApplies): a newer fact (another analysis) leaves the old key's job stale. coalesce: with the
// fact gone (NULL) the predicate is NULL, and a job neither cancelled nor claimed would stay at
// the head of `due`.
const appliesByKind = sql`case ${notificationJobs.kind} ${sql.join(
  KINDS.map(
    (kind) =>
      sql`when ${literal(kind)} then coalesce(${MAILING_SCENARIOS[kind].stillApplies}
        and ${MAILING_SCENARIOS[kind].keyApplies}, false)`,
  ),
  sql` `,
)} else false end`;

// Whom a job may go to now: an important kind's to a user the bot can reach (#686), any other's to
// a user who accepts mailing (acceptsMailing: the level and the `reduced` window).
const IMPORTANT = sql.join(
  IMPORTANT_NOTIFICATION_KINDS.map((kind) => literal(kind)),
  sql`, `,
);
const acceptsJob =
  IMPORTANT_NOTIFICATION_KINDS.length === 0
    ? acceptsMailing()
    : sql`((${notificationJobs.kind} in (${IMPORTANT}) and ${reachable()})
      or (${notificationJobs.kind} not in (${IMPORTANT}) and ${acceptsMailing()}))`;

// Takes the earliest due job of a user the bot may mail now (acceptsJob) and marks it `sent`
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
    trading_mode: TradeMode | null;
    language: BotLanguage | null;
  }>(sql`
    with due as (
      select ${notificationJobs.id} as id, ${notificationJobs.scheduledAt} as scheduled_at,
        ${appliesByKind} as applies
      from ${notificationJobs}
      join ${users} on ${users.id} = ${notificationJobs.userId}
      where ${notificationJobs.status} = ${literal(NotificationJobStatus.Pending)}
        and ${notificationJobs.scheduledAt} <= now()
        and ${acceptsJob}
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
      claimed.payload, claimed.attempts, ${users.telegramUserId}::text as telegram_user_id,
      ${users.tradingMode} as trading_mode, ${users.language} as language
    from (select 1) one
    left join claimed on true
    left join ${users} on ${users.id} = claimed.user_id`);
  const row = result.rows[0];
  const canceled = row?.canceled ?? 0;
  if (
    row?.id == null ||
    row.kind === null ||
    row.telegram_user_id === null ||
    row.trading_mode === null ||
    row.language === null
  ) {
    return { job: undefined, canceled };
  }
  return {
    job: {
      id: row.id,
      kind: row.kind,
      payload: row.payload ?? {},
      attempts: row.attempts ?? 0,
      telegramUserId: BigInt(row.telegram_user_id),
      tradingMode: row.trading_mode,
      language: row.language,
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
