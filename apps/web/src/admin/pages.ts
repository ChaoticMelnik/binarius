import type { StaffSessionView } from '@binarius/shared';
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

export const sessionsPage = (sessions: readonly StaffSessionView[], login: string): SafeHtml =>
  layout({
    title: TEXTS.sessionsTitle,
    body: html`<div class="bar">
        <h1>${TEXTS.sessionsHeading}</h1>
        <form method="post" action="/admin/logout">
          <button type="submit">${login} — ${TEXTS.logoutSubmit}</button>
        </form>
      </div>
      ${sessions.length === 0
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
          </table>`}`,
  });
