import {
  ADMIN_BOT_TEXT_READ_ONLY_GROUPS,
  BOT_TEXT_CATALOG,
  BOT_TEXT_GROUP_TITLES,
  BOT_TEXT_SOURCE_MAX,
  BotTextGroup,
  botTextKeysOf,
  isAdminBotTextEditable,
  type AdminBotTextOverrideView,
  type AdminBotTextProblem,
  type AdminBotTextView,
  type BotTextKey,
  ADMIN_INTENTS_ACTIVE_FILTER,
  ADMIN_USER_RECENT_INTENTS,
  ADMIN_USER_RECENT_LEDGER,
  adminAuditSearchParams,
  adminIntentsSearchParams,
  adminTokensSearchParams,
  adminTradingSessionsSearchParams,
  adminUsersSearchParams,
  AuditAction,
  AuditEntityType,
  TokenLedgerKind,
  TradeIntentStatus,
  TradeMode,
  UUID_PATTERN,
  type AdminAuditEntryView,
  type AdminAuditQuery,
  type AdminBrokerAccountView,
  type AdminIntentsQuery,
  type AdminLedgerEntry,
  type AdminOverview,
  type AdminTokensQuery,
  type AdminTradeIntentView,
  type AdminTradingSessionsQuery,
  type AdminTradingSessionView,
  type AdminUserListItem,
  type AdminUserResponse,
  type AdminUsersQuery,
  type StaffSessionView,
} from '@binarius/shared';
import { html, layout, type SafeHtml } from '../html';
import { TEXTS } from './texts';

const error = (message: string | undefined): SafeHtml =>
  message === undefined ? html`` : html`<p class="error">${message}</p>`;

export const loginPage = (message?: string): SafeHtml =>
  layout({
    title: TEXTS.loginTitle,
    body: html`<h1>${TEXTS.loginHeading}</h1>
      ${error(message)}
      <form class="stack" method="post" action="/admin/login">
        <label
          >${TEXTS.loginField}
          <input name="login" autocomplete="username" autocapitalize="off" required />
        </label>
        <label
          >${TEXTS.passwordField}
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit">${TEXTS.loginSubmit}</button>
      </form>`,
  });

export const confirmPage = (message?: string): SafeHtml =>
  layout({
    title: TEXTS.confirmTitle,
    body: html`<h1>${TEXTS.confirmHeading}</h1>
      <p>${TEXTS.confirmHint}</p>
      ${error(message)}
      <form class="stack" method="post" action="/admin/login/confirm">
        <label
          >${TEXTS.codeField}
          <input
            name="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]{6}"
            required
          />
        </label>
        <button type="submit">${TEXTS.confirmSubmit}</button>
      </form>`,
  });

// The timestamps are rendered as the backend sent them. Formatting them for a locale would be
// this process guessing a timezone; the ISO instant is unambiguous, which matters most for the
// column an operator reads to decide whether a session is theirs.
const when = (iso: string): SafeHtml => html`<time datetime="${iso}">${iso}</time>`;

const row = (session: StaffSessionView): SafeHtml => html`<tr class="${session.current ? 'current' : ''}">
  <td>${session.login}${session.current ? html` (${TEXTS.currentSession})` : ''}</td>
  <td>${session.displayName ?? TEXTS.noDisplayName}</td>
  <td>${session.ip}</td>
  <td class="agent">${session.userAgent}</td>
  <td>${when(session.createdAt)}</td>
  <td>${when(session.lastSeenAt)}</td>
  <td>${when(session.expiresAt)}</td>
  <td>
    <form method="post" action="/admin/sessions/${session.id}/revoke">
      <button type="submit">${TEXTS.revokeSubmit}</button>
    </form>
  </td>
</tr>`;

const whenOrNone = (iso: string | null): SafeHtml | string =>
  iso === null ? TEXTS.none : when(iso);
const orNone = (value: string | null): string => value ?? TEXTS.none;
const yesNo = (value: boolean): string => (value ? TEXTS.yes : TEXTS.no);

// The pages a staff session opens, in nav order. The read pages that follow #107 append their
// keys here; a page outside the nav passes no `active`.
export type AdminNavKey =
  | 'overview'
  | 'users'
  | 'sessions'
  | 'intents'
  | 'tradingSessions'
  | 'tokens'
  | 'audit'
  | 'botTexts';

const NAV: readonly { key: AdminNavKey; href: string; label: string }[] = [
  { key: 'overview', href: '/admin/overview', label: TEXTS.navOverview },
  { key: 'users', href: '/admin/users', label: TEXTS.navUsers },
  { key: 'sessions', href: '/admin/sessions', label: TEXTS.navSessions },
  { key: 'intents', href: '/admin/intents', label: TEXTS.navIntents },
  { key: 'tradingSessions', href: '/admin/trading-sessions', label: TEXTS.navTradingSessions },
  { key: 'tokens', href: '/admin/tokens', label: TEXTS.navTokens },
  { key: 'audit', href: '/admin/audit', label: TEXTS.navAudit },
  { key: 'botTexts', href: '/admin/bot-texts', label: TEXTS.navBotTexts },
];

/**
 * Every page behind a staff session. `login` comes only from the `me` of the backend answer the
 * page was built from; a page rendered without asking the backend (a refused search, a refused
 * password form) has no login, and the account block is left out rather than invented.
 */
export const adminShell = ({
  title,
  active,
  login,
  body,
}: {
  title: string;
  active?: AdminNavKey;
  login?: string;
  body: SafeHtml;
}): SafeHtml =>
  layout({
    title,
    body: html`<div class="bar">
        <nav aria-label="${TEXTS.navLabel}">
          ${NAV.map(
            (item) =>
              html`<a href="${item.href}" ${item.key === active ? html` aria-current="page"` : ''}
                >${item.label}</a
              >`,
          )}
        </nav>
        ${
          login === undefined
            ? ''
            : html`<div class="account">
                <a href="${PASSWORD_PATH}">${TEXTS.passwordLink}</a>
                <form method="post" action="/admin/logout">
                  <button type="submit">${login} — ${TEXTS.logoutSubmit}</button>
                </form>
              </div>`
        }
      </div>
      ${body}`,
  });

