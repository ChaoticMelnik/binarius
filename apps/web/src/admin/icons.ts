import { html, type SafeHtml } from '../html';

// Lucide 1.59.0 (ISC, static/LICENSE-lucide.txt): the child elements of icons/<name>.svg at that
// tag, copied as they are. One inline sprite per page instead of a file: no request and no CSP
// change (an external sprite would need img-src or a same-document <use>).
export const ICON_NAMES = [
  'layout-dashboard',
  'users',
  'key-round',
  'activity',
  'repeat',
  'coins',
  'scroll-text',
  'message-square-text',
  'wallet',
  'briefcase',
  'server',
  'menu',
  'x',
  'sun',
  'moon',
  'monitor',
  'log-out',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

// The markup is long single lines on purpose: one icon per line, as the upstream file has it.
// prettier-ignore
export const ICONS: Readonly<Record<IconName, SafeHtml>> = {
  'layout-dashboard': html`<rect width="7" height="9" x="3" y="3" rx="1" /><rect width="7" height="5" x="14" y="3" rx="1" /><rect width="7" height="9" x="14" y="12" rx="1" /><rect width="7" height="5" x="3" y="16" rx="1" />`,
  users: html`<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><path d="M16 3.128a4 4 0 0 1 0 7.744" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><circle cx="9" cy="7" r="4" />`,
  'key-round': html`<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />`,
  activity: html`<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />`,
  repeat: html`<path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />`,
  coins: html`<path d="M13.744 17.736a6 6 0 1 1-7.48-7.48" /><path d="M15 6h1v4" /><path d="m6.134 14.768.866-.5 2 3.464" /><circle cx="16" cy="8" r="6" />`,
  'scroll-text': html`<path d="M15 12h-5" /><path d="M15 8h-5" /><path d="M19 17V5a2 2 0 0 0-2-2H4" /><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />`,
  'message-square-text': html`<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" /><path d="M7 11h10" /><path d="M7 15h6" /><path d="M7 7h8" />`,
  wallet: html`<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" /><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />`,
  briefcase: html`<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /><rect width="20" height="14" x="2" y="6" rx="2" />`,
  server: html`<rect width="20" height="8" x="2" y="2" rx="2" ry="2" /><rect width="20" height="8" x="2" y="14" rx="2" ry="2" /><line x1="6" x2="6.01" y1="6" y2="6" /><line x1="6" x2="6.01" y1="18" y2="18" />`,
  menu: html`<path d="M4 5h16" /><path d="M4 12h16" /><path d="M4 19h16" />`,
  x: html`<path d="M18 6 6 18" /><path d="m6 6 12 12" />`,
  sun: html`<circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />`,
  moon: html`<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />`,
  monitor: html`<rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" />`,
  'log-out': html`<path d="m16 17 5-5-5-5" /><path d="M21 12H9" /><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />`,
};

/** The hidden sprite, once per page; `icon` refers into it. */
// prettier-ignore
export const iconSprite = (): SafeHtml =>
  html`<svg class="sprite" aria-hidden="true" focusable="false">${ICON_NAMES.map(
    (name) =>
      html`<symbol id="i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</symbol>`,
  )}</svg>`;

/** `attrs` is extra attributes, already HTML (`data-theme-icon="dark" hidden`). */
// prettier-ignore
export const icon = (name: IconName, attrs?: SafeHtml): SafeHtml =>
  html`<svg class="icon" aria-hidden="true" focusable="false"${attrs === undefined ? '' : html` ${attrs}`}><use href="#i-${name}"/></svg>`;
