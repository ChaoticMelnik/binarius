import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { themeCss } from './theme';

// Stylesheets are served as files rather than inlined: the CSP forbids inline styles, and an
// inline <style> would be the first thing to erode that. Every path below is read by pages.ts,
// routes.ts and export-pages.ts from here.
export const MINI_APP_STYLESHEET_PATH = '/admin/static/app.css';
export const ADMIN_STYLESHEET_PATH = '/admin/static/admin.css';
export const ADMIN_SCRIPT_PATH = '/admin/static/app.js';
export const ADMIN_FONTS_PATH = '/admin/static/fonts';

// The Mini App pages (OAuth, cashier) and the notice page outside /admin: only the rules their
// markup uses, the look unchanged since before the admin design system (#459). The cashier script
// sets data-widget on body while the widget is on screen (#671): no title, no vertical padding.
export const MINI_APP_CSS = `:root { color-scheme: light dark; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 60rem; margin: 0 auto; padding: 1rem; }
h1 { font-size: 1.4rem; }
button { font: inherit; padding: 0.5rem 1rem; cursor: pointer; }
#widget:not([hidden]) { display: block; width: 100%; border: 0; }
body[data-widget] main { padding-top: 0; padding-bottom: 0; }
body[data-widget] h1 { display: none; }
`;

// The admin design system (#459): the tokens of theme.ts, then the components that read them.
// The files are found from the package's root, which holds under tsx and in the bundle
// (docs/deploy.md -> Files a package reads); they are read at import, so a wrong path stops the
// process at its start.
const STATIC_DIR = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@binarius/web/package.json')),
  'src',
  'admin',
  'static',
);
const COMPONENTS_CSS = readFileSync(path.join(STATIC_DIR, 'admin.css'), 'utf8');
export const ADMIN_CSS = `${themeCss()}\n${COMPONENTS_CSS}`;

export const ADMIN_FONT_FILES = [
  'Inter-Regular.woff2',
  'Inter-Medium.woff2',
  'Inter-SemiBold.woff2',
] as const;

export type AdminFontFile = (typeof ADMIN_FONT_FILES)[number];

export const ADMIN_FONTS: Readonly<Record<AdminFontFile, Buffer>> = Object.fromEntries(
  ADMIN_FONT_FILES.map((file) => [file, readFileSync(path.join(STATIC_DIR, 'fonts', file))]),
) as Record<AdminFontFile, Buffer>;

/** The font a request path names, or undefined: the path segment is outside input (Rule 17). */
export const adminFont = (file: string): Buffer | undefined =>
  Object.hasOwn(ADMIN_FONTS, file) ? ADMIN_FONTS[file as AdminFontFile] : undefined;
