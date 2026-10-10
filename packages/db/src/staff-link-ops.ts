import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { AuditAction, AuditActorType, AuditEntityType, LinkState } from '@binarius/shared';
import type { Db } from './client';
import { hashToken } from './oauth-ops';
import { millisecondsAgo, millisecondsFromNow, type Tx } from './trade-intent-ops';
import { staff, StaffStatus } from './schema/staff';
import { staffLoginLinks, StaffLoginLinkStatus } from './schema/staff-login-links';
import { insertStaffSession, writeAuditEntry } from './staff-ops';

// --- Policy (#448) -----------------------------------------------------------------------------
// Durations of the domain, next to the code-login policy in staff-ops.ts.

/** How long a link from the staff bot can be opened (owner's decision, 2026-10-10). */
export const STAFF_LOGIN_LINK_TTL_MS = 5 * 60_000;
/** Links one staff member can be sent per window, as #68 allows five passwords per 15 minutes. */
export const STAFF_LOGIN_LINK_MAX_PER_WINDOW = 5;
export const STAFF_LOGIN_LINK_WINDOW_MS = 15 * 60_000;

// the same strength as the session token the link turns into
const LINK_TOKEN_BYTES = 32;

// --- The bot side ------------------------------------------------------------------------------

export interface StaffByTelegram {
  id: string;
  status: StaffStatus;
}

/**
 * The staff member behind a Telegram account, active or not; one index lookup
 * (staff_telegram_user_id_idx). /start answers from it, so the same statement runs whether or
 * not a row exists.
 */
export async function findStaffByTelegram(
  db: Db,
  telegramUserId: bigint,
): Promise<StaffByTelegram | undefined> {
  const [row] = await db
    .select({ id: staff.id, status: staff.status })
    .from(staff)
    .where(eq(staff.telegramUserId, telegramUserId));
  return row;
}

/**
 * The bot refused a known staff member whose account is not active. The handler writes it after
 * the reply has gone, so the reply takes the same time whether or not a row follows. A sender who
 * is nobody's account leaves no row (owner's answer В5, 2026-10-10): an entry keyed on a
 * stranger's Telegram id would be a record of someone else's account.
 */
export async function recordStaffBotRefusal(
  db: Db,
  input: { staffId: string; via: 'start' | 'button' },
): Promise<void> {
  await writeAuditEntry(db, {
    action: AuditAction.StaffLoginLinkRefused,
    actorType: AuditActorType.System,
    actorId: input.staffId,
    entityType: AuditEntityType.Staff,
    entityId: input.staffId,
    payload: { reason: 'disabled', via: input.via },
  });
}

export type IssueLoginLinkResult =
  | { ok: true; token: string; linkId: string; expiresAt: Date }
  | { ok: false; reason: 'not_staff' | 'rate_limited' }
  | { ok: false; reason: 'disabled'; staffId: string };

/**
 * The button press. Authority is the Telegram account the update came from and nothing in the
 * callback data. The `staff` row is taken first, `FOR NO KEY UPDATE` (Rule 5): it serialises two
 * presses of one person, so superseding the previous link is a decision rather than a race
 * against staff_login_links_live_idx, and it orders the press against the CLI's disable.
 *
 * `locked_until` is not read (owner's answer В4): a password lockout does not shut the bot path.
 */