/**
 * The one way to build a list URL: `q` and `cursor` go through the shared serializer, because
 * `html` escapes HTML, not URLs — `q = 'a&b'` interpolated raw would be two parameters.
 */
export const usersHref = (query: AdminUsersQuery): string => {
  const params = adminUsersSearchParams(query);
  return params.size > 0 ? `/admin/users?${params}` : '/admin/users';
};

export const PASSWORD_PATH = '/admin/password';

/** `changed` is the number of other sessions the change revoked; 0 is a value, not its absence. */
export const passwordHref = (changed?: number): string =>
  changed === undefined
    ? PASSWORD_PATH
    : `${PASSWORD_PATH}?${new URLSearchParams({ changed: String(changed) })}`;

/**
 * The form never takes the values it was submitted with, so none of them can reach the page.
 * `login` and `others` come from the sessions read of a GET; a refused POST asks the backend
 * nothing and renders without them.
 */
export const passwordPage = ({
  login,
  others,
  changed,
  message,
}: {
  login?: string;
  others?: number;
  changed?: number;
  message?: string;
}): SafeHtml =>
  adminShell({
    title: TEXTS.passwordTitle,
    login,
    body: html`<h1>${TEXTS.passwordHeading}</h1>
      ${changed === undefined ? '' : html`<p>${TEXTS.passwordChanged(changed)}</p>`}
      ${error(message)}
      ${
        others === undefined
          ? ''
          : html`<p class="hint">
              ${others === 0 ? TEXTS.noOtherSessions : TEXTS.passwordRevokesOthers(others)}
            </p>`
      }
      <form class="stack" method="post" action="${PASSWORD_PATH}">
        <label
          >${TEXTS.currentPasswordField}
          <input name="currentPassword" type="password" autocomplete="current-password" required />
        </label>
        <label
          >${TEXTS.newPasswordField}
          <input name="newPassword" type="password" autocomplete="new-password" required />
        </label>
        <label
          >${TEXTS.newPasswordRepeatField}
          <input name="newPasswordRepeat" type="password" autocomplete="new-password" required />
        </label>
        <button type="submit">${TEXTS.passwordSubmit}</button>
      </form>`,
  });

export const sessionsPage = (sessions: readonly StaffSessionView[], login: string): SafeHtml =>
  adminShell({
    title: TEXTS.sessionsTitle,
    active: 'sessions',
    login,
    body: html`<h1>${TEXTS.sessionsHeading}</h1>
      ${
        sessions.length === 0
          ? html`<p>${TEXTS.sessionsEmpty}</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>${TEXTS.columnLogin}</th>
                  <th>${TEXTS.columnName}</th>
                  <th>${TEXTS.columnIp}</th>
                  <th>${TEXTS.columnUserAgent}</th>
                  <th>${TEXTS.columnCreatedAt}</th>
                  <th>${TEXTS.columnLastSeenAt}</th>
                  <th>${TEXTS.columnExpiresAt}</th>
                  <th>${TEXTS.columnAction}</th>
                </tr>
              </thead>
              <tbody>
                ${sessions.map(row)}
              </tbody>
            </table>`
      }`,
  });

// The window in the caption is the one the answer carries, not a constant of this process.
export const overviewPage = (overview: AdminOverview, login: string): SafeHtml =>
  adminShell({
    title: TEXTS.overviewTitle,
    active: 'overview',
    login,
    body: html`<h1>${TEXTS.overviewHeading}</h1>
      <h2>${TEXTS.overviewUsers}</h2>
      <dl>
        <dt>${TEXTS.overviewUsersTotal}</dt>
        <dd>${overview.users.total}</dd>
        <dt>${TEXTS.overviewUsersToday}</dt>
        <dd>${overview.users.today}</dd>
        <dt>${TEXTS.overviewUsersBlocked}</dt>
        <dd>${overview.users.blocked}</dd>
        <dt>${TEXTS.overviewUsersWithActiveAccount}</dt>
        <dd>${overview.users.withActiveBrokerAccount}</dd>
        <dt>${TEXTS.overviewUsersActiveNow}</dt>
        <dd>${overview.users.activeNow}</dd>
      </dl>
      <p class="hint">${TEXTS.overviewActiveNowHint(overview.activeWindowMinutes)}</p>
      <h2>${TEXTS.overviewIntents}</h2>
      <dl>
        <dt>${TEXTS.overviewIntentsTotal}</dt>
        <dd>${overview.intents.total}</dd>
        <dt>${TEXTS.overviewIntentsToday}</dt>
        <dd>${overview.intents.today}</dd>
        <dt>${TEXTS.overviewIntentsActive}</dt>
        <dd>${overview.intents.active}</dd>
      </dl>
      <h3>${TEXTS.overviewIntentsByStatus}</h3>
      <dl>
        ${Object.values(TradeIntentStatus).map(
          (status) =>
            html`<dt>${code(status)}</dt>
              <dd>${overview.intents.byStatus[status]}</dd>`,
        )}
      </dl>
      <p class="hint">
        ${TEXTS.overviewDayStartsAt} ${when(overview.dayStartsAt)}. ${TEXTS.overviewAsOf}
        ${when(overview.asOf)}.
      </p>`,
  });

const userRow = (user: AdminUserListItem): SafeHtml =>
  html`<tr>
    <td><a href="/admin/users/${user.id}">${user.telegramUserId}</a></td>
    <td>${orNone(user.displayName)}</td>
    <td>${TEXTS.userStatus[user.status]}</td>
    <td>${user.tokenBalance}</td>
    <td>${when(user.createdAt)}</td>
    <td>${when(user.updatedAt)}</td>
  </tr>`;

