# Admin design system

The look of the staff admin pages (`apps/web`, `/admin/*`), introduced by #459. Server-rendered HTML
stays as it was: routes, staff sessions, audit and the `Origin` check do not change with the look.
This document is what a new admin section is laid out from. The pages themselves are described in
[admin-pages.md](admin-pages.md).

Screenshots of part 1 (dark/light, desktop 1280×800 and phone 375×812): `docs/admin/screenshots/`.

## Files

| File | What it holds |
|---|---|
| `apps/web/src/admin/theme.ts` | the tokens: `DARK_THEME`, `LIGHT_THEME`, the shared sizes, `CONTRAST_PAIRS`, `themeCss()` |
| `apps/web/src/admin/static/admin.css` | `@font-face` and every component, only through `var(--…)` |
| `apps/web/src/admin/static.ts` | `ADMIN_CSS` (= `themeCss()` + `admin.css`), `ADMIN_FONTS`, the static paths, `MINI_APP_CSS` |
| `apps/web/src/admin/icons.ts` | the Lucide icons, `iconSprite()`, `icon(name)` |
| `apps/web/src/admin/client.ts` | `ADMIN_CLIENT_JS`, the one script: the theme switch |
| `apps/web/src/admin/pages.ts` | `adminLayout`, `adminShell`, `authShell`, `adminNoticePage` and the pages |
| `apps/web/src/admin/export-pages.ts` | the pages as static files, for screenshots |
| `apps/web/src/admin/static/fonts/` | Inter 400/500/600 woff2 and `OFL.txt` |
| `apps/web/src/admin/static/LICENSE-lucide.txt` | the icons' licence |

Served by `admin/routes.ts`:

| Path | Body | Cache |
|---|---|---|
| `GET /admin/static/admin.css` | `ADMIN_CSS` | `public, max-age=3600` |
| `GET /admin/static/app.js` | `ADMIN_CLIENT_JS` | `public, max-age=3600` |
| `GET /admin/static/fonts/<file>` | one of the three `ADMIN_FONTS`; any other name is the 404 page | `public, max-age=86400` |
| `GET /admin/static/app.css` | `MINI_APP_CSS`, the Mini App pages' own stylesheet (OAuth, cashier, a notice outside `/admin`) | `public, max-age=3600` |

## Content Security Policy

The admin policy is the array `ADMIN_CSP` in `apps/web/src/app.ts`; the header is

```
default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'
```

pinned in `app.test.ts` (H5), `oauth/routes.test.ts` and `cashier/routes.test.ts`. So: no inline
`<style>`, no `style="…"`, no inline `<script>`, no `on…=` handler, nothing from another origin.
`export-pages.test.ts` (E3) checks every exported page for all four. A new page that needs any of
them is laid out differently, not given an exception.

## Themes and tokens

Dark is the default (`:root`). Light applies by the system setting
(`@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) }`) or by the switch
(`:root[data-theme="light"]`). Each block sets `color-scheme`, so native controls follow the theme.

The switch is the only script (`/admin/static/app.js`, loaded synchronously in `<head>` so a stored
theme applies before the first paint). It removes the `no-js` class from `<html>`, reads
`localStorage['admin-theme']` (`dark` or `light`; anything else is ignored) and on a click cycles
system → dark → light → system. Storage that throws leaves the system theme. Without JavaScript
`no-js` stays, `.no-js-hidden` hides the switch, and the system setting decides.

Colours (dark / light):

| Token | Dark | Light | Used for |
|---|---|---|---|
| `--color-bg` | `#0b0e14` | `#f6f7f9` | page background, inputs |
| `--color-surface` | `#11151d` | `#ffffff` | sidebar, top bar, cards, tables |
| `--color-surface-2` | `#161b25` | `#f1f3f6` | table header, hover, current nav item, `code` |
| `--color-border` | `#242b38` | `#e1e5eb` | every border |
| `--color-fg` | `#e6e9ef` | `#141821` | text |
| `--color-fg-muted` | `#9aa3b2` | `#5b6474` | labels, `dt`, hints |
| `--color-accent` | `#60a5fa` | `#1d4ed8` | links, the current nav icon |
| `--color-accent-bg` | `#2563eb` | `#2563eb` | primary button |
| `--color-on-accent` | `#ffffff` | `#ffffff` | text on the primary button |
| `--color-focus` | `#2563eb` | `#2563eb` | the focus ring |
| `--color-success` / `-bg` | `#34d399` / `#0f2e22` | `#047857` / `#dcfce7` | success badge, `p.notice` |
| `--color-warning` / `-bg` | `#fbbf24` / `#3a2a07` | `#92400e` / `#fef3c7` | warning badge |
| `--color-danger` / `-bg` | `#f87171` / `#3b1515` | `#b91c1c` / `#fee2e2` | errors, danger button |
| `--color-info` / `-bg` | `#7dd3fc` / `#0f2a3b` | `#0e7490` / `#e0f2fe` | info badge |
| `--color-neutral-bg` | `#1d2430` | `#e9edf2` | neutral badge |