export async function issueLoginLink(
  db: Db,
  input: { telegramUserId: bigint },
): Promise<IssueLoginLinkResult> {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: staff.id, status: staff.status })
      .from(staff)
      .where(eq(staff.telegramUserId, input.telegramUserId))
      .for('no key update');
    if (owner === undefined) return { ok: false, reason: 'not_staff' };
    // the audit row is the handler's, after its reply (recordStaffBotRefusal)
    if (owner.status !== StaffStatus.Active) {
      return { ok: false, reason: 'disabled', staffId: owner.id };
    }

    // every row counts, used and superseded included: the limit is on links sent, not opened
    const [recent] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(staffLoginLinks)
      .where(
        and(
          eq(staffLoginLinks.staffId, owner.id),
          sql`${staffLoginLinks.createdAt} > ${millisecondsAgo(STAFF_LOGIN_LINK_WINDOW_MS)}`,
        ),
      );
    if ((recent?.count ?? 0) >= STAFF_LOGIN_LINK_MAX_PER_WINDOW) {
      await writeAuditEntry(tx, {
        action: AuditAction.StaffLoginLinkRefused,
        actorType: AuditActorType.System,
        actorId: owner.id,
        entityType: AuditEntityType.Staff,
        entityId: owner.id,
        payload: { reason: 'rate_limited', via: 'button' },
      });
      return { ok: false, reason: 'rate_limited' };
    }

    // an issued link past its expiry is still in the live index, so it is superseded too
    const superseded = await tx
      .update(staffLoginLinks)
      .set({ status: StaffLoginLinkStatus.Superseded })
      .where(
        and(
          eq(staffLoginLinks.staffId, owner.id),
          eq(staffLoginLinks.status, StaffLoginLinkStatus.Issued),
        ),
      )
      .returning({ id: staffLoginLinks.id });

    const token = randomBytes(LINK_TOKEN_BYTES).toString('base64url');
    const [link] = await tx
      .insert(staffLoginLinks)
      .values({
        staffId: owner.id,
        tokenHash: hashToken(token),
        expiresAt: millisecondsFromNow(STAFF_LOGIN_LINK_TTL_MS),
      })
      .returning({ id: staffLoginLinks.id, expiresAt: staffLoginLinks.expiresAt });
    if (link === undefined) throw new Error('staff_login_links insert returned no row');
    await writeAuditEntry(tx, {
      action: AuditAction.StaffLoginLinkIssued,
      actorType: AuditActorType.System,
      actorId: owner.id,
      entityType: AuditEntityType.StaffLoginLink,
      entityId: link.id,
      payload: { superseded: superseded.length },
    });
    return { ok: true, token, linkId: link.id, expiresAt: link.expiresAt };
  });
}

// --- The web side ------------------------------------------------------------------------------

/** Why a link is not live, or that it is. Carried into the audit row as it is. */
export type LinkRefusalReason =
  | 'live'
  | 'disabled'
  | typeof StaffLoginLinkStatus.Used
  | typeof StaffLoginLinkStatus.Superseded
  | typeof StaffLoginLinkStatus.Revoked
  | 'expired';

/**
 * One reading of a link row for GET (inspect) and for the refusal of POST (complete). The order
 * matters: a disabled owner is why the CAS missed whatever the link looks like; "used" outranks
 * "expired", so opening the link again after logging in tells the truth however late it is; a
 * superseded or revoked link is dead before its clock runs out.
 */
export function linkRefusalReason(row: {
  status: StaffLoginLinkStatus;
  expired: boolean;
  staffStatus: StaffStatus;
}): LinkRefusalReason {
  if (row.staffStatus !== StaffStatus.Active) return 'disabled';
  if (row.status !== StaffLoginLinkStatus.Issued) return row.status;
  if (row.expired) return 'expired';
  return 'live';
}

/** What the page may say: a disabled owner reads as any other dead link (no oracle). */
const linkStateOf = (reason: LinkRefusalReason): LinkState => {
  switch (reason) {
    case 'live':
      return LinkState.Live;
    case StaffLoginLinkStatus.Used:
      return LinkState.Used;
    case 'expired':
      return LinkState.Expired;
    default:
      return LinkState.Unavailable;
  }
};