export const usersPage = (
  users: readonly AdminUserListItem[],
  options: {
    q?: string;
    cursor?: string;
    nextCursor: string | null;
    login?: string;
    message?: string;
  },
): SafeHtml =>
  adminShell({
    title: TEXTS.usersTitle,
    active: 'users',
    login: options.login,
    body: html`<h1>${TEXTS.usersHeading}</h1>
      ${error(options.message)}
      <form class="search" method="get" action="/admin/users">
        <label
          >${TEXTS.usersSearchField}
          <input name="q" value="${options.q ?? ''}" autocomplete="off" />
        </label>
        <button type="submit">${TEXTS.usersSearchSubmit}</button>
      </form>
      <p class="hint">${TEXTS.usersSearchHint}</p>
      ${
        users.length === 0
          ? html`<p>${TEXTS.usersEmpty}</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>${TEXTS.columnTelegramId}</th>
                  <th>${TEXTS.columnName}</th>
                  <th>${TEXTS.columnStatus}</th>
                  <th>${TEXTS.columnTokens}</th>
                  <th>${TEXTS.columnUserCreatedAt}</th>
                  <th>${TEXTS.columnUpdatedAt}</th>
                </tr>
              </thead>
              <tbody>
                ${users.map(userRow)}
              </tbody>
            </table>`
      }
      <p class="pager">
        ${
          options.cursor !== undefined || users.length === 0
            ? html`<a href="${usersHref({ q: options.q })}">${TEXTS.usersFirst}</a>`
            : ''
        }
        ${
          options.nextCursor === null
            ? ''
            : html`<a href="${usersHref({ q: options.q, cursor: options.nextCursor })}"
                >${TEXTS.usersNext}</a
              >`
        }
      </p>`,
  });

const accountRow = (account: AdminBrokerAccountView): SafeHtml =>
  html`<tr>
    <td>${account.brokerUserId}</td>
    <td>${orNone(account.email)}</td>
    <td>${yesNo(account.isPartnerClient)}</td>
    <td>${TEXTS.accountStatus[account.status]}</td>
    <td>${orNone(account.authRevokedReason)}</td>
    <td>${yesNo(account.tradingHalted)}</td>
    <td>${orNone(account.haltedReason)}</td>
    <td>${when(account.accessTokenExpiresAt)}</td>
    <td>${whenOrNone(account.tokenRotatedAt)}</td>
    <td>${when(account.createdAt)}</td>
    <td>${when(account.updatedAt)}</td>
  </tr>`;

export const userPage = (
  { user, brokerAccounts, intents, ledger }: Omit<AdminUserResponse, 'me'>,
  login: string,
): SafeHtml =>
  adminShell({
    title: TEXTS.userTitle,
    active: 'users',
    login,
    body: html`<h1>${TEXTS.userTitle} ${user.telegramUserId}</h1>
      <h2>${TEXTS.userMain}</h2>
      <dl>
        <dt>${TEXTS.fieldId}</dt>
        <dd>${user.id}</dd>
        <dt>${TEXTS.columnTelegramId}</dt>
        <dd>${user.telegramUserId}</dd>
        <dt>${TEXTS.columnName}</dt>
        <dd>${orNone(user.displayName)}</dd>
        <dt>${TEXTS.fieldLanguage}</dt>
        <dd>${orNone(user.languageCode)}</dd>
        <dt>${TEXTS.columnStatus}</dt>
        <dd>${TEXTS.userStatus[user.status]}</dd>
        <dt>${TEXTS.fieldAcquisitionSource}</dt>
        <dd>${orNone(user.acquisitionSource)}</dd>
        <dt>${TEXTS.fieldAcquiredAt}</dt>
        <dd>${whenOrNone(user.acquiredAt)}</dd>
        <dt>${TEXTS.fieldTelegramBlockedAt}</dt>
        <dd>${whenOrNone(user.telegramBlockedAt)}</dd>
        <dt>${TEXTS.fieldNotificationLevel}</dt>
        <dd>${TEXTS.notificationLevel[user.notificationLevel]}</dd>
        <dt>${TEXTS.fieldDemoStake}</dt>
        <dd>${user.demoStake ?? TEXTS.demoStakeDefault}</dd>
        <dt>${TEXTS.columnUserCreatedAt}</dt>
        <dd>${when(user.createdAt)}</dd>
        <dt>${TEXTS.columnUpdatedAt}</dt>
        <dd>${when(user.updatedAt)}</dd>
      </dl>
      <h2>${TEXTS.userTokens}</h2>
      <dl>
        <dt>${TEXTS.fieldBalance}</dt>
        <dd>${user.tokens.balance}</dd>
        <dt>${TEXTS.fieldReserved}</dt>
        <dd>${user.tokens.reserved}</dd>
        <dt>${TEXTS.fieldAvailable}</dt>
        <dd>${user.tokens.available}</dd>
      </dl>
      <h2>${TEXTS.userBrokerAccounts}</h2>
      ${
        brokerAccounts.length === 0
          ? html`<p>${TEXTS.userNoAccounts}</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>${TEXTS.columnBrokerUserId}</th>
                  <th>${TEXTS.columnEmail}</th>
                  <th>${TEXTS.columnPartner}</th>
                  <th>${TEXTS.columnStatus}</th>
                  <th>${TEXTS.columnAuthRevokedReason}</th>
                  <th>${TEXTS.columnTradingHalted}</th>
                  <th>${TEXTS.columnHaltedReason}</th>
                  <th>${TEXTS.columnTokenExpiresAt}</th>
                  <th>${TEXTS.columnTokenRotatedAt}</th>
                  <th>${TEXTS.columnUserCreatedAt}</th>
                  <th>${TEXTS.columnUpdatedAt}</th>
                </tr>
              </thead>
              <tbody>
                ${brokerAccounts.map(accountRow)}
              </tbody>
            </table>`
      }
      <h2>${TEXTS.userTrading}</h2>
      <p>${TEXTS.userIntentsCounts(intents.total, intents.active)}</p>
      ${
        intents.recent.length === 0
          ? html`<p>${TEXTS.intentsEmpty}</p>`
          : html`<p class="hint">${TEXTS.userIntentsRecent(ADMIN_USER_RECENT_INTENTS)}</p>
              ${intentsTable(intents.recent)}`
      }
      <p><a href="${intentsHref({ user: user.id })}">${TEXTS.userIntentsAll}</a></p>
      <h2>${TEXTS.userLedger}</h2>
      ${
        ledger.recent.length === 0
          ? html`<p>${TEXTS.tokensEmpty}</p>`
          : html`<p class="hint">${TEXTS.userLedgerRecent(ADMIN_USER_RECENT_LEDGER)}</p>
              ${ledgerTable(ledger.recent)}`
      }
      <p><a href="${tokensHref({ user: user.id })}">${TEXTS.userLedgerAll}</a></p>
      <h2>${TEXTS.userAudit}</h2>
      <p>
        <a href="${auditHref({ entityType: AuditEntityType.User, entityId: user.id })}"
          >${TEXTS.userAuditAll}</a
        >
      </p>`,
  });

