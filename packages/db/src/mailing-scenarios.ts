import { sql, type Column, type SQL } from 'drizzle-orm';
import {
  ANALYSIS_UNUSED_AFTER_MS,
  ANALYSIS_UNUSED_UNTIL_MS,
  BonusRuleKind,
  BrokerAccountStatus,
  DEMO_TO_REAL_CHAIN,
  DEMO_TO_REAL_SESSIONS,
  demoToRealPayloadSchema,
  DepositModeSwitch,
  FIRST_SESSION_CHAIN,
  HELP_LINKS_AFTER_MS,
  INACTIVE_AFTER_MS,
  INACTIVE_REPEAT_DAYS,
  NotificationKind,
  REAL_MODE_BY_DEPOSIT_AFTER_MS,
  realModeByDepositPayloadSchema,
  REFERRAL_REWARDED_AFTER_MS,
  SESSION_IDLE_AFTER_MS,
  TOKEN_NUDGE_AFTER_MS,
  TOKEN_NUDGES,
  TokenLedgerKind,
  TOKENS_OUT_REPEAT_AFTER_MS,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  UserStatus,
  WEEKLY_SUMMARY_HOUR_UTC,
  weeklySummaryPayloadSchema,
} from '@binarius/shared';
import { activeRuleWhere, DEPOSIT_BONUS_RULE_CODE } from './bonus-rule-ops';
import { literal } from './schema/columns';
import { bonusRules } from './schema/bonus-rules';
import { brokerAccounts } from './schema/broker-accounts';
import { brokerBalanceSnapshots } from './schema/broker-balance-snapshots';
import { brokerTrades } from './schema/broker-trades';
import { depositEvents } from './schema/deposit-events';
import {
  NotificationJobStatus,
  notificationJobs,
  notificationKinds,
} from './schema/notification-jobs';
import { tokenLedger } from './schema/token-ledger';
import { tradeIntents } from './schema/trade-intents';
import { tradingSessions } from './schema/trading-sessions';
import { users } from './schema/users';
import { tradingOpenSql } from './trading-switch-ops';

// What the planner and the sender know about a kind (docs/mailing.md). Every SQL fragment reads
// the outer `users` row and locks nothing.
export interface MailingScenario {
  // the user's facts the kind counts from: a lateral subquery over `users` with a column `at`
  // (the fact's moment; no row, or a NULL `at`, plans nothing) and whatever dedupeKey and payload
  // read as fact.<column>
  facts: SQL;
  afterMs: number;
  // over `users` and `fact`: one job per user per key (notification_jobs_dedupe_key_idx), so
  // planning is idempotent
  dedupeKey: SQL;
  // over `users` and `fact`: the job's payload (jsonb), what the message is built from; '{}' when
  // absent
  payload?: SQL;
  // over `users` only: checked when planning and again when the sender claims; false at the claim
  // cancels the job
  stillApplies: SQL;
  // at the claim, over `users` and `notification_jobs`: the job's key is one the scenario would
  // plan now, so a job whose fact was replaced (a newer analysis) is cancelled
  keyApplies: SQL;
  // the planner turns a canceled job of the key back to pending, with the new payload, once the
  // scenario applies again; without it a canceled job keeps its key and the kind is never planned
  // again for the user
  replansCanceled?: boolean;
  // An important kind (#686) is planned and claimed for any notification_level, while the bot can
  // reach the user (reachable(), not deliverable()); its `sent` rows do not count in the `reduced`
  // window, and setNotificationLevel('off') does not cancel its jobs. markTelegramBlocked does.
  important?: true;
}

// A kind with at most one fact per user: its key reads `users` only, so the claim compares it
// directly.
const oneFact = ({
  factAt,
  dedupeKey,
  ...rest
}: {
  factAt: SQL;
  afterMs: number;
  dedupeKey: SQL;
  payload?: SQL;
  stillApplies: SQL;
  replansCanceled?: boolean;
}): MailingScenario => ({
  facts: sql`(select ${factAt} as at)`,
  dedupeKey,
  keyApplies: sql`${notificationJobs.dedupeKey} = ${dedupeKey}`,
  ...rest,
});

