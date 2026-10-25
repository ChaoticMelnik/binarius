import {
  ServiceAccountNotWorkingReason,
  BOT_TEXT_CATALOG,
  BOT_TEXT_DEFAULT_SOURCES,
  BOT_TEXT_VARS,
  BOT_TEXT_GROUP_TITLES,
  BOT_TEXT_SOURCE_MAX,
  BotLanguage,
  BotTextGroup,
  BotTextKind,
  botProfileMethodsOf,
  botTextKeysOf,
  type AdminBotProfileMethodResult,
  type AdminBotTextOverrideView,
  type AdminBotTextProblem,
  type AdminBotTextRendered,
  type AdminBotTextView,
  type BotTextKey,
  type BotTextVarName,
  ADMIN_INTENTS_ACTIVE_FILTER,
  ADMIN_USER_RECENT_INTENTS,
  ADMIN_USER_RECENT_LEDGER,
  adminAuditSearchParams,
  adminBrokerAccountsSearchParams,
  adminDepositsSearchParams,
  adminIntentsSearchParams,
  adminTokensSearchParams,
  adminTradingSessionsSearchParams,
  adminStarRefundsSearchParams,
  adminUsersSearchParams,
  AuditAction,
  AuditEntityType,
  BrokerAccountStatus,
  DepositEventStatus,
  STAR_REFUND_REASON_MAX,
  StarPaymentStatus,
  TOKEN_ADJUSTMENT_MAX_TOKENS,
  TOKEN_LEDGER_NOTE_MAX,
  TokenLedgerKind,
  TradeIntentStatus,
  TradeMode,
  UUID_PATTERN,
  type AdminAuditEntryView,
  type AdminAuditQuery,
  type AdminBrokerAccountListItem,
  type AdminBrokerAccountsQuery,
  type AdminBrokerAccountView,
  type AdminServiceAccountsResponse,
  type AdminServiceAccountView,
  type AdminStarPaymentView,
  type AdminStarRefundRequestItem,
  type AdminStarRefundsQuery,
  type AdminDepositsQuery,
  type AdminDepositView,
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
  type TradingSessionStatus,
  type UserStatus,
} from '@binarius/shared';
import { html, layout, type SafeHtml } from '../html';
import { icon, iconSprite, type IconName } from './icons';
import { encodePublishResults } from './publish-result';
import { ADMIN_SCRIPT_PATH, ADMIN_STYLESHEET_PATH } from './static';
import { telegramPreview } from './telegram-preview';
import { sessionLengthLabel, TEXTS } from './texts';

const error = (message: string | undefined): SafeHtml =>
  message === undefined ? html`` : html`<p class="error">${message}</p>`;

// Every admin page, the sign-in ones included (#459): the design system's stylesheet, the theme
// script in <head> (synchronous, so a stored theme applies before the first paint) and `no-js`,
// which that script removes. The page builds its own <main>.
const adminLayout = ({
  title,
  body,
  bodyClass,
}: {
  title: string;
  body: SafeHtml;
  bodyClass?: string;
}): SafeHtml =>
  layout({
    title,
    body,
    bodyClass,
    stylesheet: ADMIN_STYLESHEET_PATH,
    head: html`<script src="${ADMIN_SCRIPT_PATH}"></script>`,
    rootClass: 'no-js',
    wrapMain: false,
  });

// Hidden until the script runs (`no-js`); the script shows the icon of the current choice.
const themeToggle = (): SafeHtml =>
  html`<button
    type="button"
    class="icon-btn no-js-hidden"
    data-theme-toggle
    data-label-system="${TEXTS.themeSystem}"
    data-label-dark="${TEXTS.themeDark}"
    data-label-light="${TEXTS.themeLight}"
    aria-label="${TEXTS.themeSystem}"
  >
    ${icon('monitor', html`data-theme-icon="system"`)}${icon('moon', html`data-theme-icon="dark" hidden`)}${icon('sun', html`data-theme-icon="light" hidden`)}
  </button>`;

// The pages without a staff session: sign-in, and the notices of the admin routes.
const authShell = ({ title, body }: { title: string; body: SafeHtml }): SafeHtml =>
  adminLayout({
    title,
    bodyClass: 'auth',
    body: html`<a class="skip-link" href="#main">${TEXTS.skipToContent}</a>
      ${iconSprite()}
      <main id="main" class="auth-main">
        <div class="card auth-card">
          <span class="brand">${TEXTS.brand}</span>
          ${body}
        </div>
        <div class="auth-tools">${themeToggle()}</div>
      </main>`,
  });

/** An error or notice of an /admin route, in the design system; `noticePage` stays for the rest. */
export const adminNoticePage = (title: string, body: string): SafeHtml =>
  authShell({
    title,
    body: html`<h1>${title}</h1>
      <p>${body}</p>`,
  });

