import { html, layout, type SafeHtml } from '../html';
import { TELEGRAM_SDK_URL } from '../mini-app';
import { CASHIER_TEXTS } from './texts';

export const CASHIER_PAGE_PATH = '/cashier';
export const CASHIER_SCRIPT_PATH = '/cashier/static/app.js';
export const CASHIER_SESSION_PATH = '/cashier/session';
export const CASHIER_CREDITED_PATH = '/cashier/credited';

// Every state the page can show instead of the widget; docs/deposit.md -> The page has the row
// that leads to each.
export const CashierState = {
  OpenFromTelegram: 'open_from_telegram',
  Busy: 'busy',
  Unavailable: 'unavailable',
  Rejected: 'rejected',
  DemoOnly: 'demo_only',
  ConnectFirst: 'connect_first',
  Ambiguous: 'ambiguous',
  Blocked: 'blocked',
  Relogin: 'relogin',
} as const;
export type CashierState = (typeof CashierState)[keyof typeof CashierState];

// the outcome of POST /cashier/session that carries a session instead of naming a state
export const CASHIER_READY = 'ready';

// the states a second try may change; every other one says what to do instead
export const CASHIER_RETRY_STATES: readonly CashierState[] = [
  CashierState.Busy,
  CashierState.Unavailable,
];

const STATE_TEXTS: Record<CashierState, string> = {
  open_from_telegram: CASHIER_TEXTS.openFromTelegram,
  busy: CASHIER_TEXTS.busy,
  unavailable: CASHIER_TEXTS.unavailable,
  rejected: CASHIER_TEXTS.rejected,
  demo_only: CASHIER_TEXTS.demoOnly,
  connect_first: CASHIER_TEXTS.connectFirst,
  ambiguous: CASHIER_TEXTS.ambiguous,
  blocked: CASHIER_TEXTS.blocked,
  relogin: CASHIER_TEXTS.relogin,
};

// What the page says above the widget after the widget's own events (#112): a notice, not a
// state, because the widget stays on screen. The event's own message is never shown.
export const CashierNotice = {
  Credited: 'credited',
  WidgetError: 'widget_error',
} as const;
export type CashierNotice = (typeof CashierNotice)[keyof typeof CashierNotice];

const NOTICE_TEXTS: Record<CashierNotice, string> = {
  credited: CASHIER_TEXTS.credited,
  widget_error: CASHIER_TEXTS.widgetError,
};

// The Mini App page the bot's button opens (#27). The iframe has no src: the script sets the one
// the backend answered, so neither the session nor the widget URL is ever in this markup.
export const cashierPage = (): SafeHtml =>
  layout({
    title: CASHIER_TEXTS.title,
    head: html` <script src="${TELEGRAM_SDK_URL}"></script>
      <script src="${CASHIER_SCRIPT_PATH}" defer></script>`,
    page: 'cashier',
    body: html`<h1>${CASHIER_TEXTS.title}</h1>
      <p id="working">${CASHIER_TEXTS.working}</p>
      ${Object.values(CashierState).map(
        (state) => html`<p data-state="${state}" hidden>${STATE_TEXTS[state]}</p>`,
      )}
      ${Object.values(CashierNotice).map(
        (notice) =>
          html`<p data-notice="${notice}" role="status" hidden>${NOTICE_TEXTS[notice]}</p>`,
      )}
      <button id="retry" type="button" hidden>${CASHIER_TEXTS.retryButton}</button>
      <button id="close" type="button" hidden>${CASHIER_TEXTS.closeButton}</button>
      <iframe
        id="widget"
        title="${CASHIER_TEXTS.widgetTitle}"
        allow="payment *; clipboard-write *"
        hidden
      ></iframe>`,
  });