// A column of the user's starter pack: the ledger row written in the activation transaction
// (grantLinkBonus). The predicate is token_ledger_link_bonus_user_idx's, so there is at most one
// row; an account connected with no active link_bonus rule has none, and so no chain and no
// low-token nudge (#13, #123).
const starterPack = (column: Column) =>
  sql`(select ${column} from ${tokenLedger}
  where ${tokenLedger.userId} = ${users.id}
    and ${tokenLedger.kind} = ${literal(TokenLedgerKind.Bonus)}
    and ${tokenLedger.brokerAccountId} is not null)`;

// The moment the account was connected.
const linkedAt = starterPack(tokenLedger.createdAt);

// The user can still act on the button: not blocked by the admin, an active account, and no
// trading session of any status on any of their accounts (owner, 2026-10-07: the chain leads to
// the first session, so any session ends it), and the user trades demo: the chain leads into the
// demo, so a user in real mode gets none, and a step planned before the switch is cancelled at the
// claim (#121).
const beforeFirstSession = sql`(${users.status} = ${literal(UserStatus.Active)}
  and ${users.tradingMode} = ${literal(TradeMode.Demo)}
  and exists (select 1 from ${brokerAccounts}
    where ${brokerAccounts.userId} = ${users.id}
      and ${brokerAccounts.status} = ${literal(BrokerAccountStatus.Active)})
  and not exists (select 1 from ${tradingSessions}
    join ${brokerAccounts} on ${brokerAccounts.id} = ${tradingSessions.brokerAccountId}
    where ${brokerAccounts.userId} = ${users.id}))`;

// A step is stale once the next one is due: after a backend outage the user gets the latest step,
// not the backlog of them one after another.
const firstSessionStep = (kind: NotificationKind): MailingScenario => {
  const index = FIRST_SESSION_CHAIN.findIndex((step) => step.kind === kind);
  const step = FIRST_SESSION_CHAIN[index];
  if (step === undefined) throw new Error(`${kind} is not a step of FIRST_SESSION_CHAIN`);
  const next = FIRST_SESSION_CHAIN[index + 1];
  return oneFact({
    factAt: linkedAt,
    afterMs: step.afterHours * 3_600_000,
    dedupeKey: sql`${`first_session:${String(step.afterHours)}h`}`,
    stillApplies:
      next === undefined
        ? beforeFirstSession
        : sql`(${beforeFirstSession} and ${linkedAt} + make_interval(hours => ${next.afterHours}) > now())`,
  });
};

const lastAnalysisAt = sql`${users.lastAnalysisAt}`;

// The analysis reminder (#484, docs/mailing.md → The analysis reminder): the user, not blocked by
// the admin and trading demo, has created no trade and started no session since the analysis, runs
// no session now, and the reminder's window has not closed. Another analysis is a new fact and so a
// new key: the job of the previous one is cancelled at the claim by the key, not here.
const analysisUnused = sql`(${users.status} = ${literal(UserStatus.Active)}
  and ${users.tradingMode} = ${literal(TradeMode.Demo)}
  and now() < ${lastAnalysisAt} + make_interval(secs => ${ANALYSIS_UNUSED_UNTIL_MS / 1000})
  and not exists (select 1 from ${tradeIntents}
    where ${tradeIntents.userId} = ${users.id}
      and ${tradeIntents.createdAt} > ${lastAnalysisAt})
  and not exists (select 1 from ${tradingSessions}
    join ${brokerAccounts} on ${brokerAccounts.id} = ${tradingSessions.brokerAccountId}
    where ${brokerAccounts.userId} = ${users.id}
      and (${tradingSessions.startedAt} > ${lastAnalysisAt}
        or ${tradingSessions.status} <> ${literal(TradingSessionStatus.Stopped)})))`;

// The inviter's rewards (#116): one row per reward of the user, each its own job (#576,
// docs/mailing.md → The referral reward notification). The key names the ledger row, the payload
// carries its tokens as text (a bigint, rule 2). token_ledger is append-only, so a reward never
// goes away; the claim re-checks only the admin block and that the key names a reward of this user.
const rewardRows = sql`(select ${tokenLedger.createdAt} as at, ${tokenLedger.id} as reward_id,
    ${tokenLedger.balanceDelta}::text as tokens
  from ${tokenLedger}
  where ${tokenLedger.userId} = ${users.id} and ${tokenLedger.referralId} is not null)`;