/** The intents list URL, through the same serializer as usersHref. */
export const intentsHref = (query: AdminIntentsQuery): string => {
  const params = adminIntentsSearchParams(query);
  return params.size > 0 ? `/admin/intents?${params}` : '/admin/intents';
};

// Statuses, modes and failure reasons are printed as their codes: a Russian label for each would
// be a second copy of the constant, and the reader is support looking things up.
const code = (value: string | null): SafeHtml | string =>
  value === null ? TEXTS.none : html`<code>${value}</code>`;

const option = (value: string, label: string, selected: string | undefined): SafeHtml =>
  html`<option value="${value}" ${value === selected ? html` selected` : ''}>${label}</option>`;

const intentRow = (intent: AdminTradeIntentView): SafeHtml =>
  html`<tr>
    <td><a href="/admin/intents/${intent.id}">${intent.id}</a></td>
    <td><a href="/admin/users/${intent.userId}">${intent.telegramUserId}</a></td>
    <td>${code(intent.mode)}</td>
    <td>${code(intent.status)}</td>
    <td>${code(intent.action)}</td>
    <td>${intent.amount}</td>
    <td>${intent.assetId}</td>
    <td>${intent.durationSec}</td>
    <td>${when(intent.createdAt)}</td>
    <td>${code(intent.lastError)}</td>
  </tr>`;

// The intents table of the list and of the user card's trading section: one set of columns.
const intentsTable = (intents: readonly AdminTradeIntentView[]): SafeHtml =>
  html`<table>
    <thead>
      <tr>
        <th>${TEXTS.columnIntentId}</th>
        <th>${TEXTS.columnTelegramId}</th>
        <th>${TEXTS.columnMode}</th>
        <th>${TEXTS.columnStatus}</th>
        <th>${TEXTS.columnDirection}</th>
        <th>${TEXTS.columnAmount}</th>
        <th>${TEXTS.columnAsset}</th>
        <th>${TEXTS.columnDuration}</th>
        <th>${TEXTS.columnUserCreatedAt}</th>
        <th>${TEXTS.columnLastError}</th>
      </tr>
    </thead>
    <tbody>
      ${intents.map(intentRow)}
    </tbody>
  </table>`;

export const intentsPage = (
  intents: readonly AdminTradeIntentView[],
  options: {
    filters: Omit<AdminIntentsQuery, 'cursor'>;
    cursor?: string;
    nextCursor: string | null;
    login?: string;
    message?: string;
  },
): SafeHtml => {
  const { filters } = options;
  return adminShell({
    title: TEXTS.intentsTitle,
    active: 'intents',
    login: options.login,
    body: html`<h1>${TEXTS.intentsHeading}</h1>
      ${error(options.message)}
      <form class="search" method="get" action="/admin/intents">
        <label
          >${TEXTS.intentsFilterStatus}
          <select name="status">
            ${option('', TEXTS.intentsFilterAny, filters.status ?? '')}
            ${option(ADMIN_INTENTS_ACTIVE_FILTER, TEXTS.intentsActive, filters.status)}
            ${Object.values(TradeIntentStatus).map((s) => option(s, s, filters.status))}
          </select>
        </label>
        <label
          >${TEXTS.intentsFilterMode}
          <select name="mode">
            ${option('', TEXTS.intentsFilterAny, filters.mode ?? '')}
            ${Object.values(TradeMode).map((m) => option(m, m, filters.mode))}
          </select>
        </label>
        <label
          >${TEXTS.intentsFilterUser}
          <input name="user" value="${filters.user ?? ''}" autocomplete="off" />
        </label>
        <label
          >${TEXTS.intentsFilterSession}
          <input name="session" value="${filters.session ?? ''}" autocomplete="off" />
        </label>
        <button type="submit">${TEXTS.intentsFilterSubmit}</button>
      </form>
      <p class="hint">${TEXTS.intentsFilterHint}</p>
      ${intents.length === 0 ? html`<p>${TEXTS.intentsEmpty}</p>` : intentsTable(intents)}
      <p class="pager">
        ${
          options.cursor !== undefined || intents.length === 0
            ? html`<a href="${intentsHref(filters)}">${TEXTS.intentsFirst}</a>`
            : ''
        }
        ${
          options.nextCursor === null
            ? ''
            : html`<a href="${intentsHref({ ...filters, cursor: options.nextCursor })}"
                >${TEXTS.intentsNext}</a
              >`
        }
      </p>`,
  });
};