export const loginPage = (message?: string): SafeHtml =>
  authShell({
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
  authShell({
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

// The page a login link from the staff bot opens (#448). The form has no `action`: it posts back
// to the link's own path, which is the only place the token is — it never sits in the page body.
// GET renders this and spends nothing; the POST behind the button is what creates the session.
export const linkPage = (message?: string): SafeHtml =>
  authShell({
    title: TEXTS.linkTitle,
    body: html`<h1>${TEXTS.linkTitle}</h1>
      <p>${TEXTS.linkBody}</p>
      ${error(message)}
      <form class="stack" method="post">
        <button type="submit">${TEXTS.linkSubmit}</button>
      </form>`,
  });

// The timestamps are rendered as the backend sent them. Formatting them for a locale would be
// this process guessing a timezone; the ISO instant is unambiguous, which matters most for the
// column an operator reads to decide whether a session is theirs.
const when = (iso: string): SafeHtml => html`<time datetime="${iso}">${iso}</time>`;

const SESSION_COLUMNS: readonly Column[] = [
  { label: TEXTS.columnLogin },
  { label: TEXTS.columnName },
  { label: TEXTS.columnIp },
  { label: TEXTS.columnUserAgent, className: 'agent wrap' },
  { label: TEXTS.columnCreatedAt },
  { label: TEXTS.columnLastSeenAt },
  { label: TEXTS.columnExpiresAt },
  { label: TEXTS.columnAction },
];

const sessionCells = (session: StaffSessionView): Cell[] => [
  html`${session.login}${session.current ? html` (${TEXTS.currentSession})` : ''}`,
  session.displayName ?? TEXTS.noDisplayName,
  session.ip,
  session.userAgent,
  when(session.createdAt),
  when(session.lastSeenAt),
  when(session.expiresAt),
  html`<form method="post" action="/admin/sessions/${session.id}/revoke">
    <button type="submit" class="btn btn-danger">${TEXTS.revokeSubmit}</button>
  </form>`,
];

const whenOrNone = (iso: string | null): SafeHtml | string =>
  iso === null ? TEXTS.none : when(iso);
const orNone = (value: string | null): string => value ?? TEXTS.none;
const yesNo = (value: boolean): string => (value ? TEXTS.yes : TEXTS.no);

// --- The list components (#656, docs/admin-design-system.md → Table and row card) ---------------

type Cell = SafeHtml | string | number;

/** `label` is both the `<th>` and every cell's `data-label`; an empty one gets no `data-label`. */
interface Column {
  label: string;
  num?: boolean;
  className?: string;
}

const cell = (column: Column, value: Cell): SafeHtml => {
  const classes = [column.num === true ? 'num' : '', column.className ?? '']
    .filter((name) => name !== '')
    .join(' ');
  return html`<td${column.label === '' ? '' : html` data-label="${column.label}"`}${
    classes === '' ? '' : html` class="${classes}"`
  }>${value}</td>`;
};

// Below 64rem the CSS reads every row as a card, each cell under its data-label; at any width a
// table wider than the content column scrolls inside .table-wrap, never the page.
const table = (
  columns: readonly Column[],
  rows: readonly (readonly Cell[])[],
  rowClass?: (index: number) => string | undefined,
): SafeHtml =>
  html`<div class="table-wrap"><table class="table"><thead><tr>${columns.map(
    (column) => html`<th>${column.label}</th>`,
  )}</tr></thead><tbody>${rows.map((cells, index) => {
    const className = rowClass?.(index);
    return html`<tr${className === undefined ? '' : html` class="${className}"`}>${cells.map(
      (value, at) => cell(columns[at] ?? { label: '' }, value),
    )}</tr>`;
  })}</tbody></table></div>`;

type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

// The status keeps its text or its code; the badge only colours it.
const badge = (variant: BadgeVariant, body: Cell): SafeHtml =>
  html`<span class="badge badge-${variant}">${body}</span>`;

const USER_STATUS_BADGE = {
  active: 'success',
  blocked: 'danger',
} as const satisfies Record<UserStatus, BadgeVariant>;

const INTENT_STATUS_BADGE = {
  planned: 'info',
  reserved: 'info',
  queued: 'info',
  submitting: 'info',
  accepted: 'info',
  reconciling: 'info',
  settled: 'success',
  rejected: 'danger',
  unknown: 'warning',
  manual_review: 'warning',
} as const satisfies Record<TradeIntentStatus, BadgeVariant>;

const TRADING_SESSION_STATUS_BADGE = {
  active: 'success',
  paused: 'warning',
  stopped: 'neutral',
} as const satisfies Record<TradingSessionStatus, BadgeVariant>;

const ACCOUNT_STATUS_BADGE = {
  active: 'success',
  pending: 'warning',
  revoked: 'danger',
} as const satisfies Record<BrokerAccountStatus, BadgeVariant>;

const DEPOSIT_STATUS_BADGE = {
  received: 'info',
  credited: 'success',
  ignored: 'neutral',
  failed: 'danger',
} as const satisfies Record<DepositEventStatus, BadgeVariant>;

const STAR_PAYMENT_STATUS_BADGE = {
  paid: 'success',
  held: 'warning',
  refunded: 'neutral',
} as const satisfies Record<StarPaymentStatus, BadgeVariant>;

const empty = (text: string): SafeHtml => html`<p class="empty">${text}</p>`;

// Hidden without the script (no-js) and, by the script, without navigator.clipboard: the id
// beside it stays selectable either way.
const copyButton = (value: string): SafeHtml =>
  html`<button type="button" class="icon-btn copy no-js-hidden" data-copy="${value}" aria-label="${TEXTS.copy}" data-label-copy="${TEXTS.copy}" data-label-copied="${TEXTS.copied}">${icon('copy', html`data-copy-icon="copy"`)}${icon('check', html`data-copy-icon="check" hidden`)}</button>`;

const idCode = (value: string): SafeHtml => html`<code>${value}</code>${copyButton(value)}`;

const idCodeOrNone = (value: string | null): SafeHtml | string =>
  value === null ? TEXTS.none : idCode(value);

export const SERVICE_ACCOUNTS_PATH = '/admin/service-accounts';
export const STAR_REFUNDS_PATH = '/admin/star-refunds';

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
  | 'botTexts'
  | 'deposits'
  | 'brokerAccounts'
  | 'serviceAccounts'
  | 'starRefunds';

const NAV: readonly { key: AdminNavKey; href: string; label: string; icon: IconName }[] = [
  { key: 'overview', href: '/admin/overview', label: TEXTS.navOverview, icon: 'layout-dashboard' },
  { key: 'users', href: '/admin/users', label: TEXTS.navUsers, icon: 'users' },
  { key: 'sessions', href: '/admin/sessions', label: TEXTS.navSessions, icon: 'key-round' },
  { key: 'intents', href: '/admin/intents', label: TEXTS.navIntents, icon: 'activity' },
  {
    key: 'tradingSessions',
    href: '/admin/trading-sessions',
    label: TEXTS.navTradingSessions,
    icon: 'repeat',
  },
  { key: 'tokens', href: '/admin/tokens', label: TEXTS.navTokens, icon: 'coins' },
  { key: 'audit', href: '/admin/audit', label: TEXTS.navAudit, icon: 'scroll-text' },
  {
    key: 'botTexts',
    href: '/admin/bot-texts',
    label: TEXTS.navBotTexts,
    icon: 'message-square-text',
  },
  { key: 'deposits', href: '/admin/deposits', label: TEXTS.navDeposits, icon: 'wallet' },
  {
    key: 'brokerAccounts',
    href: '/admin/broker-accounts',
    label: TEXTS.navBrokerAccounts,
    icon: 'briefcase',
  },
  {
    key: 'serviceAccounts',
    href: SERVICE_ACCOUNTS_PATH,
    label: TEXTS.navServiceAccounts,
    icon: 'server',
  },
  { key: 'starRefunds', href: STAR_REFUNDS_PATH, label: TEXTS.navStarRefunds, icon: 'star' },
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
  adminLayout({
    title,
    body: html`<a class="skip-link" href="#main">${TEXTS.skipToContent}</a>
      ${iconSprite()}
      <div class="shell">
        <nav id="nav" class="sidebar" popover aria-label="${TEXTS.navLabel}">
          <div class="sidebar-head">
            <span class="brand">${TEXTS.brand}</span>
            <button
              type="button"
              class="icon-btn sidebar-close"
              popovertarget="nav"
              popovertargetaction="hide"
              aria-label="${TEXTS.menuClose}"
            >
              ${icon('x')}
            </button>
          </div>
          ${NAV.map(
            (item) =>
              html`<a href="${item.href}" ${item.key === active ? html` aria-current="page"` : ''}
                >${icon(item.icon)}${item.label}</a
              >`,
          )}
        </nav>
        <div class="content">
          <header class="topbar">
            <button
              type="button"
              class="icon-btn burger"
              popovertarget="nav"
              aria-controls="nav"
              aria-label="${TEXTS.menuOpen}"
            >
              ${icon('menu')}
            </button>
            <div class="topbar-actions">
              ${themeToggle()}
              ${
                login === undefined
                  ? ''
                  : html`<span class="login">${login}</span>
                      <a href="${PASSWORD_PATH}">${TEXTS.passwordLink}</a>
                      <form method="post" action="/admin/logout">
                        <button type="submit" class="btn btn-secondary">
                          ${icon('log-out')}${TEXTS.logoutSubmit}
                        </button>
                      </form>`
              }
            </div>
          </header>
          <main id="main" class="page">${body}</main>
        </div>
      </div>`,
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
          ? empty(TEXTS.sessionsEmpty)
          : table(SESSION_COLUMNS, sessions.map(sessionCells), (index) =>
              sessions[index]?.current === true ? 'current' : undefined,
            )
      }`,
  });

// The window in the caption is the one the answer carries, not a constant of this process.
const metric = (label: SafeHtml | string, value: number): SafeHtml =>
  html`<div class="metric">
    <dt>${label}</dt>
    <dd>${value}</dd>
  </div>`;

export const overviewPage = (overview: AdminOverview, login: string): SafeHtml =>
  adminShell({
    title: TEXTS.overviewTitle,
    active: 'overview',
    login,
    body: html`<h1>${TEXTS.overviewHeading}</h1>
      <section class="section">
        <h2>${TEXTS.overviewUsers}</h2>
        <dl class="metrics">
          ${metric(TEXTS.overviewUsersTotal, overview.users.total)}
          ${metric(TEXTS.overviewUsersToday, overview.users.today)}
          ${metric(TEXTS.overviewUsersBlocked, overview.users.blocked)}
          ${metric(TEXTS.overviewUsersWithActiveAccount, overview.users.withActiveBrokerAccount)}
          ${metric(TEXTS.overviewUsersActiveNow, overview.users.activeNow)}
        </dl>
        <p class="hint">${TEXTS.overviewActiveNowHint(overview.activeWindowMinutes)}</p>
      </section>
      <section class="section">
        <h2>${TEXTS.overviewIntents}</h2>
        <dl class="metrics">
          ${metric(TEXTS.overviewIntentsTotal, overview.intents.total)}
          ${metric(TEXTS.overviewIntentsToday, overview.intents.today)}
          ${metric(TEXTS.overviewIntentsActive, overview.intents.active)}
        </dl>
        <h3>${TEXTS.overviewIntentsByStatus}</h3>
        <dl class="metrics metrics-dense">
          ${Object.values(TradeIntentStatus).map((status) =>
            metric(code(status), overview.intents.byStatus[status]),
          )}
        </dl>
        <p class="hint">
          ${TEXTS.overviewDayStartsAt} ${when(overview.dayStartsAt)}. ${TEXTS.overviewAsOf}
          ${when(overview.asOf)}.
        </p>
      </section>`,
  });

const USER_COLUMNS: readonly Column[] = [
  { label: TEXTS.columnTelegramId },
  { label: TEXTS.columnName },
  { label: TEXTS.columnStatus },
  { label: TEXTS.columnTokens, num: true },
  { label: TEXTS.columnUserCreatedAt },
  { label: TEXTS.columnUpdatedAt },
];

const userStatus = (status: UserStatus): SafeHtml =>
  badge(USER_STATUS_BADGE[status], TEXTS.userStatus[status]);

const userCells = (user: AdminUserListItem): Cell[] => [
  html`<a href="/admin/users/${user.id}">${user.telegramUserId}</a>`,
  orNone(user.displayName),
  userStatus(user.status),
  user.tokenBalance,
  when(user.createdAt),
  when(user.updatedAt),
];

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
      ${users.length === 0 ? empty(TEXTS.usersEmpty) : table(USER_COLUMNS, users.map(userCells))}
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

// --- Service accounts (#391, docs/service-accounts.md) -------------------------------------------

// The one form that marks or unmarks: the card, the list and the service page each post it with
// their own path to come back to.
const serviceMarkForm = (accountId: string, service: boolean, returnPath: string): SafeHtml =>
  html`<form method="post" action="/admin/broker-accounts/${accountId}/service">
    <input type="hidden" name="service" value="${service ? 'on' : 'off'}" />
    <input type="hidden" name="return" value="${returnPath}" />
    <button type="submit" class="btn btn-secondary">${service ? TEXTS.serviceMark : TEXTS.serviceUnmark}</button>
  </form>`;

// The H1 mark's form (#745): the service mark's shape, its own route
const h1MarkForm = (accountId: string, h1: boolean, returnPath: string): SafeHtml =>
  html`<form method="post" action="/admin/broker-accounts/${accountId}/h1">
    <input type="hidden" name="h1" value="${h1 ? 'on' : 'off'}" />
    <input type="hidden" name="return" value="${returnPath}" />
    <button type="submit" class="btn btn-secondary">${h1 ? TEXTS.h1Mark : TEXTS.h1Unmark}</button>
  </form>`;

// The accounts table of the list (#342, with the owner column) and of the user card (without it):
// one set of columns. The account id is the uuid the ledger's «Основание» and the intent card print.
const brokerAccountsTable = <T extends AdminBrokerAccountView>(
  accounts: readonly T[],
  returnPath: string,
  owner?: (account: T) => SafeHtml,
): SafeHtml =>
  table(
    [
      ...(owner === undefined ? [] : [{ label: TEXTS.columnTelegramId }]),
      { label: TEXTS.columnAccountId },
      { label: TEXTS.columnBrokerUserId },
      { label: TEXTS.columnEmail },
      { label: TEXTS.columnPartner },
      { label: TEXTS.columnStatus },
      { label: TEXTS.columnAuthRevokedReason },
      { label: TEXTS.columnTradingHalted },
      { label: TEXTS.columnHaltedReason },
      { label: TEXTS.columnTokenExpiresAt },
      { label: TEXTS.columnTokenRotatedAt },
      { label: TEXTS.columnService },
      { label: TEXTS.columnH1 },
      { label: TEXTS.columnUserCreatedAt },
      { label: TEXTS.columnUpdatedAt },
    ],
    accounts.map((account) => [
      ...(owner === undefined ? [] : [owner(account)]),
      idCode(account.id),
      account.brokerUserId,
      orNone(account.email),
      yesNo(account.isPartnerClient),
      badge(ACCOUNT_STATUS_BADGE[account.status], TEXTS.accountStatus[account.status]),
      orNone(account.authRevokedReason),
      yesNo(account.tradingHalted),
      orNone(account.haltedReason),
      when(account.accessTokenExpiresAt),
      whenOrNone(account.tokenRotatedAt),
      account.serviceSince === null
        ? serviceMarkForm(account.id, true, returnPath)
        : html`${when(account.serviceSince)} ${serviceMarkForm(account.id, false, returnPath)}`,
      account.h1Since === null
        ? h1MarkForm(account.id, true, returnPath)
        : html`${when(account.h1Since)} ${h1MarkForm(account.id, false, returnPath)}`,
      when(account.createdAt),
      when(account.updatedAt),
    ]),
  );

// «Вернуть Stars» (#510): only on a payment that can still be refunded
const starRefundForm = (paymentId: string, returnPath: string): SafeHtml =>
  html`<form class="stack" method="post" action="/admin/star-payments/${paymentId}/refund">
    <input type="hidden" name="return" value="${returnPath}" />
    <label
      >${TEXTS.starRefundReason}
      <input name="reason" maxlength="${STAR_REFUND_REASON_MAX}" required />
    </label>
    <button type="submit" class="btn btn-secondary">${TEXTS.starRefundSubmit}</button>
  </form>`;

// The Stars payments of the user card and of the requests page (with the owner column): one set
// of columns. The payer is who gets the Stars back, a forwarded invoice's payer included.
const starPaymentsTable = <T extends AdminStarPaymentView>(
  payments: readonly T[],
  returnPath: string,
  owner?: (payment: T) => SafeHtml,
): SafeHtml =>
  table(
    [
      ...(owner === undefined ? [] : [{ label: TEXTS.columnUser }]),
      { label: TEXTS.columnChargeId },
      { label: TEXTS.columnPayer },
      { label: TEXTS.columnPackage },
      { label: TEXTS.columnStars, num: true },
      { label: TEXTS.columnTokens, num: true },
      { label: TEXTS.columnStatus },
      { label: TEXTS.columnPaidAt },
      { label: TEXTS.columnRefundedAt },
      { label: TEXTS.columnRequestedAt },
      { label: TEXTS.columnRefund },
    ],
    payments.map((payment) => [
      ...(owner === undefined ? [] : [owner(payment)]),
      idCode(payment.telegramPaymentChargeId),
      payment.payerTelegramUserId,
      payment.packageCode,
      payment.totalAmount,
      orNone(payment.tokens),
      badge(STAR_PAYMENT_STATUS_BADGE[payment.status], TEXTS.starPaymentStatus[payment.status]),
      when(payment.paidAt),
      whenOrNone(payment.refundedAt),
      whenOrNone(payment.requestedAt),
      payment.status === StarPaymentStatus.Refunded
        ? TEXTS.none
        : starRefundForm(payment.id, returnPath),
    ]),
  );

/** What the staff member submitted, put back into the form after a refusal (#246). */
export interface TokenAdjustmentForm {
  direction: 'credit' | 'debit';
  amount: string;
  note: string;
}

export interface UserPageOptions {
  notice?: keyof typeof TEXTS.userNotice;
  adjustment?: { message: string; form?: TokenAdjustmentForm };
}

// The hidden balance is the one this page shows: the backend refuses when it moved (#246 В4). A
// 409 page carries the balance of the answer it was built from, on purpose.
const tokenAdjustmentForm = (
  user: AdminUserResponse['user'],
  { notice, adjustment }: UserPageOptions,
): SafeHtml => {
  const form = adjustment?.form;
  const debit = form?.direction === 'debit';
  return html`<h3>${TEXTS.userAdjustHeading}</h3>
    ${notice === 'adjusted' ? html`<p class="notice">${TEXTS.userNotice[notice]}</p>` : ''}
    ${error(adjustment?.message)}
    <form class="stack" method="post" action="/admin/users/${user.id}/tokens">
      <input type="hidden" name="balance" value="${user.tokens.balance}" />
      <fieldset>
        <legend>${TEXTS.userAdjustDirection}</legend>
        <label class="choice"
          ><input type="radio" name="direction" value="credit" ${debit ? '' : html`checked`} />
          ${TEXTS.userAdjustCredit}</label
        >
        <label class="choice"
          ><input type="radio" name="direction" value="debit" ${debit ? html`checked` : ''} />
          ${TEXTS.userAdjustDebit}</label
        >
      </fieldset>
      <label
        >${TEXTS.userAdjustAmount(TOKEN_ADJUSTMENT_MAX_TOKENS)}
        <input
          type="number"
          name="amount"
          min="1"
          max="${TOKEN_ADJUSTMENT_MAX_TOKENS}"
          step="1"
          value="${form?.amount ?? ''}"
          required
        />
      </label>
      <label
        >${TEXTS.userAdjustNote}
        <input
          name="note"
          maxlength="${TOKEN_LEDGER_NOTE_MAX}"
          value="${form?.note ?? ''}"
          required
        />
      </label>
      <button type="submit">${TEXTS.userAdjustSubmit}</button>
    </form>`;
};

export const userPage = (
  { user, brokerAccounts, intents, ledger, deposits, starPayments }: Omit<AdminUserResponse, 'me'>,
  login: string,
  options: UserPageOptions = {},
): SafeHtml =>
  adminShell({
    title: TEXTS.userTitle,
    active: 'users',
    login,
    body: html`<h1>${TEXTS.userTitle} ${user.telegramUserId}</h1>
      <section class="section">
        <h2>${TEXTS.userMain}</h2>
        <dl class="props">
          <dt>${TEXTS.fieldId}</dt>
          <dd>${idCode(user.id)}</dd>
          <dt>${TEXTS.columnTelegramId}</dt>
          <dd>${user.telegramUserId}</dd>
          <dt>${TEXTS.columnName}</dt>
          <dd>${orNone(user.displayName)}</dd>
          <dt>${TEXTS.fieldLanguage}</dt>
          <dd>${orNone(user.languageCode)}</dd>
          <dt>${TEXTS.fieldBotLanguage}</dt>
          <dd>${TEXTS.botLanguage[user.language]}</dd>
          <dt>${TEXTS.columnStatus}</dt>
          <dd>${userStatus(user.status)}</dd>
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
          <dt>${TEXTS.fieldRealStake}</dt>
          <dd>${user.realStake ?? TEXTS.demoStakeDefault}</dd>
          <dt>${TEXTS.columnUserCreatedAt}</dt>
          <dd>${when(user.createdAt)}</dd>
          <dt>${TEXTS.columnUpdatedAt}</dt>
          <dd>${when(user.updatedAt)}</dd>
        </dl>
      </section>
      <section class="section">
        <h2>${TEXTS.userTokens}</h2>
        <dl class="props">
          <dt>${TEXTS.fieldBalance}</dt>
          <dd>${user.tokens.balance}</dd>
          <dt>${TEXTS.fieldReserved}</dt>
          <dd>${user.tokens.reserved}</dd>
          <dt>${TEXTS.fieldAvailable}</dt>
          <dd>${user.tokens.available}</dd>
        </dl>
        ${tokenAdjustmentForm(user, options)}
      </section>
      <section class="section">
        <h2>${TEXTS.userBrokerAccounts}</h2>
        ${
          brokerAccounts.length === 0
            ? empty(TEXTS.brokerAccountsEmpty)
            : brokerAccountsTable(brokerAccounts, `/admin/users/${user.id}`)
        }
      </section>
      <section class="section">
        <h2>${TEXTS.userTrading}</h2>
        <p>${TEXTS.userIntentsCounts(intents.total, intents.active)}</p>
        ${
          intents.recent.length === 0
            ? empty(TEXTS.intentsEmpty)
            : html`<p class="hint">${TEXTS.userIntentsRecent(ADMIN_USER_RECENT_INTENTS)}</p>
                ${intentsTable(intents.recent)}`
        }
        <p><a href="${intentsHref({ user: user.id })}">${TEXTS.userIntentsAll}</a></p>
      </section>
      <section class="section">
        <h2>${TEXTS.userLedger}</h2>
        ${
          ledger.recent.length === 0
            ? empty(TEXTS.tokensEmpty)
            : html`<p class="hint">${TEXTS.userLedgerRecent(ADMIN_USER_RECENT_LEDGER)}</p>
                ${ledgerTable(ledger.recent)}`
        }
        <p><a href="${tokensHref({ user: user.id })}">${TEXTS.userLedgerAll}</a></p>
      </section>
      <section class="section">
        <h2>${TEXTS.userDeposits}</h2>
        ${
          deposits.recent.length === 0
            ? empty(TEXTS.depositsEmpty)
            : html`<p class="hint">${TEXTS.userDepositsRecent(ADMIN_USER_RECENT_LEDGER)}</p>
                ${depositsTable(deposits.recent)}`
        }
        <p><a href="${depositsHref({ user: user.id })}">${TEXTS.userDepositsAll}</a></p>
      </section>
      <section class="section">
        <h2>${TEXTS.userStarPayments}</h2>
        ${
          options.notice === 'refunded' || options.notice === 'refundRecorded'
            ? html`<p class="notice">${TEXTS.starRefundNotice[options.notice]}</p>`
            : ''
        }
        ${
          starPayments.recent.length === 0
            ? empty(TEXTS.starPaymentsEmpty)
            : html`<p class="hint">${TEXTS.userStarPaymentsRecent(ADMIN_USER_RECENT_LEDGER)}</p>
                ${starPaymentsTable(starPayments.recent, `/admin/users/${user.id}`)}`
        }
      </section>
      <section class="section">
        <h2>${TEXTS.userAudit}</h2>
        <p>
          <a href="${auditHref({ entityType: AuditEntityType.User, entityId: user.id })}"
            >${TEXTS.userAuditAll}</a
          >
        </p>
      </section>`,
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

const intentStatus = (status: TradeIntentStatus): SafeHtml =>
  badge(INTENT_STATUS_BADGE[status], code(status));

// The intents table of the list and of the user card's trading section: one set of columns.
const intentsTable = (intents: readonly AdminTradeIntentView[]): SafeHtml =>
  table(
    [
      { label: TEXTS.columnIntentId },
      { label: TEXTS.columnTelegramId },
      { label: TEXTS.columnMode },
      { label: TEXTS.columnStatus },
      { label: TEXTS.columnDirection },
      { label: TEXTS.columnAmount, num: true },
      { label: TEXTS.columnAsset },
      { label: TEXTS.columnDuration, num: true },
      { label: TEXTS.columnUserCreatedAt },
      { label: TEXTS.columnLastError },
    ],
    intents.map((intent) => [
      html`<a href="/admin/intents/${intent.id}">${intent.id}</a>`,
      html`<a href="/admin/users/${intent.userId}">${intent.telegramUserId}</a>`,
      code(intent.mode),
      intentStatus(intent.status),
      code(intent.action),
      intent.amount,
      intent.assetId,
      intent.durationSec,
      when(intent.createdAt),
      code(intent.lastError),
    ]),
  );

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
      ${intents.length === 0 ? empty(TEXTS.intentsEmpty) : intentsTable(intents)}
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
      <dl class="props">
        <dt>${TEXTS.fieldId}</dt>
        <dd>${idCode(intent.id)}</dd>
        <dt>${TEXTS.columnStatus}</dt>
        <dd>${intentStatus(intent.status)}</dd>
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
        <dd>
          <a href="/admin/users/${intent.userId}">${intent.userId}</a>${copyButton(intent.userId)}
        </dd>
        <dt>${TEXTS.columnTelegramId}</dt>
        <dd>${intent.telegramUserId}</dd>
        <dt>${TEXTS.fieldBrokerAccountId}</dt>
        <dd>${idCode(intent.brokerAccountId)}</dd>
        <dt>${TEXTS.fieldTradingSessionId}</dt>
        <dd>
          ${
            intent.tradingSessionId === null
              ? TEXTS.none
              : html`${idCode(intent.tradingSessionId)}
                  <a href="${intentsHref({ session: intent.tradingSessionId })}"
                    >${TEXTS.intentsOfSession}</a
                  >`
          }
        </dd>
        <dt>${TEXTS.fieldClientRequestId}</dt>
        <dd>${idCode(intent.clientRequestId)}</dd>
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

const TRADING_SESSION_COLUMNS: readonly Column[] = [
  { label: TEXTS.columnSessionId },
  { label: TEXTS.columnTelegramId },
  { label: TEXTS.columnBrokerUserId },
  { label: TEXTS.columnMode },
  { label: TEXTS.columnStatus },
  { label: TEXTS.columnStopReason },
  { label: TEXTS.columnAsset },
  { label: TEXTS.columnDuration, num: true },
  { label: TEXTS.columnLength },
  { label: TEXTS.columnStake, num: true },
  { label: TEXTS.columnStartedAt },
  { label: TEXTS.columnEndedAt },
  { label: TEXTS.columnLastDecisionAt },
];

// settings are null when the row parses as no version: each of its cells then prints "—"
const tradingSessionCells = (session: AdminTradingSessionView): Cell[] => {
  const { settings } = session;
  return [
    html`${session.id}
      <a href="${intentsHref({ session: session.id })}">${TEXTS.tradingSessionIntents}</a>`,
    html`<a href="/admin/users/${session.userId}">${session.telegramUserId}</a>`,
    session.brokerUserId,
    code(session.mode),
    badge(TRADING_SESSION_STATUS_BADGE[session.status], code(session.status)),
    code(session.stopReason),
    settings === null ? TEXTS.none : settings.assetId,
    settings === null ? TEXTS.none : settings.durationSec,
    settings === null ? TEXTS.none : sessionLengthLabel(settings),
    settings === null ? TEXTS.none : settings.stake.baseStake,
    when(session.startedAt),
    whenOrNone(session.endedAt),
    whenOrNone(session.lastDecisionAt),
  ];
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
          ? empty(TEXTS.tradingSessionsEmpty)
          : table(TRADING_SESSION_COLUMNS, sessions.map(tradingSessionCells))
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

/** The requests list URL (#510), through the shared serializer as the other lists. */
export const starRefundsHref = (query: AdminStarRefundsQuery): string => {
  const params = adminStarRefundsSearchParams(query);
  return params.size > 0 ? `${STAR_REFUNDS_PATH}?${params}` : STAR_REFUNDS_PATH;
};

export const starRefundsPage = (
  requests: readonly AdminStarRefundRequestItem[],
  options: {
    cursor?: string;
    nextCursor: string | null;
    login: string;
    notice?: keyof typeof TEXTS.starRefundNotice;
  },
): SafeHtml =>
  adminShell({
    title: TEXTS.starRefundsTitle,
    active: 'starRefunds',
    login: options.login,
    body: html`<h1>${TEXTS.starRefundsHeading}</h1>
      ${
        options.notice === undefined
          ? ''
          : html`<p class="notice">${TEXTS.starRefundNotice[options.notice]}</p>`
      }
      <p class="hint">${TEXTS.starRefundsHint}</p>
      ${
        requests.length === 0
          ? empty(TEXTS.starRefundsEmpty)
          : starPaymentsTable(
              requests,
              STAR_REFUNDS_PATH,
              (request) => html`<a href="/admin/users/${request.userId}">${request.userId}</a>`,
            )
      }
      <p class="pager">
        ${
          options.cursor !== undefined || requests.length === 0
            ? html`<a href="${starRefundsHref({})}">${TEXTS.starRefundsFirst}</a>`
            : ''
        }
        ${
          options.nextCursor === null
            ? ''
            : html`<a href="${starRefundsHref({ cursor: options.nextCursor })}"
                >${TEXTS.starRefundsNext}</a
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
// to; a deposit, a broker account, a Stars payment and a referral (#116) are printed as their ids.
const ledgerReference = (entry: AdminLedgerEntry): SafeHtml | string => {
  if (entry.intentId !== null) {
    return html`<a href="/admin/intents/${entry.intentId}">${entry.intentId}</a>`;
  }
  if (entry.depositEventId !== null) return idCode(entry.depositEventId);
  if (entry.brokerAccountId !== null) return idCode(entry.brokerAccountId);
  if (entry.starPaymentId !== null) return idCode(entry.starPaymentId);
  if (entry.referralId !== null) return idCode(entry.referralId);
  if (entry.refType !== null && entry.refId !== null) {
    return idCode(`${entry.refType}:${entry.refId}`);
  }
  return TEXTS.none;
};

// The ledger table of the list and of the user card's section: one set of columns.
const ledgerTable = (entries: readonly AdminLedgerEntry[]): SafeHtml =>
  table(
    [
      { label: TEXTS.columnLedgerAt },
      { label: TEXTS.columnTelegramId },
      { label: TEXTS.columnKind },
      { label: TEXTS.columnBalanceDelta, num: true },
      { label: TEXTS.columnReservedDelta, num: true },
      { label: TEXTS.columnReference },
      { label: TEXTS.columnNote, className: 'wrap' },
    ],
    entries.map((entry) => [
      when(entry.createdAt),
      html`<a href="/admin/users/${entry.userId}">${entry.telegramUserId}</a>`,
      code(entry.kind),
      entry.balanceDelta,
      entry.reservedDelta,
      ledgerReference(entry),
      orNone(entry.note),
    ]),
  );

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
      ${entries.length === 0 ? empty(TEXTS.tokensEmpty) : ledgerTable(entries)}
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

// --- Deposits (#341, docs/admin-pages.md → Deposits) --------------------------------------------

/** The deposits list URL, through the shared serializer as the other lists. */
export const depositsHref = (query: AdminDepositsQuery): string => {
  const params = adminDepositsSearchParams(query);
  return params.size > 0 ? `/admin/deposits?${params}` : '/admin/deposits';
};

// The owner is user_id alone: a deposit that names only an account has no owner to link to, and
// the account has no page (its id is the next column).
const depositOwner = (deposit: AdminDepositView): SafeHtml | string =>
  deposit.userId === null || deposit.telegramUserId === null
    ? TEXTS.none
    : html`<a href="/admin/users/${deposit.userId}">${deposit.telegramUserId}</a>`;

// The deposits table of the list and of the user card's section: one set of columns.
const depositsTable = (deposits: readonly AdminDepositView[]): SafeHtml =>
  table(
    [
      { label: TEXTS.columnDepositAt },
      { label: TEXTS.columnTelegramId },
      { label: TEXTS.columnAccountId },
      { label: TEXTS.columnTraderId },
      { label: TEXTS.columnPaymentId },
      { label: TEXTS.columnAmount, num: true },
      { label: TEXTS.columnCurrency },
      { label: TEXTS.columnStatus },
      { label: TEXTS.columnProcessedAt },
    ],
    deposits.map((deposit) => [
      when(deposit.createdAt),
      depositOwner(deposit),
      idCodeOrNone(deposit.brokerAccountId),
      code(deposit.brokerUserId),
      idCode(deposit.paymentId),
      deposit.amount,
      orNone(deposit.currency),
      badge(DEPOSIT_STATUS_BADGE[deposit.status], code(deposit.status)),
      whenOrNone(deposit.processedAt),
    ]),
  );

export const depositsPage = (
  deposits: readonly AdminDepositView[],
  options: {
    filters: Omit<AdminDepositsQuery, 'cursor'>;
    cursor?: string;
    nextCursor: string | null;
    login?: string;
    message?: string;
  },
): SafeHtml => {
  const { filters } = options;
  return adminShell({
    title: TEXTS.depositsTitle,
    active: 'deposits',
    login: options.login,
    body: html`<h1>${TEXTS.depositsHeading}</h1>
      ${error(options.message)}
      <form class="search" method="get" action="/admin/deposits">
        <label
          >${TEXTS.depositsFilterStatus}
          <select name="status">
            ${option('', TEXTS.depositsFilterAny, filters.status ?? '')}
            ${Object.values(DepositEventStatus).map((s) => option(s, s, filters.status))}
          </select>
        </label>
        <label
          >${TEXTS.depositsFilterUser}
          <input name="user" value="${filters.user ?? ''}" autocomplete="off" />
        </label>
        <button type="submit">${TEXTS.depositsFilterSubmit}</button>
      </form>
      <p class="hint">${TEXTS.depositsFilterHint}</p>
      ${deposits.length === 0 ? empty(TEXTS.depositsEmpty) : depositsTable(deposits)}
      <p class="pager">
        ${
          options.cursor !== undefined || deposits.length === 0
            ? html`<a href="${depositsHref(filters)}">${TEXTS.depositsFirst}</a>`
            : ''
        }
        ${
          options.nextCursor === null
            ? ''
            : html`<a href="${depositsHref({ ...filters, cursor: options.nextCursor })}"
                >${TEXTS.depositsNext}</a
              >`
        }
      </p>`,
  });
};

// --- Broker accounts (#342, docs/admin-pages.md → Broker accounts) -----------------------------

/** The broker accounts list URL, through the shared serializer as the other lists. */
export const brokerAccountsHref = (query: AdminBrokerAccountsQuery): string => {
  const params = adminBrokerAccountsSearchParams(query);
  return params.size > 0 ? `/admin/broker-accounts?${params}` : '/admin/broker-accounts';
};

export const brokerAccountsPage = (
  accounts: readonly AdminBrokerAccountListItem[],
  options: {
    filters: Omit<AdminBrokerAccountsQuery, 'cursor'>;
    cursor?: string;
    nextCursor: string | null;
    login?: string;
    message?: string;
  },
): SafeHtml => {
  const { filters } = options;
  return adminShell({
    title: TEXTS.brokerAccountsTitle,
    active: 'brokerAccounts',
    login: options.login,
    body: html`<h1>${TEXTS.brokerAccountsHeading}</h1>
      ${error(options.message)}
      <form class="search" method="get" action="/admin/broker-accounts">
        <label
          >${TEXTS.brokerAccountsFilterStatus}
          <select name="status">
            ${option('', TEXTS.brokerAccountsFilterAny, filters.status ?? '')}
            ${Object.values(BrokerAccountStatus).map((s) =>
              option(s, TEXTS.accountStatus[s], filters.status),
            )}
          </select>
        </label>
        <label
          ><input
            type="checkbox"
            name="halted"
            value="true"
            ${filters.halted === undefined ? '' : html` checked`}
          />
          ${TEXTS.brokerAccountsFilterHalted}</label
        >
        <button type="submit">${TEXTS.brokerAccountsFilterSubmit}</button>
      </form>
      <p class="hint">${TEXTS.brokerAccountsFilterHint}</p>
      ${
        accounts.length === 0
          ? empty(TEXTS.brokerAccountsEmpty)
          : brokerAccountsTable(
              accounts,
              '/admin/broker-accounts',
              (account) =>
                html`<a href="/admin/users/${account.userId}">${account.telegramUserId}</a>`,
            )
      }
      <p class="pager">
        ${
          options.cursor !== undefined || accounts.length === 0
            ? html`<a href="${brokerAccountsHref(filters)}">${TEXTS.brokerAccountsFirst}</a>`
            : ''
        }
        ${
          options.nextCursor === null
            ? ''
            : html`<a href="${brokerAccountsHref({ ...filters, cursor: options.nextCursor })}"
                >${TEXTS.brokerAccountsNext}</a
              >`
        }
      </p>`,
  });
};

// «нет: отозван (refresh_outcome_unknown)»: the revocation's own reason is the one detail that
// tells a failed exchange from a user's re-login to wait for
const notWorkingLabel = (account: AdminServiceAccountView): string => {
  if (account.notWorkingReason === null) return TEXTS.serviceWorking;
  const label = TEXTS.serviceReason[account.notWorkingReason];
  return TEXTS.serviceNotWorking(
    account.notWorkingReason === ServiceAccountNotWorkingReason.Revoked &&
      account.authRevokedReason !== null
      ? `${label} (${account.authRevokedReason})`
      : label,
  );
};

export const serviceAccountsPage = ({
  me,
  min,
  working,
  accounts,
}: AdminServiceAccountsResponse): SafeHtml =>
  adminShell({
    title: TEXTS.serviceAccountsTitle,
    active: 'serviceAccounts',
    login: me.login,
    body: html`<h1>${TEXTS.serviceAccountsHeading}</h1>
      <p class="counter">${TEXTS.serviceAccountsCounter(working, min, accounts.length)}</p>
      <p class="hint">${TEXTS.serviceAccountsHint}</p>
      ${
        accounts.length === 0
          ? html`<p>${TEXTS.serviceAccountsEmpty}</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>${TEXTS.columnEmail}</th>
                  <th>${TEXTS.columnBrokerUserId}</th>
                  <th>${TEXTS.columnTelegramId}</th>
                  <th>${TEXTS.columnStatus}</th>
                  <th>${TEXTS.columnWorking}</th>
                  <th>${TEXTS.columnTokenExpiresAt}</th>
                  <th>${TEXTS.columnTokenRotatedAt}</th>
                  <th>${TEXTS.columnServiceSince}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${accounts.map(
                  (account) =>
                    html`<tr>
                      <td>${orNone(account.email)}</td>
                      <td>${account.brokerUserId}</td>
                      <td>
                        <a href="/admin/users/${account.userId}">${account.telegramUserId}</a>
                      </td>
                      <td>${TEXTS.accountStatus[account.status]}</td>
                      <td>${notWorkingLabel(account)}</td>
                      <td>${when(account.accessTokenExpiresAt)}</td>
                      <td>${whenOrNone(account.tokenRotatedAt)}</td>
                      <td>${whenOrNone(account.serviceSince)}</td>
                      <td>${serviceMarkForm(account.id, false, SERVICE_ACCOUNTS_PATH)}</td>
                    </tr>`,
                )}
              </tbody>
            </table>`
      }`,
  });

// --- Bot texts (#300, docs/admin-pages.md → Bot texts) -----------------------------------------

export const BOT_TEXTS_PATH = '/admin/bot-texts';
export type BotTextsNotice = keyof typeof TEXTS.botTextsNotice;
export type BotTextNotice = keyof typeof TEXTS.botTextNotice;

// Russian is the page without `lang`, so the URLs from before #634 stay the Russian pages.
const withQuery = (
  path: string,
  language: BotLanguage,
  notice: string | undefined,
  published: readonly AdminBotProfileMethodResult[] | undefined,
): string => {
  const query = new URLSearchParams();
  if (language !== BotLanguage.Ru) query.set('lang', language);
  if (notice !== undefined) query.set('notice', notice);
  if (notice !== undefined && published !== undefined) {
    query.set('publish', encodePublishResults(published));
  }
  const search = query.toString();
  return search === '' ? path : `${path}?${search}`;
};
export const botTextsHref = (
  language: BotLanguage,
  notice?: BotTextsNotice,
  published?: readonly AdminBotProfileMethodResult[],
): string => withQuery(BOT_TEXTS_PATH, language, notice, published);
// the key is a catalog key or matches BOT_TEXT_KEY_PATTERN: [a-zA-Z0-9] only, nothing to encode
const botTextPath = (key: string): string => `${BOT_TEXTS_PATH}/${key}`;
export const botTextHref = (
  language: BotLanguage,
  key: string,
  notice?: BotTextNotice,
  published?: readonly AdminBotProfileMethodResult[],
): string => withQuery(botTextPath(key), language, notice, published);

// the language of a form's text, as a hidden field: the action URLs carry no query
const languageField = (language: BotLanguage): SafeHtml =>
  html`<input type="hidden" name="language" value="${language}" />`;

// both languages, the one shown without a link
const languageSwitch = (language: BotLanguage, hrefOf: (other: BotLanguage) => string) =>
  html`<p class="hint">
    ${TEXTS.botTextLanguage}
    ${Object.values(BotLanguage).map(
      (other, index) =>
        html`${index === 0 ? '' : ' · '}${
          other === language
            ? html`<b>✅ ${TEXTS.botLanguage[other]}</b>`
            : html`<a href="${hrefOf(other)}">${TEXTS.botLanguage[other]}</a>`
        }`,
    )}
  </p>`;

const publishesProfile = (key: BotTextKey): boolean => botProfileMethodsOf(key).length > 0;

// one line a method sent; a failure by name and code only (rule 8)
const publishBlock = (published: readonly AdminBotProfileMethodResult[] | undefined) =>
  published === undefined || published.length === 0
    ? ''
    : html`<ul class="publish">
          ${published.map((result) =>
            result.ok
              ? html`<li>
                  ${TEXTS.botProfileMethod[result.method]} (${result.method}):
                  ${TEXTS.botProfilePublished}
                </li>`
              : html`<li class="error">
                  ${TEXTS.botProfileMethod[result.method]} (${result.method}):
                  ${TEXTS.botProfileFailed(
                    result.err.name,
                    result.err.code,
                    result.telegramErrorCode,
                    result.language,
                  )}
                </li>`,
          )}
        </ul>
        ${
          published.some((result) => !result.ok)
            ? html`<p class="error">${TEXTS.botProfilePublishFailedHint}</p>`
            : ''
        }`;

const republishForm = (action: string, language: BotLanguage): SafeHtml =>
  html`<form method="post" action="${action}">
    ${languageField(language)}
    <button type="submit">${TEXTS.botProfileRepublish}</button>
  </form>`;

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
      <form method="post" action="${botTextPath(row.key)}/reset">
        ${languageField(row.language)}
        <input type="hidden" name="version" value="${row.version}" />
        <button type="submit">${TEXTS.botTextDelete}</button>
      </form>
    </td>
  </tr>`;

// the state of `language`'s texts; the other language's rows are not shown
export const botTextsPage = (
  overrides: readonly AdminBotTextOverrideView[],
  {
    language,
    login,
    notice: shown,
    published,
  }: {
    language: BotLanguage;
    login: string;
    notice?: BotTextsNotice;
    published?: readonly AdminBotProfileMethodResult[];
  },
): SafeHtml => {
  const rows = overrides.filter((row) => row.language === language);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const orphans = rows.filter((row) => !Object.hasOwn(BOT_TEXT_CATALOG, row.key));
  // the hint and the button once, above the first group whose texts are published
  const firstPublished = Object.values(BotTextGroup).find((group) =>
    botTextKeysOf(group).some(publishesProfile),
  );
  return adminShell({
    title: TEXTS.botTextsTitle,
    active: 'botTexts',
    login,
    body: html`<h1>${TEXTS.botTextsHeading}</h1>
      ${languageSwitch(language, (other) => botTextsHref(other))}
      ${notice(shown === undefined ? undefined : TEXTS.botTextsNotice[shown])}
      ${publishBlock(published)}
      ${Object.values(BotTextGroup).map(
        (group) =>
          html`${
              group === firstPublished
                ? html`<p class="hint">${TEXTS.botProfileHint}</p>
                    ${republishForm(`${BOT_TEXTS_PATH}/publish`, language)}`
                : ''
            }
            <h2>${BOT_TEXT_GROUP_TITLES[group]}</h2>
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
                    <td><a href="${botTextHref(language, key)}">${key}</a></td>
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
 * Everything the editor reads from the catalog entry: the variables of the key with their
 * descriptions and samples from the registry (#358), the fragments, the limit, the hosts.
 */
export const placeholderHints = (text: AdminBotTextView): SafeHtml => {
  const key = text.key as BotTextKey;
  const entry = BOT_TEXT_CATALOG[key];
  const hosts = hostsOf(key);
  const items = [
    ...(entry.vars as readonly BotTextVarName[]).map((name) => {
      const { description, sample } = BOT_TEXT_VARS[name];
      return html`<li>${TEXTS.botTextVariable(name, description, sample)}</li>`;
    }),
    ...text.fragments.map(
      (fragment) =>
        html`<li>
          ${`{${fragment.placeholder}}`} —
          <a href="${botTextHref(text.language, fragment.key)}">${fragment.key}</a>:
          ${code(fragment.source)} ${fragment.overridden ? TEXTS.botTextFragmentChanged : ''}
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
            ${hosts.map((host, index) => html`${index === 0 ? '' : ', '}<a href="${botTextHref(text.language, host)}">${host}</a>`)}
          </p>`
    }`;
};

const previewBlock = (rendered: AdminBotTextRendered): SafeHtml => {
  const content =
    rendered.kind === BotTextKind.Html
      ? telegramPreview(rendered.telegramHtml)
      : html`<span class="tg-label">${rendered.text}</span>`;
  return html`<h2>${TEXTS.botTextPreviewHeading}</h2>
    <div class="tg-bubble">${content}</div>
    <p class="hint">${TEXTS.botTextPreviewHint}</p>`;
};

export interface BotTextPageOptions {
  login?: string;
  notice?: BotTextNotice;
  // what the staff member submitted; stays in the field
  draft?: string;
  // the version the staff member opened the text at: the one the form submitted
  version?: number;
  rendered?: AdminBotTextRendered;
  problems?: readonly AdminBotTextProblem[];
  conflict?: { currentVersion: number; currentSource: string };
  published?: readonly AdminBotProfileMethodResult[];
}

// The textarea's content starts with a line feed: the HTML parser drops exactly one right after
// the opening tag, so a text that itself starts with one keeps it.
export const botTextPage = (text: AdminBotTextView, options: BotTextPageOptions): SafeHtml => {
  const key = text.key as BotTextKey;
  const entry = BOT_TEXT_CATALOG[key];
  const { language, override } = text;
  const defaultSource = BOT_TEXT_DEFAULT_SOURCES[language].sourceOf(key);
  const publishes = publishesProfile(key);
  // A page after a POST belongs to the editing session opened on the submitted version; the
  // fresher one the backend read for it would void the optimistic check (#373 M1). Only the 409
  // page moves to the current version, on purpose.
  const version = options.conflict?.currentVersion ?? options.version ?? override?.version ?? 0;
  const value = options.draft ?? override?.source ?? defaultSource;
  return adminShell({
    title: `${TEXTS.botTextsTitle}: ${key}`,
    active: 'botTexts',
    login: options.login,
    body: html`<h1>${key}</h1>
      <p class="hint">${BOT_TEXT_GROUP_TITLES[entry.group]} — ${entry.description}</p>
      ${languageSwitch(language, (other) => botTextHref(other, key))}
      <p>${override === null ? TEXTS.botTextDefault : changedState(override)}</p>
      ${rejected(text.rejection)}
      ${notice(options.notice === undefined ? undefined : TEXTS.botTextNotice[options.notice])}
      ${publishBlock(options.published)}
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
        publishes
          ? html`<p class="hint">
              ${
                entry.group === BotTextGroup.Commands
                  ? TEXTS.botProfileCommandHint
                  : TEXTS.botProfileProfileHint
              }
            </p>`
          : ''
      }
      <form class="editor" method="post" action="${botTextPath(key)}/save">
        ${languageField(language)}
        <label for="source">${TEXTS.botTextSourceField}</label>
        <textarea id="source" name="source" maxlength="${BOT_TEXT_SOURCE_MAX}" rows="12">
${value}</textarea>
        <input type="hidden" name="version" value="${version}" />
        <div class="buttons">
          <button type="submit" formaction="${botTextPath(key)}/preview">
            ${TEXTS.botTextPreviewSubmit}
          </button>
          <button type="submit">${TEXTS.botTextSaveSubmit}</button>
        </div>
      </form>
      ${
        override !== null && override.source === defaultSource
          ? html`<p class="hint">${TEXTS.botTextSameAsDefault}</p>`
          : ''
      }
      ${options.rendered === undefined ? '' : previewBlock(options.rendered)}
      ${
        override === null
          ? ''
          : html`<details>
                <summary>${TEXTS.botTextDefaultSource}</summary>
                <pre>${defaultSource}</pre>
              </details>
              <form method="post" action="${botTextPath(key)}/reset">
                ${languageField(language)}
                <input type="hidden" name="version" value="${version}" />
                <button type="submit">${TEXTS.botTextResetSubmit}</button>
              </form>`
      }
      ${publishes ? republishForm(`${botTextPath(key)}/publish`, language) : ''}`,
  });
};