// The pack's tokens: the rule version's amount when the account was connected, positive
// (token_ledger_kind_check) and never changed (append-only, rule 3).
const packTokens = starterPack(tokenLedger.balanceDelta);

// The threshold's share of the pack, inlined as integers: bigint arithmetic, no JS number (rule 2).
const leftPercent = (usedPercent: number) => sql.raw(String(100 - usedPercent));

// The cached balance (rule 2) is at or under the threshold's share of the user's own pack. No
// pack: NULL, which plans nothing and cancels at the claim.
const tokensReached = (usedPercent: number) =>
  sql`${users.tokenBalance} * 100 <= ${packTokens} * ${leftPercent(usedPercent)}`;

// The low-token nudge (#123, docs/mailing.md → The low-token nudge). A kind's band ends where the
// next threshold's begins, and a kind does not apply while a higher one has a job that is not
// canceled, so a user who passes several thresholds at once gets the highest only, and none lower
// afterwards. The fact is the planning moment, so plans_from only switches the kinds on. A canceled
// job is planned again once the balance is back in its band. trading_mode is not read: tokens are
// spent in both modes.
const tokenNudge = (kind: NotificationKind): MailingScenario => {
  const index = TOKEN_NUDGES.findIndex((nudge) => nudge.kind === kind);
  const nudge = TOKEN_NUDGES[index];
  if (nudge === undefined) throw new Error(`${kind} is not one of TOKEN_NUDGES`);
  const higher = TOKEN_NUDGES.slice(index + 1);
  const next = higher[0];
  return oneFact({
    factAt: sql`now()`,
    afterMs: TOKEN_NUDGE_AFTER_MS,
    dedupeKey: sql`${`tokens:${String(nudge.usedPercent)}`}`,
    // bigint division: the floor, the same boundary as tokensReached's
    payload: sql`jsonb_build_object('tokens',
      (${packTokens} * ${leftPercent(nudge.usedPercent)} / 100)::text)`,
    stillApplies: sql`(${users.status} = ${literal(UserStatus.Active)}
      and ${tokensReached(nudge.usedPercent)}${
        next === undefined
          ? sql``
          : sql`
      and not (${tokensReached(next.usedPercent)})
      and not exists (select 1 from ${notificationJobs} higher
        where higher.user_id = ${users.id}
          and higher.status <> ${literal(NotificationJobStatus.Canceled)}
          and higher.kind in (${sql.join(
            higher.map((h) => literal(h.kind)),
            sql`, `,
          )}))`
      })`,
    replansCanceled: true,
  });
};

// The deposits that switched the user to real (#686, docs/mailing.md → The real-mode notification):
// one row per deposit, each its own job; the fact's moment is the switch's (mode_switch_at).
// deposit_events' outcome is written once (markDepositModeSwitch), so a switched row stays one.
const switchedDeposits = sql`(select ${depositEvents.modeSwitchAt} as at,
    ${depositEvents.id} as deposit_id, ${depositEvents.brokerAccountId} as broker_account_id
  from ${depositEvents}
  where ${depositEvents.userId} = ${users.id}
    and ${depositEvents.modeSwitch} = ${literal(DepositModeSwitch.Switched)})`;

// the payload's key as its schema names it, so the message's parse and this SQL cannot drift apart
const STAKE_KEY = literal(realModeByDepositPayloadSchema.keyof().enum.stake);

// ---- Retention (#124, docs/mailing.md → Retention) ---------------------------------------------
// A job exists only once it is due (planMailingJobs), so each kind's staleness lives in its key
// and its stillApplies, never in a job planned ahead.

// Scenarios 1-2 (manager 2026-10-23, answer 3 (a)): the user is not blocked by the admin, trades
// demo, has an active account, and trading is open (rule 22: no «trade again» push while the switch
// is closed). A job planned before a switch to real is cancelled at the claim.
const commonRetention = sql`(${users.status} = ${literal(UserStatus.Active)}
  and ${users.tradingMode} = ${literal(TradeMode.Demo)}
  and exists (select 1 from ${brokerAccounts}
    where ${brokerAccounts.userId} = ${users.id}
      and ${brokerAccounts.status} = ${literal(BrokerAccountStatus.Active)})
  and ${tradingOpenSql})`;