async function readLink(executor: Db | Tx, tokenHash: string) {
  const [row] = await executor
    .select({
      id: staffLoginLinks.id,
      staffId: staffLoginLinks.staffId,
      status: staffLoginLinks.status,
      expired: sql<boolean>`${staffLoginLinks.expiresAt} <= now()`,
      staffStatus: staff.status,
    })
    .from(staffLoginLinks)
    .innerJoin(staff, eq(staff.id, staffLoginLinks.staffId))
    .where(eq(staffLoginLinks.tokenHash, tokenHash));
  return row;
}

/**
 * GET on the link. One SELECT: no lock, no audit row, nothing spent — Telegram's preview, a
 * messenger's prefetch and a browser's prerender can call it as often as they like.
 */
export async function inspectLoginLink(db: Db, token: string): Promise<LinkState> {
  const row = await readLink(db, hashToken(token));
  return row === undefined ? LinkState.Unavailable : linkStateOf(linkRefusalReason(row));
}

export type CompleteLinkLoginResult =
  | { ok: true; sessionToken: string; expiresAt: Date; staffId: string }
  | { ok: false; state: Exclude<LinkState, typeof LinkState.Live> };

/**
 * POST on the link. One CAS decides: the link is still `issued`, inside its five minutes by the
 * database's clock, and its owner is active — so two requests carrying the token produce one
 * session and one refusal, and a disable committed before this one leaves the link dead.
 *
 * `used_at` is clock_timestamp(): the CHECK orders it against `created_at`, and the statement
 * clock is never earlier than a row the statement can see (the class of #149).
 */
export async function completeLinkLogin(
  db: Db,
  input: { token: string; ip: string; userAgent: string; sessionTtlMs?: number },
): Promise<CompleteLinkLoginResult> {
  const tokenHash = hashToken(input.token);
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string; staff_id: string }>(sql`
      update ${staffLoginLinks} as l
         set status = ${StaffLoginLinkStatus.Used},
             used_at = clock_timestamp()
        from ${staff} as s
       where l.token_hash = ${tokenHash}
         and l.staff_id = s.id
         and s.status = ${StaffStatus.Active}
         and l.status = ${StaffLoginLinkStatus.Issued}
         and l.expires_at > now()
      returning l.id, l.staff_id
    `);
    const claimed = rows[0];
    if (claimed === undefined) return refuseLink(tx, tokenHash, input.ip);

    const session = await insertStaffSession(tx, {
      staffId: claimed.staff_id,
      ip: input.ip,
      userAgent: input.userAgent,
      ...(input.sessionTtlMs === undefined ? {} : { ttlMs: input.sessionTtlMs }),
    });
    await writeAuditEntry(tx, {
      action: AuditAction.StaffLoginLinkCompleted,
      actorType: AuditActorType.Admin,
      actorId: claimed.staff_id,
      entityType: AuditEntityType.StaffSession,
      entityId: session.id,
      payload: { linkId: claimed.id, ip: input.ip },
    });
    return {
      ok: true,
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      staffId: claimed.staff_id,
    };
  });
}

// Zero rows from the CAS. A token nobody was issued leaves no row (В5: rows are about known staff
// members; the route logs it). Otherwise the row says why, in the same transaction.
async function refuseLink(tx: Tx, tokenHash: string, ip: string): Promise<CompleteLinkLoginResult> {
  const row = await readLink(tx, tokenHash);
  if (row === undefined) return { ok: false, state: LinkState.Unavailable };
  const reason = linkRefusalReason(row);
  await writeAuditEntry(tx, {
    action: AuditAction.StaffLoginLinkRefused,
    actorType: AuditActorType.System,
    actorId: row.staffId,
    entityType: AuditEntityType.StaffLoginLink,
    entityId: row.id,
    // `live` here would be a row the CAS missed and the re-read found usable: nothing in this
    // feature moves a link back to `issued` or an owner back to active, so it is not expected
    payload: { reason: reason === 'live' ? 'state_changed' : reason, via: 'web', ip },
  });
  const state = linkStateOf(reason);
  return { ok: false, state: state === LinkState.Live ? LinkState.Unavailable : state };
}