export const intentPage = (intent: AdminTradeIntentView, login: string): SafeHtml =>
  adminShell({
    title: TEXTS.intentTitle,
    active: 'intents',
    login,
    body: html`<h1>${TEXTS.intentTitle} ${intent.id}</h1>
      <dl>
        <dt>${TEXTS.fieldId}</dt>
        <dd>${intent.id}</dd>
        <dt>${TEXTS.columnStatus}</dt>
        <dd>${code(intent.status)}</dd>
        <dt>${TEXTS.columnMode}</dt>
        <dd>${code(intent.mode)}</dd>
        <dt>${TEXTS.columnDirection}</dt>
        <dd>${code(intent.action)}</dd>
        <dt>${TEXTS.columnAmount}</dt>
        <dd>${intent.amount}</dd>
        <dt>${TEXTS.columnAsset}</dt>
        <dd>${intent.assetId}</dd>
        <dt>${TEXTS.columnDuration}</dt>
        <dd>${intent.durationSec}</dd>
        <dt>${TEXTS.fieldUserId}</dt>
        <dd><a href="/admin/users/${intent.userId}">${intent.userId}</a></dd>
        <dt>${TEXTS.columnTelegramId}</dt>
        <dd>${intent.telegramUserId}</dd>
        <dt>${TEXTS.fieldBrokerAccountId}</dt>
        <dd>${intent.brokerAccountId}</dd>
        <dt>${TEXTS.fieldTradingSessionId}</dt>
        <dd>
          ${
            intent.tradingSessionId === null
              ? TEXTS.none
              : html`${intent.tradingSessionId}
                  <a href="${intentsHref({ session: intent.tradingSessionId })}"
                    >${TEXTS.intentsOfSession}</a
                  >`
          }
        </dd>
        <dt>${TEXTS.fieldClientRequestId}</dt>
        <dd>${intent.clientRequestId}</dd>
        <dt>${TEXTS.fieldVersion}</dt>
        <dd>${intent.version}</dd>
        <dt>${TEXTS.fieldTokensReserved}</dt>
        <dd>${intent.tokensReserved}</dd>
        <dt>${TEXTS.fieldTransport}</dt>
        <dd>${code(intent.transport)}</dd>
        <dt>${TEXTS.columnLastError}</dt>
        <dd>${code(intent.lastError)}</dd>
        <dt>${TEXTS.columnUserCreatedAt}</dt>
        <dd>${when(intent.createdAt)}</dd>
        <dt>${TEXTS.fieldSubmittedAt}</dt>
        <dd>${whenOrNone(intent.submittedAt)}</dd>
        <dt>${TEXTS.fieldReconcileClaimedAt}</dt>
        <dd>${whenOrNone(intent.reconcileClaimedAt)}</dd>
        <dt>${TEXTS.columnUpdatedAt}</dt>
        <dd>${when(intent.updatedAt)}</dd>
      </dl>`,
  });

/** The trading sessions list URL, through the shared serializer as the other lists. */
export const tradingSessionsHref = (query: AdminTradingSessionsQuery): string => {
  const params = adminTradingSessionsSearchParams(query);
  return params.size > 0 ? `/admin/trading-sessions?${params}` : '/admin/trading-sessions';
};

// settings are null when the row does not parse as v1: each of its cells then prints "—"
const tradingSessionRow = (session: AdminTradingSessionView): SafeHtml => {
  const { settings } = session;
  return html`<tr>
    <td>
      ${session.id}
      <a href="${intentsHref({ session: session.id })}">${TEXTS.tradingSessionIntents}</a>
    </td>
    <td><a href="/admin/users/${session.userId}">${session.telegramUserId}</a></td>
    <td>${session.brokerUserId}</td>
    <td>${code(session.mode)}</td>
    <td>${code(session.status)}</td>
    <td>${code(session.stopReason)}</td>
    <td>${settings === null ? TEXTS.none : settings.assetId}</td>
    <td>${settings === null ? TEXTS.none : settings.durationSec}</td>
    <td>${settings === null ? TEXTS.none : settings.trades}</td>
    <td>${settings === null ? TEXTS.none : settings.stake.baseStake}</td>
    <td>${when(session.startedAt)}</td>
    <td>${whenOrNone(session.endedAt)}</td>
    <td>${whenOrNone(session.lastDecisionAt)}</td>
  </tr>`;
};

export const tradingSessionsPage = (
  sessions: readonly AdminTradingSessionView[],
  options: { cursor?: string; nextCursor: string | null; login: string },
): SafeHtml =>
  adminShell({
    title: TEXTS.tradingSessionsTitle,
    active: 'tradingSessions',
    login: options.login,
    body: html`<h1>${TEXTS.tradingSessionsHeading}</h1>
      ${
        sessions.length === 0
          ? html`<p>${TEXTS.tradingSessionsEmpty}</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>${TEXTS.columnSessionId}</th>
                  <th>${TEXTS.columnTelegramId}</th>
                  <th>${TEXTS.columnBrokerUserId}</th>
                  <th>${TEXTS.columnMode}</th>
                  <th>${TEXTS.columnStatus}</th>
                  <th>${TEXTS.columnStopReason}</th>
                  <th>${TEXTS.columnAsset}</th>
                  <th>${TEXTS.columnDuration}</th>
                  <th>${TEXTS.columnTrades}</th>
                  <th>${TEXTS.columnStake}</th>
                  <th>${TEXTS.columnStartedAt}</th>
                  <th>${TEXTS.columnEndedAt}</th>
                  <th>${TEXTS.columnLastDecisionAt}</th>
                </tr>
              </thead>
              <tbody>
                ${sessions.map(tradingSessionRow)}
              </tbody>
            </table>`
      }
      <p class="pager">
        ${
          options.cursor !== undefined || sessions.length === 0
            ? html`<a href="${tradingSessionsHref({})}">${TEXTS.tradingSessionsFirst}</a>`
            : ''
        }
        ${
          options.nextCursor === null
            ? ''
            : html`<a href="${tradingSessionsHref({ cursor: options.nextCursor })}"
                >${TEXTS.tradingSessionsNext}</a
              >`
        }
      </p>`,
  });

/** The token ledger list URL, through the shared serializer as the other lists. */
export const tokensHref = (query: AdminTokensQuery): string => {
  const params = adminTokensSearchParams(query);
  return params.size > 0 ? `/admin/tokens?${params}` : '/admin/tokens';
};