// The user's last activity, an approximation (docs/mailing.md → Retention): the newest session
// start or end and trade on any of their accounts, the newest balance request of those accounts
// (the bot's menu and trading screens, a session's ticks) and the last analysis. greatest() skips
// NULLs. The end counts so that inactive_3d (72 h after it) is never due before session_idle_24h
// (24 h after it), even for a session stopped long after its last tick (#124 round 2).
const lastActivityAt = sql`greatest(
    (select max(greatest(${tradingSessions.startedAt}, ${tradingSessions.endedAt})) from ${tradingSessions}
      join ${brokerAccounts} on ${brokerAccounts.id} = ${tradingSessions.brokerAccountId}
      where ${brokerAccounts.userId} = ${users.id}),
    (select max(${tradeIntents.createdAt}) from ${tradeIntents}
      where ${tradeIntents.userId} = ${users.id}),
    (select max(${brokerBalanceSnapshots.lastRequestedAt}) from ${brokerBalanceSnapshots}
      join ${brokerAccounts} on ${brokerAccounts.id} = ${brokerBalanceSnapshots.brokerAccountId}
      where ${brokerAccounts.userId} = ${users.id}),
    ${users.lastAnalysisAt})`;

// The user's newest session, by start: the fact of session_idle_24h at planning and its key at the
// claim, one fragment for both.
const newestSessionFrom = sql`from ${tradingSessions}
  join ${brokerAccounts} on ${brokerAccounts.id} = ${tradingSessions.brokerAccountId}
  where ${brokerAccounts.userId} = ${users.id}
  order by ${tradingSessions.startedAt} desc, ${tradingSessions.id} desc
  limit 1`;

// The settled trades of a scope and their split by the sign of the profit, as the session's own
// view counts them (trading-session-ops.ts → the session's counts), and the profits' sum, numeric
// (rule 2): a payload takes the columns it names, so a scenario without money reads no sum.
const settledScore = (scope: SQL) => sql`(select count(*)::int as settled,
    count(*) filter (where ${brokerTrades.profit} > 0)::int as won,
    count(*) filter (where ${brokerTrades.profit} < 0)::int as lost,
    count(*) filter (where ${brokerTrades.profit} = 0)::int as tied,
    coalesce(sum(${brokerTrades.profit}), 0) as profit
  from ${tradeIntents}
  left join ${brokerTrades} on ${brokerTrades.intentId} = ${tradeIntents.id}
  where ${scope}
    and ${tradeIntents.status} = ${literal(TradeIntentStatus.Settled)})`;

// the counts as jsonb_build_object's arguments, read from `alias`; the keys as the payload's schema
// names them, so the message's parse and this SQL cannot drift apart
const scorePayload = (alias: string) =>
  sql.join(
    weeklySummaryPayloadSchema
      .keyof()
      .options.map((key) => sql`${literal(key)}, ${sql.raw(alias)}.${sql.identifier(key)}`),
    sql`, `,
  );

// The weekly summary's week, spelled in UTC so the session's TimeZone does not move it: the anchor
// is the latest passed Monday WEEKLY_SUMMARY_HOUR_UTC:00 UTC (a timestamp without time zone, in
// UTC), the summarised week the ISO week before that Monday. Builders over `now`, so a test can pass
// a literal moment.
const SUMMARY_HOUR = sql`make_interval(hours => ${WEEKLY_SUMMARY_HOUR_UTC})`;
export const weeklyAnchor = (now: SQL) =>
  sql`(date_trunc('week', (${now}) at time zone 'UTC' - ${SUMMARY_HOUR}) + ${SUMMARY_HOUR})`;
const weekStart = (now: SQL) => sql`(${weeklyAnchor(now)} - ${SUMMARY_HOUR} - interval '7 days')`;
const weekEnd = (now: SQL) => sql`(${weeklyAnchor(now)} - ${SUMMARY_HOUR})`;
// `column` (a timestamptz) lies in the summarised week
export const weeklyRange = (now: SQL, column: SQL | Column) =>
  sql`(${column} >= ${weekStart(now)} at time zone 'UTC'
    and ${column} < ${weekEnd(now)} at time zone 'UTC')`;
export const weeklyKey = (now: SQL) =>
  sql`('weekly_summary:' || to_char(${weekStart(now)}, 'IYYY-"W"IW'))`;