Contrast: `theme.test.ts` (T1) checks every pair of `CONTRAST_PAIRS` in both themes against WCAG AA
— 4.5 for text, 3 for the focus ring: fg, fg-muted on bg / surface / surface-2; accent on bg /
surface; on-accent on accent-bg; each status colour on its badge background; fg on neutral-bg;
danger, success, warning on surface; danger on bg; focus on bg / surface. The test covers these
pairs only. That a text in the markup sits on one of its pair's backgrounds is how the stylesheet
is written, not something a test checks: a new component puts text only on a background that
pairs with it here, or adds the pair to `CONTRAST_PAIRS` first.

Sizes, the same in both themes: `--font-sans` (Inter, then `system-ui`), `--font-mono` (system
monospace stack, no file); `--text-sm` 0.8125rem, `--text-base` 0.875rem, `--text-lg` 1rem,
`--text-xl` 1.25rem, `--text-2xl` 1.5rem; `--space-1`…`--space-6` 0.25 / 0.5 / 0.75 / 1 / 1.5 / 2rem;
`--radius-sm` 6px, `--radius` 10px, `--radius-lg` 14px; `--sidebar-w` 16rem; `--topbar-h` 3.5rem;
`--shadow-sm`.

## Font

Inter, three static weights — 400, 500, 600 — from `rsms/inter` at commit
`353b61b9f4430d5f420d56605a6e7993e0941470` (`docs/font-files/`), licence `OFL.txt` (the
`LICENSE.txt` of that commit). No other weight is in the stylesheet: a 700 would be synthesised by
the browser (`static.test.ts` S3). To fetch a file again:

```bash
gh api -H "Accept: application/vnd.github.raw" "repos/rsms/inter/contents/docs/font-files/Inter-Regular.woff2?ref=353b61b9f4430d5f420d56605a6e7993e0941470" > Inter-Regular.woff2
```

## Icons

Lucide 1.59.0 (ISC, `static/LICENSE-lucide.txt`), as one hidden inline sprite per page: no request
and no CSP change. `icons.ts` holds the child elements of each `icons/<name>.svg` at that tag;
`icon(name)` renders `<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-<name>"/></svg>`.
Icons are decoration: the text next to one is what a screen reader reads, and an icon-only button
has an `aria-label`. To add one, take its children from

```bash
gh api -H "Accept: application/vnd.github.raw" "repos/lucide-icons/lucide/contents/icons/wallet.svg?ref=1.59.0"
```

and add the name to `ICON_NAMES` and the markup to `ICONS`.

## Shell

`adminShell({ title, active, login, body })` — every page behind a staff session:

```html
<html lang="ru" class="no-js"> … <link rel="stylesheet" href="/admin/static/admin.css" /><script src="/admin/static/app.js"></script>
<body>
  <a class="skip-link" href="#main">К содержимому</a>
  <svg class="sprite" …>…</svg>
  <div class="shell">
    <nav id="nav" class="sidebar" popover aria-label="Разделы админки">
      <div class="sidebar-head"><span class="brand">Binarius</span><button class="icon-btn sidebar-close" popovertarget="nav" popovertargetaction="hide" aria-label="Закрыть меню">…</button></div>
      <a href="/admin/overview" aria-current="page"><svg class="icon">…</svg>Сводка</a> …
    </nav>
    <div class="content">
      <header class="topbar">
        <button class="icon-btn burger" popovertarget="nav" aria-controls="nav" aria-label="Меню">…</button>
        <div class="topbar-actions">[theme switch] <span class="login">ada</span> <a href="/admin/password">Сменить пароль</a> <form … action="/admin/logout"><button type="submit" class="btn btn-secondary">…Выйти</button></form></div>
      </header>
      <main id="main" class="page">…</main>
    </div>
  </div>
</body>
```

