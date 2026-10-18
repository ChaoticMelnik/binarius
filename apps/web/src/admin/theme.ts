// The admin design system's tokens (#459): the one source of every colour and size the admin
// stylesheet uses. admin.css only reads them through var(--…); theme.test.ts checks the contrast of
// the pairs below in both themes, from the same objects the stylesheet is built from.

export const THEME_TOKEN_NAMES = [
  '--color-bg',
  '--color-surface',
  '--color-surface-2',
  '--color-border',
  '--color-fg',
  '--color-fg-muted',
  '--color-accent',
  '--color-accent-bg',
  '--color-on-accent',
  '--color-focus',
  '--color-success',
  '--color-warning',
  '--color-danger',
  '--color-info',
  '--color-success-bg',
  '--color-warning-bg',
  '--color-danger-bg',
  '--color-info-bg',
  '--color-neutral-bg',
] as const;

export type ThemeToken = (typeof THEME_TOKEN_NAMES)[number];

export const DARK_THEME = {
  '--color-bg': '#0b0e14',
  '--color-surface': '#11151d',
  '--color-surface-2': '#161b25',
  '--color-border': '#242b38',
  '--color-fg': '#e6e9ef',
  '--color-fg-muted': '#9aa3b2',
  '--color-accent': '#60a5fa',
  '--color-accent-bg': '#2563eb',
  '--color-on-accent': '#ffffff',
  '--color-focus': '#2563eb',
  '--color-success': '#34d399',
  '--color-warning': '#fbbf24',
  '--color-danger': '#f87171',
  '--color-info': '#7dd3fc',
  '--color-success-bg': '#0f2e22',
  '--color-warning-bg': '#3a2a07',
  '--color-danger-bg': '#3b1515',
  '--color-info-bg': '#0f2a3b',
  '--color-neutral-bg': '#1d2430',
} as const satisfies Record<ThemeToken, string>;

export const LIGHT_THEME = {
  '--color-bg': '#f6f7f9',
  '--color-surface': '#ffffff',
  '--color-surface-2': '#f1f3f6',
  '--color-border': '#e1e5eb',
  '--color-fg': '#141821',
  '--color-fg-muted': '#5b6474',
  '--color-accent': '#1d4ed8',
  '--color-accent-bg': '#2563eb',
  '--color-on-accent': '#ffffff',
  '--color-focus': '#2563eb',
  '--color-success': '#047857',
  '--color-warning': '#92400e',
  '--color-danger': '#b91c1c',
  '--color-info': '#0e7490',
  '--color-success-bg': '#dcfce7',
  '--color-warning-bg': '#fef3c7',
  '--color-danger-bg': '#fee2e2',
  '--color-info-bg': '#e0f2fe',
  '--color-neutral-bg': '#e9edf2',
} as const satisfies Record<ThemeToken, string>;

// Sizes and type, the same in both themes.
const SHARED_TOKENS: Readonly<Record<string, string>> = {
  '--font-sans': "'Inter', system-ui, sans-serif",
  '--font-mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  '--text-sm': '0.8125rem',
  '--text-base': '0.875rem',
  '--text-lg': '1rem',
  '--text-xl': '1.25rem',
  '--text-2xl': '1.5rem',
  '--space-1': '0.25rem',
  '--space-2': '0.5rem',
  '--space-3': '0.75rem',
  '--space-4': '1rem',
  '--space-5': '1.5rem',
  '--space-6': '2rem',
  '--radius-sm': '6px',
  '--radius': '10px',
  '--radius-lg': '14px',
  '--sidebar-w': '16rem',
  '--topbar-h': '3.5rem',
  '--shadow-sm': '0 1px 2px rgb(0 0 0 / 0.08)',
};

/** text on background, with the WCAG 2.x minimum the pair must meet (3 for the focus ring) */
export const CONTRAST_PAIRS: readonly { fg: ThemeToken; bg: ThemeToken; min: number }[] = [
  { fg: '--color-fg', bg: '--color-bg', min: 4.5 },
  { fg: '--color-fg', bg: '--color-surface', min: 4.5 },
  { fg: '--color-fg', bg: '--color-surface-2', min: 4.5 },
  { fg: '--color-fg-muted', bg: '--color-bg', min: 4.5 },
  { fg: '--color-fg-muted', bg: '--color-surface', min: 4.5 },
  { fg: '--color-fg-muted', bg: '--color-surface-2', min: 4.5 },
  { fg: '--color-accent', bg: '--color-bg', min: 4.5 },
  { fg: '--color-accent', bg: '--color-surface', min: 4.5 },
  { fg: '--color-on-accent', bg: '--color-accent-bg', min: 4.5 },
  { fg: '--color-success', bg: '--color-success-bg', min: 4.5 },
  { fg: '--color-warning', bg: '--color-warning-bg', min: 4.5 },
  { fg: '--color-danger', bg: '--color-danger-bg', min: 4.5 },
  { fg: '--color-info', bg: '--color-info-bg', min: 4.5 },
  { fg: '--color-fg', bg: '--color-neutral-bg', min: 4.5 },
  { fg: '--color-danger', bg: '--color-bg', min: 4.5 },
  { fg: '--color-danger', bg: '--color-surface', min: 4.5 },
  { fg: '--color-success', bg: '--color-surface', min: 4.5 },
  { fg: '--color-warning', bg: '--color-surface', min: 4.5 },
  { fg: '--color-focus', bg: '--color-bg', min: 3 },
  { fg: '--color-focus', bg: '--color-surface', min: 3 },
];

const declarations = (tokens: Readonly<Record<string, string>>): string =>
  Object.entries(tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');

/**
 * Dark by default; light by the system setting unless the theme switch chose dark, or by the
 * switch. Without the script no `data-theme` is ever set, so the system setting alone decides.
 */
export const themeCss = (): string => `:root {
  color-scheme: dark;
${declarations(SHARED_TOKENS)}
${declarations(DARK_THEME)}
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    color-scheme: light;
${declarations(LIGHT_THEME)}
  }
}
:root[data-theme="light"] {
  color-scheme: light;
${declarations(LIGHT_THEME)}
}
`;