// the summarised week is still the ISO week before `now`'s: false from the next Monday 00:00 UTC
// until the anchor moves at 10:00, when it is the week before last (#124 round 2, m4)
export const weeklyTimely = (now: SQL) =>
  sql`((${now}) at time zone 'UTC' < ${weekEnd(now)} + interval '7 days')`;

// Scenario 3 (#124) over a moment, so a test can plan and claim at a literal one: the previous ISO
// week's settled demo trades on any of the user's accounts, as the planning saw them; no settled
// trade, no fact. From the next Monday 00:00 UTC the week is no longer the previous one: nothing is
// planned until the anchor moves, and a job still pending is cancelled at the claim.
export const weeklySummaryAt = (now: SQL): MailingScenario => ({
  facts: sql`(select ${weeklyAnchor(now)} at time zone 'UTC' as at, week.*
    from ${settledScore(sql`${tradeIntents.userId} = ${users.id}
      and ${tradeIntents.mode} = ${literal(TradeMode.Demo)}
      and ${weeklyRange(now, tradeIntents.createdAt)}`)} week
    where week.settled > 0 and ${weeklyTimely(now)})`,
  afterMs: 0,
  dedupeKey: weeklyKey(now),
  payload: sql`jsonb_build_object(${scorePayload('fact')})`,
  stillApplies: sql`(${users.status} = ${literal(UserStatus.Active)}
    and ${users.tradingMode} = ${literal(TradeMode.Demo)})`,
  keyApplies: sql`(${notificationJobs.dedupeKey} = ${weeklyKey(now)} and ${weeklyTimely(now)})`,
});

// The moment the user's tokens_out was sent (#123): at most one row, the key tokens:100 being
// constant; max() keeps the subquery scalar whatever matches. The fact of tokens_out_2d and the
// start of its no-change window, one fragment for both.
const tokensOutSentAt = sql`(select max(sent_out.sent_at) from ${notificationJobs} sent_out
  where sent_out.user_id = ${users.id}
    and sent_out.kind = ${literal(NotificationKind.TokensOut)}
    and sent_out.status = ${literal(NotificationJobStatus.Sent)})`;

// Scenario 2 (#124): the newest session stopped (ended_at is set exactly when it is stopped,
// trading_sessions_ended_at_pair_check) and none started since; a newer session is a new key.
// The payload: the pair and duration from the settings when they are numbers, and the score.
// The fact is the newest session's ended_at when it is a demo one (#124 round 1): a real one,
// left by a switch to demo mid-session, has no fact and still counts as a session since.
const sessionIdle24h: MailingScenario = {
  facts: sql`(select case when ${tradingSessions.mode} = ${literal(TradeMode.Demo)}
        then ${tradingSessions.endedAt} end as at, ${tradingSessions.id} as session_id,
      ${tradingSessions.settings} as settings
    ${newestSessionFrom})`,
  afterMs: SESSION_IDLE_AFTER_MS,
  dedupeKey: sql`('session_idle:' || fact.session_id::text)`,
  payload: sql`(select jsonb_build_object(
      'assetId', case when jsonb_typeof(fact.settings->'assetId') = 'number'
        then fact.settings->'assetId' end,
      'durationSec', case when jsonb_typeof(fact.settings->'durationSec') = 'number'
        then fact.settings->'durationSec' end,
      ${scorePayload('score')})
    from ${settledScore(sql`${tradeIntents.tradingSessionId} = fact.session_id`)} score)`,
  stillApplies: commonRetention,
  keyApplies: sql`${notificationJobs.dedupeKey} = 'session_idle:' || (select ${tradingSessions.id}
    ${newestSessionFrom})::text`,
};

// Scenario 4 (#124, manager 2026-10-23, answer 1 (a)): TOKENS_OUT_REPEAT_AFTER after the sent
// tokens_out, once per user, while the balance has not moved since. `<> 0`, not `> 0`: at 0
// nothing lowers the balance, so a row after the send is a credit or the spend of a credit that
// straddled the claim (docs/mailing.md → Retention). Any refill closes it for good: no
// replansCanceled, and the key is constant. trading_mode is not read, as for tokens_out.
const tokensOut2d = oneFact({
  factAt: tokensOutSentAt,
  afterMs: TOKENS_OUT_REPEAT_AFTER_MS,
  dedupeKey: sql`${'tokens_out_2d'}`,
  stillApplies: sql`(${users.status} = ${literal(UserStatus.Active)}
    and ${users.tokenBalance} = 0
    and not exists (select 1 from ${tokenLedger}
      where ${tokenLedger.userId} = ${users.id}
        and ${tokenLedger.balanceDelta} <> 0
        and ${tokenLedger.createdAt} > ${tokensOutSentAt}))`,
});

