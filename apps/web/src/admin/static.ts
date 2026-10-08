// One stylesheet, served as a file rather than inlined: the CSP below forbids inline styles,
// and an inline <style> would be the first thing to erode that.
export const APP_CSS = `:root { color-scheme: light dark; --gap: 1rem; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 60rem; margin: 0 auto; padding: var(--gap); }
h1 { font-size: 1.4rem; }
form.stack { display: grid; gap: var(--gap); max-width: 22rem; }
label { display: grid; gap: 0.25rem; }
input, select { font: inherit; padding: 0.5rem; }
button { font: inherit; padding: 0.5rem 1rem; cursor: pointer; }
p.error { color: #b00020; font-weight: 600; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid #8884; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
td.agent { max-width: 22rem; overflow-wrap: anywhere; }
td.num { text-align: right; white-space: nowrap; }
tr.current { font-weight: 600; }
.bar { display: flex; gap: var(--gap); align-items: baseline; justify-content: space-between; }
.account { display: flex; gap: var(--gap); align-items: baseline; }
nav { display: flex; gap: var(--gap); flex-wrap: wrap; }
nav a[aria-current="page"] { font-weight: 600; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem var(--gap); }
dt { color: #888; }
dd { margin: 0; overflow-wrap: anywhere; }
p.hint { color: #888; font-size: 0.9rem; }
form.search { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: end; }
form.search input { min-width: 18rem; }
.pager { display: flex; gap: var(--gap); }
form.search input[type="date"] { min-width: 0; }
td.payload { max-width: 28rem; }
code.payload { overflow-wrap: anywhere; white-space: pre-wrap; }
textarea { font: inherit; width: 100%; box-sizing: border-box; padding: 0.5rem; }
form.editor { display: grid; gap: 0.5rem; }
form.editor .buttons { display: flex; gap: var(--gap); }
p.notice { font-weight: 600; }
ul.error { color: #b00020; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.tg-bubble { white-space: pre-wrap; max-width: 32rem; padding: 0.75rem 1rem; border: 1px solid #8884; border-radius: 1rem; }
.tg-spoiler { background: #8886; color: transparent; }
.tg-spoiler:hover { color: inherit; }
.tg-label { display: inline-block; padding: 0.25rem 0.75rem; border: 1px solid #8884; border-radius: 0.5rem; }
blockquote { margin: 0.25rem 0; padding-left: 0.75rem; border-left: 3px solid #8888; }
blockquote.expandable { max-height: 4.5em; overflow: hidden; }
`;