// At most one reference is set (token_ledger_reference_check). Only an intent has a page to link
// to; a deposit and a broker account are printed as their ids.
const ledgerReference = (entry: AdminLedgerEntry): SafeHtml | string => {
  if (entry.intentId !== null) {
    return html`<a href="/admin/intents/${entry.intentId}">${entry.intentId}</a>`;
  }
  if (entry.depositEventId !== null) return code(entry.depositEventId);
  if (entry.brokerAccountId !== null) return code(entry.brokerAccountId);
  if (entry.refType !== null && entry.refId !== null) {
    return code(`${entry.refType}:${entry.refId}`);
  }
  return TEXTS.none;
};

const ledgerRow = (entry: AdminLedgerEntry): SafeHtml =>
  html`<tr>
    <td>${when(entry.createdAt)}</td>
    <td><a href="/admin/users/${entry.userId}">${entry.telegramUserId}</a></td>
    <td>${code(entry.kind)}</td>
    <td class="num">${entry.balanceDelta}</td>
    <td class="num">${entry.reservedDelta}</td>
    <td>${ledgerReference(entry)}</td>
    <td>${orNone(entry.note)}</td>
  </tr>`;

// The ledger table of the list and of the user card's section: one set of columns.
const ledgerTable = (entries: readonly AdminLedgerEntry[]): SafeHtml =>
  html`<table>
    <thead>
      <tr>
        <th>${TEXTS.columnLedgerAt}</th>
        <th>${TEXTS.columnTelegramId}</th>
        <th>${TEXTS.columnKind}</th>
        <th>${TEXTS.columnBalanceDelta}</th>
        <th>${TEXTS.columnReservedDelta}</th>
        <th>${TEXTS.columnReference}</th>
        <th>${TEXTS.columnNote}</th>
      </tr>
    </thead>
    <tbody>
      ${entries.map(ledgerRow)}
    </tbody>
  </table>`;

export const tokensPage = (
  entries: readonly AdminLedgerEntry[],
  options: {
    filters: Omit<AdminTokensQuery, 'cursor'>;
    cursor?: string;
    nextCursor: string | null;
    login?: string;
    message?: string;
  },
): SafeHtml => {
  const { filters } = options;
  return adminShell({
    title: TEXTS.tokensTitle,
    active: 'tokens',
    login: options.login,
    body: html`<h1>${TEXTS.tokensHeading}</h1>
      ${error(options.message)}
      <form class="search" method="get" action="/admin/tokens">
        <label
          >${TEXTS.tokensFilterKind}
          <select name="kind">
            ${option('', TEXTS.tokensFilterAny, filters.kind ?? '')}
            ${Object.values(TokenLedgerKind).map((k) => option(k, k, filters.kind))}
          </select>
        </label>
        <label
          >${TEXTS.tokensFilterUser}
          <input name="user" value="${filters.user ?? ''}" autocomplete="off" />
        </label>
        <button type="submit">${TEXTS.tokensFilterSubmit}</button>
      </form>
      <p class="hint">${TEXTS.tokensFilterHint}</p>
      ${entries.length === 0 ? html`<p>${TEXTS.tokensEmpty}</p>` : ledgerTable(entries)}
      <p class="pager">
        ${
          options.cursor !== undefined || entries.length === 0
            ? html`<a href="${tokensHref(filters)}">${TEXTS.tokensFirst}</a>`
            : ''
        }
        ${
          options.nextCursor === null
            ? ''
            : html`<a href="${tokensHref({ ...filters, cursor: options.nextCursor })}"
                >${TEXTS.tokensNext}</a
              >`
        }
      </p>`,
  });
};

/** The audit log URL, through the shared serializer as the other lists. */
export const auditHref = (query: AdminAuditQuery): string => {
  const params = adminAuditSearchParams(query);
  return params.size > 0 ? `/admin/audit?${params}` : '/admin/audit';
};

// actor_id is free text: only a uuid is something the actor filter accepts, so only a uuid gets
// the "all events" link; anything else ('cli') is printed as it is.
const auditActor = (entry: AdminAuditEntryView): SafeHtml => {
  const name = entry.actorLogin ?? entry.actorId ?? TEXTS.none;
  const link =
    entry.actorId !== null && UUID_PATTERN.test(entry.actorId)
      ? html` <a href="${auditHref({ actorId: entry.actorId })}">${TEXTS.auditActorAll}</a>`
      : '';
  return html`${name} ${code(entry.actorType)}${link}`;
};

// Only a user and an intent have a page; a type without an id links nowhere.
const auditEntity = (entry: AdminAuditEntryView): SafeHtml => {
  const { entityType, entityId } = entry;
  if (entityId !== null && entityType === AuditEntityType.User) {
    return html`${code(entityType)} <a href="/admin/users/${entityId}">${entityId}</a>`;
  }
  if (entityId !== null && entityType === AuditEntityType.TradeIntent) {
    return html`${code(entityType)} <a href="/admin/intents/${entityId}">${entityId}</a>`;
  }
  return html`${code(entityType)} ${orNone(entityId)}`;
};

const auditRow = (entry: AdminAuditEntryView): SafeHtml =>
  html`<tr>
    <td>${when(entry.createdAt)}</td>
    <td>${auditActor(entry)}</td>
    <td>${code(entry.action)}</td>
    <td>${auditEntity(entry)}</td>
    <td class="payload">
      <code class="payload">${entry.payload}</code>${
        entry.payloadTruncated ? html` ${TEXTS.auditPayloadTruncated}` : ''
      }
    </td>
  </tr>`;