// The specific retention kinds inactive_3d gives way to (manager 2026-10-23, round 2, answer 1 (a)):
// one push per inactivity spell. A kind holds inactive_3d while it has a pending job, a job sent
// after the last activity, or a fact the planner will plan once due (after its cutoff, applying, no
// job of its key yet). All of it is read in the one statement that plans or claims, so neither the
// claim's scan nor the planner's kind order matters.
const comingSpecific = (kind: NotificationKind, scenario: MailingScenario) =>
  sql`exists (select 1 from ${scenario.facts} fact
    join ${notificationKinds} coming_kind on coming_kind.kind = ${literal(kind)}
    where fact.at >= coming_kind.plans_from
      and ${scenario.stillApplies}
      and not exists (select 1 from ${notificationJobs} planned
        where planned.user_id = ${users.id} and planned.dedupe_key = ${scenario.dedupeKey}))`;
const specificHolds = sql`(exists (select 1 from ${notificationJobs} specific
    where specific.user_id = ${users.id}
      and specific.kind in (${literal(NotificationKind.SessionIdle24h)}, ${literal(NotificationKind.TokensOut2d)})
      and (specific.status = ${literal(NotificationJobStatus.Pending)}
        or (specific.status = ${literal(NotificationJobStatus.Sent)}
          and specific.sent_at > ${lastActivityAt})))
  or ${comingSpecific(NotificationKind.SessionIdle24h, sessionIdle24h)}
  or ${comingSpecific(NotificationKind.TokensOut2d, tokensOut2d)})`;

// ---- The demo-to-real chain (#880, docs/mailing.md → The demo-to-real chain) ------------------

// The user's stopped demo sessions on any of their accounts (status stopped exactly when ended_at
// is set, trading_sessions_ended_at_pair_check).
const stoppedDemoSessionsFrom = sql`from ${tradingSessions}
  join ${brokerAccounts} on ${brokerAccounts.id} = ${tradingSessions.brokerAccountId}
  where ${brokerAccounts.userId} = ${users.id}
    and ${tradingSessions.mode} = ${literal(TradeMode.Demo)}
    and ${tradingSessions.status} = ${literal(TradingSessionStatus.Stopped)}`;

// The end of the user's n-th stopped demo session, oldest end first; NULL with fewer. A fixed
// point: later sessions do not move it, so the offsets and the cutoff count from it.
const nthDemoSessionEndedAt = (n: number) => sql`(select ${tradingSessions.endedAt}
  ${stoppedDemoSessionsFrom}
  order by ${tradingSessions.endedAt} asc, ${tradingSessions.id} asc
  offset ${sql.raw(String(n - 1))} limit 1)`;
const demoToRealAt = nthDemoSessionEndedAt(DEMO_TO_REAL_SESSIONS);

// The params of the deposit_bonus version in force, NULL when none is. A version of another kind
// under the code is no bonus here (the grant refuses it as InvalidBonusRule).
const activeDepositBonusParams = sql`(select ${bonusRules.params} from ${bonusRules}
  where ${activeRuleWhere(DEPOSIT_BONUS_RULE_CODE)}
    and ${bonusRules.kind} = ${literal(BonusRuleKind.DepositBonus)})`;

// the payload's keys as its schema names them, so the message's parse and this SQL cannot drift
const DEMO_TO_REAL_KEY = demoToRealPayloadSchema.keyof().enum;

