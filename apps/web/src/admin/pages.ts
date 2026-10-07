import {
  adminUsersSearchParams,
  type AdminBrokerAccountView,
  type AdminOverview,
  type AdminUserDetail,
  type AdminUserListItem,
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
export type AdminNavKey = 'overview' | 'users' | 'sessions';

const NAV: readonly { key: AdminNavKey; href: string; label: string }[] = [
  { key: 'overview', href: '/admin/overview', label: TEXTS.navOverview },
  { key: 'users', href: '/admin/users', label: TEXTS.navUsers },
  { key: 'sessions', href: '/admin/sessions', label: TEXTS.navSessions },
];

/**
 * Every page behind a staff session. `login` comes only from the `me` of the backend answer the
 * page was built from; a page rendered without asking the backend (a refused search) has no
 * login, and the account block is left out rather than invented.
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
            : html`<form method="post" action="/admin/logout">
                <button type="submit">${login} — ${TEXTS.logoutSubmit}</button>
              </form>`
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
  user: AdminUserDetail,
  brokerAccounts: readonly AdminBrokerAccountView[],
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
      }`,
  });