export const auditPage = (
  entries: readonly AdminAuditEntryView[],
  options: {
    filters: Omit<AdminAuditQuery, 'cursor'>;
    cursor?: string;
    nextCursor: string | null;
    login?: string;
    message?: string;
  },
): SafeHtml => {
  const { filters } = options;
  const { actorId, ...withoutActor } = filters;
  return adminShell({
    title: TEXTS.auditTitle,
    active: 'audit',
    login: options.login,
    body: html`<h1>${TEXTS.auditHeading}</h1>
      ${error(options.message)}
      <form class="search" method="get" action="/admin/audit">
        <label
          >${TEXTS.auditFilterAction}
          <select name="action">
            ${option('', TEXTS.auditFilterAnyAction, filters.action ?? '')}
            ${Object.values(AuditAction).map((a) => option(a, a, filters.action))}
          </select>
        </label>
        <label
          >${TEXTS.auditFilterEntityType}
          <select name="entityType">
            ${option('', TEXTS.auditFilterAnyEntityType, filters.entityType ?? '')}
            ${Object.values(AuditEntityType).map((t) => option(t, t, filters.entityType))}
          </select>
        </label>
        <label
          >${TEXTS.auditFilterEntityId}
          <input name="entityId" value="${filters.entityId ?? ''}" autocomplete="off" />
        </label>
        <label
          >${TEXTS.auditFilterFrom}
          <input name="from" type="date" value="${filters.from ?? ''}" />
        </label>
        <label
          >${TEXTS.auditFilterTo}
          <input name="to" type="date" value="${filters.to ?? ''}" />
        </label>
        ${
          actorId === undefined
            ? ''
            : html`<input type="hidden" name="actorId" value="${actorId}" />`
        }
        <button type="submit">${TEXTS.auditFilterSubmit}</button>
      </form>
      ${
        actorId === undefined
          ? ''
          : html`<p>
              ${TEXTS.auditActorFilter(actorId)} —
              <a href="${auditHref(withoutActor)}">${TEXTS.auditActorReset}</a>
            </p>`
      }
      <p class="hint">${TEXTS.auditFilterHint}</p>
      ${
        entries.length === 0
          ? html`<p>${TEXTS.auditEmpty}</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>${TEXTS.columnAuditAt}</th>
                  <th>${TEXTS.columnActor}</th>
                  <th>${TEXTS.columnAuditAction}</th>
                  <th>${TEXTS.columnEntity}</th>
                  <th>${TEXTS.columnPayload}</th>
                </tr>
              </thead>
              <tbody>
                ${entries.map(auditRow)}
              </tbody>
            </table>`
      }
      <p class="pager">
        ${
          options.cursor !== undefined || entries.length === 0
            ? html`<a href="${auditHref(filters)}">${TEXTS.auditFirst}</a>`
            : ''
        }
        ${
          options.nextCursor === null
            ? ''
            : html`<a href="${auditHref({ ...filters, cursor: options.nextCursor })}"
                >${TEXTS.auditNext}</a
              >`
        }
      </p>`,
  });
};

// --- Bot texts (#300, docs/admin-pages.md → Bot texts) -----------------------------------------

export const BOT_TEXTS_PATH = '/admin/bot-texts';
export type BotTextsNotice = keyof typeof TEXTS.botTextsNotice;
export type BotTextNotice = keyof typeof TEXTS.botTextNotice;

export const botTextsHref = (notice?: BotTextsNotice): string =>
  notice === undefined ? BOT_TEXTS_PATH : `${BOT_TEXTS_PATH}?${new URLSearchParams({ notice })}`;
// the key is a catalog key or matches BOT_TEXT_KEY_PATTERN: [a-zA-Z0-9] only, nothing to encode
export const botTextHref = (key: string, notice?: BotTextNotice): string =>
  notice === undefined
    ? `${BOT_TEXTS_PATH}/${key}`
    : `${BOT_TEXTS_PATH}/${key}?${new URLSearchParams({ notice })}`;

const notice = (text: string | undefined): SafeHtml | string =>
  text === undefined ? '' : html`<p class="notice">${text}</p>`;

const changedState = (row: {
  version: number;
  updatedAt: string;
  updatedByLogin: string | null;
}): SafeHtml =>
  html`${TEXTS.botTextChanged(row.version, row.updatedByLogin)} ${when(row.updatedAt)}`;

const rejected = (reason: string | null): SafeHtml | string =>
  reason === null ? '' : html`<p class="error">${TEXTS.botTextRejected(reason)}</p>`;

const orphanRow = (row: AdminBotTextOverrideView): SafeHtml =>
  html`<tr>
    <td>${code(row.key)}</td>
    <td class="num">${row.version}</td>
    <td>${when(row.updatedAt)}</td>
    <td>${row.updatedByLogin ?? 'CLI'}</td>
    <td>
      <form method="post" action="${BOT_TEXTS_PATH}/${row.key}/reset">
        <input type="hidden" name="version" value="${row.version}" />
        <button type="submit">${TEXTS.botTextDelete}</button>
      </form>
    </td>
  </tr>`;

export const botTextsPage = (
  overrides: readonly AdminBotTextOverrideView[],
  { login, notice: shown }: { login: string; notice?: BotTextsNotice },
): SafeHtml => {
  const byKey = new Map(overrides.map((row) => [row.key, row]));
  const orphans = overrides.filter((row) => !Object.hasOwn(BOT_TEXT_CATALOG, row.key));
  return adminShell({
    title: TEXTS.botTextsTitle,
    active: 'botTexts',
    login,
    body: html`<h1>${TEXTS.botTextsHeading}</h1>
      ${notice(shown === undefined ? undefined : TEXTS.botTextsNotice[shown])}
      ${Object.values(BotTextGroup).map(
        (group) =>
          html`<h2>${BOT_TEXT_GROUP_TITLES[group]}</h2>
            ${
              ADMIN_BOT_TEXT_READ_ONLY_GROUPS.includes(group)
                ? html`<p class="hint">${TEXTS.botTextReadOnly}</p>`
                : ''
            }
            <table>
              <thead>
                <tr>
                  <th>${TEXTS.columnBotTextKey}</th>
                  <th>${TEXTS.columnBotTextDescription}</th>
                  <th>${TEXTS.columnBotTextState}</th>
                </tr>
              </thead>
              <tbody>
                ${botTextKeysOf(group).map((key) => {
                  const row = byKey.get(key);
                  return html`<tr>
                    <td><a href="${botTextHref(key)}">${key}</a></td>
                    <td>${BOT_TEXT_CATALOG[key].description}</td>
                    <td>
                      ${row === undefined ? TEXTS.botTextDefault : changedState(row)}
                      ${rejected(row?.rejection ?? null)}
                    </td>
                  </tr>`;
                })}
              </tbody>
            </table>`,
      )}
      ${
        orphans.length === 0
          ? ''
          : html`<h2>${TEXTS.botTextOrphansHeading}</h2>
              <p class="hint">${TEXTS.botTextOrphansHint}</p>
              <table>
                <thead>
                  <tr>
                    <th>${TEXTS.columnBotTextKey}</th>
                    <th>${TEXTS.columnBotTextVersion}</th>
                    <th>${TEXTS.columnLastSeenAt}</th>
                    <th>${TEXTS.columnLogin}</th>
                    <th>${TEXTS.columnAction}</th>
                  </tr>
                </thead>
                <tbody>
                  ${orphans.map(orphanRow)}
                </tbody>
              </table>`
      }`,
  });
};

