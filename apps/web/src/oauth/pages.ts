import { html, layout, type SafeHtml } from '../html';
import { OAUTH_TEXTS } from './texts';

// the line core.telegram.org/bots/webapps gives (fetched 2026-10-01); in <head>, before our script
export const TELEGRAM_SDK_URL = 'https://telegram.org/js/telegram-web-app.js?63';
export const OAUTH_SCRIPT_PATH = '/oauth/static/app.js';

export const CallbackOutcome = {
  Linked: 'linked',
  OpenFromTelegram: 'open_from_telegram',
  Busy: 'busy',
  StartOver: 'start_over',
  Blocked: 'blocked',
  Taken: 'taken',
  Unknown: 'unknown',
} as const;
export type CallbackOutcome = (typeof CallbackOutcome)[keyof typeof CallbackOutcome];

const OUTCOME_TEXTS: Record<CallbackOutcome, string> = {
  linked: OAUTH_TEXTS.linked,
  open_from_telegram: OAUTH_TEXTS.openFromTelegram,
  busy: OAUTH_TEXTS.busy,
  start_over: OAUTH_TEXTS.startOver,
  blocked: OAUTH_TEXTS.blocked,
  taken: OAUTH_TEXTS.taken,
  unknown: OAUTH_TEXTS.unknown,
};

const scripts = html`
    <script src="${TELEGRAM_SDK_URL}"></script>
    <script src="${OAUTH_SCRIPT_PATH}" defer></script>`;

const outcomeBlock = (outcome: CallbackOutcome): SafeHtml =>
  html`<p data-outcome="${outcome}" hidden>${OUTCOME_TEXTS[outcome]}</p>`;

// Opened by the bot's web_app button. The script navigates to the broker inside the same webview;
// the link is what a person taps if it does not.
export const loginPage = (authorizeUrl: string): SafeHtml =>
  layout({
    title: OAUTH_TEXTS.loginTitle,
    head: scripts,
    page: 'login',
    body: html`<h1>${OAUTH_TEXTS.loginTitle}</h1>
      <p id="working">${OAUTH_TEXTS.redirecting}</p>
      <p><a id="authorize" href="${authorizeUrl}">${OAUTH_TEXTS.authorizeLink}</a></p>
      ${outcomeBlock(CallbackOutcome.OpenFromTelegram)}`,
  });

// Where the broker redirects. It renders neither the code nor the state: the script reads them
// from the address and posts them with the launch data.
export const callbackPage = (): SafeHtml =>
  layout({
    title: OAUTH_TEXTS.callbackTitle,
    head: scripts,
    page: 'callback',
    body: html`<h1>${OAUTH_TEXTS.callbackTitle}</h1>
      <p id="working">${OAUTH_TEXTS.working}</p>
      ${Object.values(CallbackOutcome).map(outcomeBlock)}
      <button id="close" type="button" hidden>${OAUTH_TEXTS.closeButton}</button>`,
  });