- The sidebar is one element: a popover drawer below 64rem, a static column from 64rem up. Its base
  rule sets no `display` — that would override the browser's rule hiding a closed popover, and the
  drawer would cover the page. A browser without popover support shows the nav in the flow.
- `.content { min-width: 0 }` keeps a wide table from widening the page.
- The account block is left out when the page has no `login` (a refused form).
- `authShell({ title, body })` — sign-in pages and `adminNoticePage(title, body)`: a centred
  `.card.auth-card` with the brand and the theme switch below it, one `<main id="main" class="auth-main">`.
- Every admin page has exactly one `<main>`: `layout` is called with `wrapMain: false` and the page
  builds its own (`app.test.ts` H8–H10).

## Components

All defined in `admin.css`; markup to use:

| Component | Markup |
|---|---|
| card | `<div class="card">…</div>` |
| section | `<section class="section"><h2>…</h2>…</section>` |
| metric cards | `<dl class="metrics"><div class="metric"><dt>Label</dt><dd>31</dd></div>…</dl>`; `metrics metrics-dense` for a long breakdown |
| entity card | `<dl class="props"><dt>…</dt><dd>…</dd>…</dl>` (a plain `<dl>` is a two-column list too) |
| table | `<div class="table-wrap"><table><thead><tr><th>…</th></tr></thead><tbody>…</tbody></table></div>`; `td.num` right-aligns a number |
| badge | `<span class="badge badge-success">…</span>`; `-warning`, `-danger`, `-info`, `-neutral` |
| buttons | `<button type="submit">` is primary; `class="btn btn-secondary"`, `class="btn btn-danger"`; `class="icon-btn"` with an `aria-label` for an icon alone |
| form | `<form class="stack">` with `<label>Text <input …/></label>`; `form.search` / `.toolbar` for a filter row; `label.choice` for a radio or checkbox |
| messages | `<p class="error">`, `<ul class="error">`, `<p class="notice">`, `<p class="hint">` |
| pager | `<p class="pager"><a href="…">…</a></p>` (as the list pages render it) |
| empty state | `<p class="empty">…</p>` |

The section bodies other than the overview keep their markup from before #459; the element rules
(`table`, `dl`, `form.search`, `label`, `details`, `.tg-bubble`, …) restyle it. Until #656 turns
table rows into cards, every table in `<main>` is as wide as its content and scrolls inside itself
when that is wider than the page, so no page scrolls sideways.

Accessibility: the skip link is the first element of `<body>`; `:focus-visible` draws a 2px
`--color-focus` ring; the current section has `aria-current="page"`; buttons and nav links are at
least 40px high; there are no animations.

## A new section

1. Add its key to `AdminNavKey` and an entry to `NAV` in `pages.ts` with an icon from `ICON_NAMES`
   (add the icon first, see Icons).
2. Render it with `adminShell({ title, active: '<key>', login, body })`.
3. Build `body` from the components above, with no inline style or script.
4. Add the page to `EXPORTED_PAGES` in `export-pages.ts` (E4 requires every nav key there) and look
   at it in both themes at 375 px and 1280 px.

## Screenshots

Without starting the web service: the export calls the page functions with the `SAMPLE_*` answers
of `admin/testing.ts` (no Fastify, no backend, no network) and writes static files.

```bash
pnpm --filter @binarius/web admin:export "$(mktemp -d)" --serve 8459
```

It prints each written file, then `pid=<PID>` and `url=http://127.0.0.1:8459/`, and serves that
directory alone, GET only, on 127.0.0.1 until SIGTERM (`kill <PID>`). Without `--serve` it only
writes the files. Then, with the Playwright MCP browser (it does not open `file:` URLs, hence the
server):

1. `browser_emulate_media` with `colorScheme` `dark` or `light`;
2. `browser_resize` to 1280×800 or 375×812;
3. `browser_navigate` to `http://127.0.0.1:8459/<page>.html` (`login`, `confirm`, `link`,
   `not-found`, `overview`, `users`, … — the keys of `EXPORTED_PAGES`);
4. `browser_take_screenshot` with an absolute path under `docs/admin/screenshots/`, named
   `<page>-<theme>-<desktop|mobile>.png`; the open menu: `browser_click` on `.burger` first,
   saved as `overview-<theme>-mobile-menu.png`;
5. on each page at 375 px, `browser_evaluate` of `document.documentElement.scrollWidth` — 375
   means the page does not scroll sideways;
6. `kill <PID>` of the export server.