// The user's facts as the planning sees them: the stopped demo sessions, the settled demo trades
// of every account (single and session ones, as the weekly summary counts them) with their summed
// profit as text (rule 2), and the bonus terms.
const demoToRealPayload = sql`(select jsonb_build_object(
    ${literal(DEMO_TO_REAL_KEY.sessions)}, (select count(*)::int ${stoppedDemoSessionsFrom}),
    ${scorePayload('score')},
    ${literal(DEMO_TO_REAL_KEY.profit)}, score.profit::text,
    ${literal(DEMO_TO_REAL_KEY.bonus)}, ${activeDepositBonusParams})
  from ${settledScore(sql`${tradeIntents.userId} = ${users.id}
    and ${tradeIntents.mode} = ${literal(TradeMode.Demo)}`)} score)`;

// The user is not blocked by the admin, has an active account and no deposit at all (a
// deposit_events row of any status attributed to them), and trading is open (rule 22). The
// trading mode is not read: the chain is about the deposit.
const demoToRealApplies = sql`(${users.status} = ${literal(UserStatus.Active)}
  and exists (select 1 from ${brokerAccounts}
    where ${brokerAccounts.userId} = ${users.id}
      and ${brokerAccounts.status} = ${literal(BrokerAccountStatus.Active)})
  and not exists (select 1 from ${depositEvents} where ${depositEvents.userId} = ${users.id})
  and ${tradingOpenSql})`;

// One chain per user (constant keys); a step is stale once the next one is due, as
// firstSessionStep's.
const demoToRealStep = (kind: NotificationKind): MailingScenario => {
  const index = DEMO_TO_REAL_CHAIN.findIndex((step) => step.kind === kind);
  const step = DEMO_TO_REAL_CHAIN[index];
  if (step === undefined) throw new Error(`${kind} is not a step of DEMO_TO_REAL_CHAIN`);
  const next = DEMO_TO_REAL_CHAIN[index + 1];
  return oneFact({
    factAt: demoToRealAt,
    afterMs: step.afterHours * 3_600_000,
    dedupeKey: sql`${`demo_to_real:${String(step.afterHours)}h`}`,
    payload: demoToRealPayload,
    stillApplies:
      next === undefined
        ? demoToRealApplies
        : sql`(${demoToRealApplies} and ${demoToRealAt} + make_interval(hours => ${next.afterHours}) > now())`,
  });
};

