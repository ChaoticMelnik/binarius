# Personal invite links (issues #115, #116)

Every user can share a personal start link, `https://t.me/<bot>?start=ref_<code>`. A new user who
opens it and presses Start is recorded as invited by the link's owner, once (#115). When the
invitee connects a partner Binodex account, the inviter gets the tokens of the `referral_reward`
rule, 50 in v1, once per invitee (#116, [The reward](#the-reward)).

## Components

- `packages/shared/src/referral.ts` — `REFERRAL_CODE_LENGTH` (8), `REFERRAL_CODE_PATTERN`
  (`^[A-Za-z0-9]{8}$`), `REFERRAL_PAYLOAD_PREFIX` (`ref_`), `referralPayloadOf`, `referralCodeOf`
  (a code only for `ref_` plus a valid code), `referralLinkOf`, and the contract of
  `POST /users/referral`.
- `packages/db/src/schema/referrals.ts` — the tables `referral_codes` and `referrals`, migration
  `0043_referrals`.
- `packages/db/src/user-ops.ts` → `recordUserStart` — records the invitation.
- `packages/db/src/referral-ops.ts` → `readUserReferral` — the code and the counts.
- `packages/db/src/referral-reward-ops.ts` → `grantReferralReward` — the reward (#116), called by
  `confirmBrokerAccount` and `linkBrokerAccount` (`packages/db/src/oauth-ops.ts`); migration
  `0060_referral_reward`.
- `apps/backend/src/users/routes.ts` → `POST /users/referral`.
- `apps/bot/src/invite.ts` — the screen; `apps/bot/src/keyboards.ts` — `inviteButton`,
  `statusCardKeyboard`, `withInvite`, `inviteKeyboard`; `apps/bot/src/bot.ts` — `/invite`, the
  `invite` button and `cmd:invite`.

## The tables

**`referral_codes`** — one code per user, created on the user's first `/invite` and never changed.

| Column | |
|---|---|
| `user_id` | PK, FK `referral_codes_user_fk` → `users.id` |
| `code` | `NOT NULL`, unique `referral_codes_code_key`, CHECK `referral_codes_code_check` (`code ~ '^[A-Za-z0-9]{8}$'`, built from `REFERRAL_CODE_PATTERN.source`) |
| `created_at` | database clock |

The CHECK alone would let a NULL through (`null ~ 'x'` is NULL, which a CHECK accepts), so the
column is `NOT NULL`.

**`referrals`** — who invited whom, one row per invitee.

| Column | |
|---|---|
| `id` | PK |
| `invitee_user_id` | FK `referrals_invitee_fk`, unique `referrals_invitee_key` |
| `inviter_user_id` | FK `referrals_inviter_fk`, index `referrals_inviter_idx` for the count |
| `created_at` | database clock |

CHECK `referrals_not_self_check` (`invitee_user_id <> inviter_user_id`). Every FK is
`on delete restrict`. Unique `referrals_id_inviter_key (id, inviter_user_id)` is the target of the
reward's ledger FK (#116); a referral row is never updated.

## The code

Eight characters of base62, each drawn by `crypto.randomInt(62)` (uniform, no modulo bias): 62⁸ ≈
2.2·10¹⁴ codes. The code is never derived from the Telegram id or `users.id`, so a link says nothing
about its owner and the codes cannot be walked.

`readUserReferral` creates it lazily: it selects the user's code; when there is none it inserts a
new one `on conflict do nothing` and selects again. A conflict on `user_id` is a concurrent first
read (both get the one that won), on `code` another user's code (a new draw). After three draws
without a code it throws, a 500. A blocked user gets no new code.

## Recording

`recordUserStart` is the one upsert of `users` behind `/start`, `/menu`, «🏠 В меню» and
`/settings` ([bot-start.md → First touch](bot-start.md#first-touch)). Its `returning` carries
`old.id is null`, which on PostgreSQL 18 is true exactly when the upsert inserted the row. When it
is true and the payload is `ref_<code>` with a valid code, the same transaction runs:

```sql
insert into referrals (id, invitee_user_id, inviter_user_id, created_at)
select gen_random_uuid(), $invitee, rc.user_id, now()
  from referral_codes rc
 where rc.code = $code and rc.user_id <> $invitee
on conflict (invitee_user_id) do nothing
returning id
```

- **Only a new user is an invitee.** A user whose row existed before this `/start` — created by a
  `/start` without a link, by `/menu`, or by an earlier link — is never recorded, even when this
  `/start` fills an empty `acquisition_source`. First touch still stores the payload by its own
  rule, so `acquisition_source` can be `ref_<code>` without a `referrals` row.
- **Once per invitee.** `inserted` is true for one upsert per Telegram id
  (`users_telegram_user_id_idx`), and `referrals_invitee_key` with `do nothing` backs it up.
- **An unknown code** inserts nothing. **A malformed one** (`ref_abc`) is not a code at all.
- **A self-invite** cannot be built through the bot: a new user has no code yet. The statement's
  `rc.user_id <> $invitee` and `referrals_not_self_check` are the backstop.
- **The `/start` answer is unchanged** in every case. `POST /users/start` logs `info`
  `referral recorded`, with no ids and no code, when a row was inserted.

**Locks.** The insert takes `KEY SHARE` on the two `users` rows through its FKs. No writer takes
`FOR UPDATE` on `users` (they take `FOR NO KEY UPDATE`, which does not conflict with it), so the
lock order of Architecture Rule 5 is untouched.

## The route

`POST /users/referral { telegramUserId }` behind the internal bearer, as `/users/account`:

| Case | Answer |
|---|---|
| a bad body | 400 `validation` |
| no `users` row | 404 `user_not_found` |
| an active user | 200 `{ user: { status: 'active', code, invited, connected, tokensEarned } }` — the code created on the first call |
| a blocked user | 200 `{ user: { status: 'blocked', code: null, invited, connected, tokensEarned } }` — no code created |

`invited` is the number of `referrals` rows with this inviter, a blocked inviter's included.
`connected` (#116) is how many of those invitees have a partner account that is not `pending` — a
confirmed one, a revoked one included, each invitee once. `tokensEarned` is the sum of the
inviter's ledger rows that name a referral, a decimal string. While the reward rule is off the two
differ: an invitee is counted as connected without a reward. The answer has these five keys only. The route creates a code on the first call, but a repeat finds
the same code, so the bot treats it as a read.

## The screen

`/invite` (in the command menu after `/settings`), «👥 Пригласить друга» under the status card and
under a stopped session's status and summary card ([bot-session.md](bot-session.md)), and
«🔄 Повторить» `cmd:invite` all run `showInvite`. The button answers the press first; the screen is
always a new message, since the cards are photos.

| Read | Text | Keyboard |
|---|---|---|
| active | `inviteScreen`: the link, «Приглашено: N», «Подключили аккаунт: N» and «Получено токенов: T» | «📤 Поделиться», then «🏠 В меню» |
| blocked | `blocked` | the support URL |
| 404 `user_not_found` (no `/start` yet) | `inviteNeedsStart` | «🏠 В меню», whose press runs `/start`'s path and creates the row |
| any other failure | `unavailable`, `warn` `/invite not read` | «🔄 Повторить» `cmd:invite` · «🏠 В меню» |

The link is `referralLinkOf(ctx.me.username, code)`, printed as plain text; Telegram makes it a
link. «📤 Поделиться» is a URL button to
`https://t.me/share/url?url=<link>&text=<inviteShareText>`, both parts URL-encoded: Telegram opens
its chat picker. An overridden `inviteScreen` may drop `{referralLink}` (no variable is required,
[bot-texts.md](bot-texts.md)); the share button still carries the link.

Timing (`apps/bot/src/timing.ts`): `HANDLER_CALLS.invite` = 1 / 1, `.inviteButton` = 1 / 2,
`.commandRetry` stays 1 / 2.

## The reward

**The target action** (owner, 2026-10-08) is the invitee's activation of a **partner** Binodex
account: a confirm (`POST /auth/binodex/confirm`), an email login, or an OAuth re-login that leaves
an account confirmed before (`active`/`revoked`) active. **The reward** is the active
`referral_reward` version's tokens ([bonus-rules.md](bonus-rules.md)) to the inviter; the invitee
gets nothing beyond the starter pack.

**Where.** Two calls in the activation's transaction (`packages/db/src/referral-reward-ops.ts`).
`lockReferralInviter(tx, inviteeUserId)` runs right after the invitee's `users` row is locked,
before any other table: it reads the invitee's `referrals` row (no lock: it is never updated) and a
ledger row naming it, and while the referral is unpaid locks the inviter's `users` row
`FOR NO KEY UPDATE`. `grantReferralReward(tx, { referral, account })` runs after `grantLinkBonus`
(on the callback re-login, without a pack) and takes no lock of its own; its answers, in this
order:

1. a non-partner account → `not_partner_client`;
2. no `referrals` row → `no_referral`;
3. a ledger row naming that referral → `already_rewarded`, **before** the rule is read, so a
   deactivated or broken rule neither changes this answer nor rolls a re-login back;
4. a blocked inviter → `inviter_blocked`;
5. `applyBonus('referral_reward', { referralId })` → `rewarded` with the tokens and the version,
   or `no_active_rule`.

**When it fires** (manager's decision 2026-10-17): on every activation of a partner account by the
invitee while the rule has an active version and the inviter is not blocked, at most once per
referral. A skipped one is paid at the invitee's next activation of a partner account, a repeat
email login included. The starter pack does not gate it: with `link_bonus` off the invitee gets no
pack and the inviter still gets the reward. An active version whose params do not parse throws
`InvalidBonusRule` and rolls the activation back, as the pack does (Rule 40). The OAuth callback
(`activate: false`) pays nothing for an account it leaves pending — the confirm pays then — and
pays the reward (no pack) when it leaves an account confirmed before active.

**The ledger row.** `kind = bonus` on the inviter, `balance_delta` = the rule's tokens,
`referral_id`, `bonus_rule_id`/`bonus_rule_kind` of the version read; no `broker_account_id`, so it
takes no slot of the inviter's own starter pack. `users.token_balance` moves in the same
transaction (Rule 2).

| Constraint | What it holds |
|---|---|
| `token_ledger_referral_inviter_fk` `(referral_id, user_id) → referrals (id, inviter_user_id)` | the reward is on that referral's inviter and nobody else |
| `token_ledger_referral_idx` unique `(referral_id) where referral_id is not null` | one reward per referral; the `ON CONFLICT` arbiter |
| `token_ledger_reference_check` | a bonus names at most one of `broker_account_id`, `deposit_event_id`, `referral_id`; no other kind names a referral |
| `token_ledger_bonus_rule_check` | a bonus naming a referral is under a `referral_reward` rule |

**Anti-fraud** (owner, 2026-10-08: by broker account only). Both of the owner's criteria follow from
constraints rather than reads:

- *The same broker account on both sides* cannot exist: `broker_accounts_broker_user_id_idx` gives
  a `broker_user_id` one owner, and no writer changes an account's `user_id` or `broker_user_id`.
  The invitee logging in with the inviter's broker account gets `broker_account_taken` and no
  activation, so no reward.
- *At most one reward per `broker_user_id`*: one referral per invitee (`referrals_invitee_key`),
  one reward per referral (`token_ledger_referral_idx`), one owner per `broker_user_id`.

**Locks (Rule 5).** Every activation path (the confirm, the email login, the callback re-login)
takes `users`(invitee) → `users`(inviter, only while the referral is unpaid) → `broker_accounts` →
`deposit_events` → `token_ledger` (FK `KEY SHARE` on `referrals`, `bonus_rules`) → the `users`
UPDATEs of both rows, already held. No cycle, by two facts:

- (a) a reward writer takes every `users` lock before its first lock of any other table, and no
  writer waits on a `users` row while holding a `broker_accounts`, `deposit_events` or
  `token_ledger` lock. The inviter's own login with the invitee's broker account holds only the
  inviter's `users` row when it waits on that account; the reward used to lock the inviter after
  the account, and that was a `40P01` (#577 review, round 1). The other writers: trading
  (`createInTransaction`, `createTradingSession`, `rejectIntent`, `settleIntent`,
  `concludeReconciled`) lock `users` first; the token refresh and `recordPostback` lock
  `broker_accounts` and read `users` without a lock; `creditStarPayment`, `recordStarRefund`,
  `adjustTokens` and the settings writers hold one `users` row.
- (b) among `users` rows, waits run from a newer row to an older one: only reward writers hold
  two, and the second is the inviter's, always older — a referral is recorded only by the `/start`
  that created the invitee's row ([Recording](#recording)).

A future writer keeps (a) (Rule 5). Step 3's read is serialized by the invitee's own row, which
every writer of this referral's reward holds first; `token_ledger_referral_idx` stays the arbiter.
The cost: while the referral is unpaid, every activation of the invitee holds the inviter's row to
its commit, a non-partner one included.

**The log**, after the commit (the routes' answers are unchanged): `info` `referral rewarded`
`{ referralId, inviterUserId, tokens, ruleVersion }`; `warn` `referral_reward_no_active_rule`
`{ referralId }`; `info` `referral reward skipped` `{ referralId, reason: 'inviter_blocked' }`;
nothing for `not_partner_client`, `no_referral` or `already_rewarded`.

**Deploy.** Backend before the bot: the bot's schema requires `connected` and `tokensEarned`, so a
new bot against an old backend shows `unavailable` on `/invite` until the backend is up.

## Accepted risks

1. A user who wrote to the bot once without a link and later follows a friend's link is not
   counted: only a user the link's `/start` creates is an invitee.
2. A blocked inviter's existing code still records new invitees; their activations pay nothing
   while the inviter is blocked, and the reward is paid at the invitee's next partner activation
   after the unblock.
3. A code is never rotated or revoked: a leaked link keeps attributing to its owner.
4. The share text and the screen are in Russian only, as the whole bot.
5. Two Telegram accounts of one person with two different partner broker accounts earn the reward:
   anti-fraud is by broker account only (owner, 2026-10-08).
6. A missed reward (rule off, inviter blocked, a non-partner account) is paid only at a later
   activation, which may be long after or never; the inviter sees it on `/invite`. No push tells
   the inviter about a reward yet (#576).

## Boundaries

- **#576** — the push to the inviter about a reward, through the mailing engine (after #574).
- **#386** — deposit-based bonuses; rewards for an invitee's deposit are not in scope.
- **#440** — the personal link in the summary card's caption and in #321's share.
- Inline mode (`switch_inline_query`) and the admin card — not in scope.