const hostsOf = (key: BotTextKey): BotTextKey[] =>
  (Object.keys(BOT_TEXT_CATALOG) as BotTextKey[]).filter((host) =>
    Object.values(BOT_TEXT_CATALOG[host].fragments).includes(key),
  );

/**
 * Everything the editor reads from the catalog entry: the argument, the fragments, the limit, the
 * hosts. #358 widens it to the user's and the system's variables.
 */
export const placeholderHints = (text: AdminBotTextView): SafeHtml => {
  const key = text.key as BotTextKey;
  const entry = BOT_TEXT_CATALOG[key];
  const hosts = hostsOf(key);
  const items = [
    ...(entry.arg === undefined
      ? []
      : [html`<li>${TEXTS.botTextArg(entry.arg, entry.sample ?? '')}</li>`]),
    ...text.fragments.map(
      (fragment) =>
        html`<li>
          ${`{${fragment.placeholder}}`} —
          <a href="${botTextHref(fragment.key)}">${fragment.key}</a>: ${code(fragment.source)}
          ${fragment.overridden ? TEXTS.botTextFragmentChanged : ''}
        </li>`,
    ),
  ];
  return html`<h2>${TEXTS.botTextPlaceholders}</h2>
    ${
      items.length === 0
        ? html`<p class="hint">${TEXTS.botTextNoPlaceholders}</p>`
        : html`<ul>
            ${items}
          </ul>`
    }
    <p class="hint">${TEXTS.botTextLimit(entry.limit, entry.singleLine)}</p>
    ${
      hosts.length === 0
        ? ''
        : html`<p class="hint">
            ${TEXTS.botTextUsedIn}
            ${hosts.map((host, index) => html`${index === 0 ? '' : ', '}<a href="${botTextHref(host)}">${host}</a>`)}
          </p>`
    }`;
};

export interface BotTextPageOptions {
  login?: string;
  notice?: BotTextNotice;
  // what the staff member submitted; stays in the field
  draft?: string;
  problems?: readonly AdminBotTextProblem[];
  conflict?: { currentVersion: number; currentSource: string };
  message?: string;
}

// The textarea's content starts with a line feed: the HTML parser drops exactly one right after
// the opening tag, so a text that itself starts with one keeps it.
export const botTextPage = (text: AdminBotTextView, options: BotTextPageOptions): SafeHtml => {
  const key = text.key as BotTextKey;
  const entry = BOT_TEXT_CATALOG[key];
  const { override } = text;
  const editable = isAdminBotTextEditable(key);
  const version = options.conflict?.currentVersion ?? override?.version ?? 0;
  const value = options.draft ?? override?.source ?? entry.source;
  return adminShell({
    title: `${TEXTS.botTextsTitle}: ${key}`,
    active: 'botTexts',
    login: options.login,
    body: html`<h1>${key}</h1>
      <p class="hint">${BOT_TEXT_GROUP_TITLES[entry.group]} — ${entry.description}</p>
      <p>${override === null ? TEXTS.botTextDefault : changedState(override)}</p>
      ${rejected(text.rejection)}
      ${notice(options.notice === undefined ? undefined : TEXTS.botTextNotice[options.notice])}
      ${error(options.message)}
      ${
        options.conflict === undefined
          ? ''
          : html`<p class="error">${TEXTS.botTextConflict(options.conflict.currentVersion)}</p>
              <details open>
                <summary>${TEXTS.botTextCurrent}</summary>
                <pre>${options.conflict.currentSource}</pre>
              </details>`
      }
      ${
        options.problems === undefined
          ? ''
          : html`<ul class="error">
              ${options.problems.map(
                (problem) =>
                  html`<li>${problem.key === key ? '' : `${problem.key}: `}${problem.reason}</li>`,
              )}
            </ul>`
      }
      ${placeholderHints(text)}
      ${
        editable
          ? html`<form class="editor" method="post" action="${botTextHref(key)}/save">
                <label for="source">${TEXTS.botTextSourceField}</label>
                <textarea id="source" name="source" maxlength="${BOT_TEXT_SOURCE_MAX}" rows="12">
${value}</textarea>
                <input type="hidden" name="version" value="${version}" />
                <div class="buttons">
                  <button type="submit" formaction="${botTextHref(key)}/preview">
                    ${TEXTS.botTextPreviewSubmit}
                  </button>
                  <button type="submit">${TEXTS.botTextSaveSubmit}</button>
                </div>
              </form>
              ${
                override !== null && override.source === entry.source
                  ? html`<p class="hint">${TEXTS.botTextSameAsDefault}</p>`
                  : ''
              }`
          : html`<p class="hint">${TEXTS.botTextReadOnly}</p>
              <pre>${value}</pre>`
      }
      ${
        override === null
          ? ''
          : html`<details>
                <summary>${TEXTS.botTextDefaultSource}</summary>
                <pre>${entry.source}</pre>
              </details>
              ${
                editable
                  ? html`<form method="post" action="${botTextHref(key)}/reset">
                      <input type="hidden" name="version" value="${version}" />
                      <button type="submit">${TEXTS.botTextResetSubmit}</button>
                    </form>`
                  : ''
              }`
      }`,
  });
};
