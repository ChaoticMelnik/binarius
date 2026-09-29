// One stylesheet, served as a file rather than inlined: the CSP below forbids inline styles,
// and an inline <style> would be the first thing to erode that.
export const APP_CSS = `:root { color-scheme: light dark; --gap: 1rem; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 60rem; margin: 0 auto; padding: var(--gap); }
h1 { font-size: 1.4rem; }
form.stack { display: grid; gap: var(--gap); max-width: 22rem; }
label { display: grid; gap: 0.25rem; }
input { font: inherit; padding: 0.5rem; }
button { font: inherit; padding: 0.5rem 1rem; cursor: pointer; }
p.error { color: #b00020; font-weight: 600; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid #8884; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
td.agent { max-width: 22rem; overflow-wrap: anywhere; }
tr.current { font-weight: 600; }
.bar { display: flex; gap: var(--gap); align-items: baseline; justify-content: space-between; }
`;
