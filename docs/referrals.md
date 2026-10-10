# Personal invite links (issue #115)

Every user can share a personal start link, `https://t.me/<bot>?start=ref_<code>`. A new user who
opens it and presses Start is recorded as invited by the link's owner, once. The reward for an
invitee is #116; this part only records who invited whom and shows the link.

## Components

- `packages/shared/src/referral.ts` — `REFERRAL_CODE_LENGTH` (8), `REFERRAL_CODE_PATTERN`
  (`^[A-Za-z0-9]{8}$`), `REFERRAL_PAYLOAD_PREFIX` (`ref_`), `referralPayloadOf`, `referralCodeOf`
  (a code only for `ref_` plus a valid code), `referralLinkOf`, and the contract of
  `POST /users/referral`.
- `packages/db/src/schema/referrals.ts` — the tables `referral_codes` and `referrals`, migration
  `0042_referrals`.
- `packages/db/src/user-ops.ts` → `recordUserStart` — records the invitation.
- `packages/db/src/referral-ops.ts` → `readUserReferral` — the code and the count.
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
`on delete restrict`. The reward's columns are #116's, with its own migration.

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
| an active user | 200 `{ user: { status: 'active', code, invited } }` — the code created on the first call |
| a blocked user | 200 `{ user: { status: 'blocked', code: null, invited } }` — no code created |

`invited` is the number of `referrals` rows with this inviter, a blocked inviter's included. The
answer has these three keys only. The route creates a code on the first call, but a repeat finds
the same code, so the bot treats it as a read.

## The screen

`/invite` (in the command menu after `/settings`), «👥 Пригласить друга» under the status card and
under a stopped session's status and summary card ([bot-session.md](bot-session.md)), and
«🔄 Повторить» `cmd:invite` all run `showInvite`. The button answers the press first; the screen is
always a new message, since the cards are photos.

| Read | Text | Keyboard |
|---|---|---|
| active | `inviteScreen`: the link and «Приглашено: N» | «📤 Поделиться», then «🏠 В меню» |
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

## Accepted risks

1. A user who wrote to the bot once without a link and later follows a friend's link is not
   counted: only a user the link's `/start` creates is an invitee.
2. A blocked inviter's existing code still records new invitees; whether that earns anything is
   #116's decision.
3. A code is never rotated or revoked: a leaked link keeps attributing to its owner.
4. The share text and the screen are in Russian only, as the whole bot.

## Boundaries

- **#116** — the reward: 50 tokens to the inviter when the invitee connects a partner Binodex
  account, and the screen's «подключили аккаунт» and «получено токенов» lines.
- **#440** — the personal link in the summary card's caption and in #321's share.
- Inline mode (`switch_inline_query`) and the admin card — not in scope.