// One entry per kind: a kind added to NotificationKind without a scenario does not compile.
export const MAILING_SCENARIOS = {
  [NotificationKind.FirstSession1h]: firstSessionStep(NotificationKind.FirstSession1h),
  [NotificationKind.FirstSession24h]: firstSessionStep(NotificationKind.FirstSession24h),
  [NotificationKind.FirstSession72h]: firstSessionStep(NotificationKind.FirstSession72h),
  [NotificationKind.AnalysisUnused]: oneFact({
    factAt: lastAnalysisAt,
    afterMs: ANALYSIS_UNUSED_AFTER_MS,
    // the analysis' own moment, microseconds and UTC whatever the session's TimeZone
    dedupeKey: sql`('analysis_unused:' || extract(epoch from ${users.lastAnalysisAt})::text)`,
    payload: sql`jsonb_build_object('assetId', ${users.lastAnalysisAssetId},
      'durationSec', ${users.lastAnalysisDurationSec})`,
    stillApplies: analysisUnused,
  }),
  [NotificationKind.ReferralRewarded]: {
    facts: rewardRows,
    afterMs: REFERRAL_REWARDED_AFTER_MS,
    dedupeKey: sql`('referral_rewarded:' || fact.reward_id::text)`,
    payload: sql`jsonb_build_object('tokens', fact.tokens)`,
    stillApplies: sql`(${users.status} = ${literal(UserStatus.Active)})`,
    keyApplies: sql`exists (select 1 from ${tokenLedger}
      where ${tokenLedger.userId} = ${users.id} and ${tokenLedger.referralId} is not null
        and ${notificationJobs.dedupeKey} = 'referral_rewarded:' || ${tokenLedger.id}::text)`,
  },
  [NotificationKind.TokensHalf]: tokenNudge(NotificationKind.TokensHalf),
  [NotificationKind.TokensLow]: tokenNudge(NotificationKind.TokensLow),
  [NotificationKind.TokensOut]: tokenNudge(NotificationKind.TokensOut),
  [NotificationKind.RealModeByDeposit]: {
    facts: switchedDeposits,
    afterMs: REAL_MODE_BY_DEPOSIT_AFTER_MS,
    dedupeKey: sql`('real_mode_by_deposit:' || fact.deposit_id::text)`,
    // the real stake in use: the saved one, else the broker's minimum of the deposit's account
    // (one snapshot per account), as text (rule 2); NULL when neither is known
    payload: sql`jsonb_build_object(${STAKE_KEY}, coalesce(${users.realStake},
      (select ${brokerBalanceSnapshots.minTradeAmount} from ${brokerBalanceSnapshots}
        where ${brokerBalanceSnapshots.brokerAccountId} = fact.broker_account_id))::text)`,
    // the message says the mode is REAL: not once the user went back to demo
    stillApplies: sql`(${users.status} = ${literal(UserStatus.Active)}
      and ${users.tradingMode} = ${literal(TradeMode.Real)})`,
    keyApplies: sql`exists (select 1 from ${depositEvents}
      where ${depositEvents.userId} = ${users.id}
        and ${depositEvents.modeSwitch} = ${literal(DepositModeSwitch.Switched)}
        and ${notificationJobs.dedupeKey} = 'real_mode_by_deposit:' || ${depositEvents.id}::text)`,
    replansCanceled: true,
    important: true,
  },
  // Scenario 1 (#124): a demo user with a session behind them, inactive since the fact. Newer
  // activity is a new key, so the old job is cancelled at the claim; at most one sent in
  // INACTIVE_REPEAT_DAYS; not planned, and cancelled at the claim, while specificHolds: one push
  // per inactivity spell (docs/mailing.md → Retention).
  [NotificationKind.Inactive3d]: oneFact({
    factAt: lastActivityAt,
    afterMs: INACTIVE_AFTER_MS,
    // the activity's own moment, microseconds and UTC whatever the session's TimeZone
    dedupeKey: sql`('inactive_3d:' || extract(epoch from ${lastActivityAt})::text)`,
    stillApplies: sql`(${commonRetention}
      and exists (select 1 from ${tradingSessions}
        join ${brokerAccounts} on ${brokerAccounts.id} = ${tradingSessions.brokerAccountId}
        where ${brokerAccounts.userId} = ${users.id})
      and not exists (select 1 from ${notificationJobs} recent
        where recent.user_id = ${users.id}
          and recent.kind = ${literal(NotificationKind.Inactive3d)}
          and recent.status = ${literal(NotificationJobStatus.Sent)}
          and recent.sent_at > now() - make_interval(days => ${INACTIVE_REPEAT_DAYS}))
      and not ${specificHolds})`,
  }),
  [NotificationKind.SessionIdle24h]: sessionIdle24h,
  [NotificationKind.WeeklySummary]: weeklySummaryAt(sql`now()`),
  [NotificationKind.TokensOut2d]: tokensOut2d,
  // The help push (#879, docs/mailing.md → The help push): once per user, HELP_LINKS_AFTER after
  // the connect, while the user is not blocked by the admin and has an active account. The links
  // are for everyone: no trading mode, deposit or session is read. Whether the links are set is
  // the backend's (env), so it is not here: the engine leaves the kind out of planning and claims.
  [NotificationKind.HelpLinks]: oneFact({
    factAt: linkedAt,
    afterMs: HELP_LINKS_AFTER_MS,
    dedupeKey: sql`${'help_links'}`,
    stillApplies: sql`(${users.status} = ${literal(UserStatus.Active)}
      and exists (select 1 from ${brokerAccounts}
        where ${brokerAccounts.userId} = ${users.id}
          and ${brokerAccounts.status} = ${literal(BrokerAccountStatus.Active)}))`,
  }),
  [NotificationKind.DemoToReal1h]: demoToRealStep(NotificationKind.DemoToReal1h),
  [NotificationKind.DemoToReal24h]: demoToRealStep(NotificationKind.DemoToReal24h),
  [NotificationKind.DemoToReal72h]: demoToRealStep(NotificationKind.DemoToReal72h),
} as const satisfies Record<NotificationKind, MailingScenario>;

// The important kinds (MailingScenario.important), from the scenarios alone.
export const IMPORTANT_NOTIFICATION_KINDS: readonly NotificationKind[] = (
  Object.keys(MAILING_SCENARIOS) as NotificationKind[]
).filter((kind) => (MAILING_SCENARIOS[kind] as MailingScenario).important === true);
