// The admin pages' one script (#459), served as a file (GET /admin/static/app.js): the CSP allows
// no inline script. It is loaded synchronously in <head>, so the chosen theme is on <html> before
// the first paint. Plain ES5. Nothing depends on it: without it the `no-js` class stays, the theme
// switch is hidden and the system theme applies. It holds no user-facing text — the switch's
// labels come from its own data-label-* attributes.
//
// The switch cycles system → dark → light → system; "system" is no attribute and no stored key.
// Storage may be missing or throw (a private window, blocked site data): every access is guarded
// and a failure leaves the system theme.
export const ADMIN_CLIENT_JS = `(function () {
  'use strict';
  var KEY = 'admin-theme';
  var doc = window.document;
  var root = doc.documentElement;
  root.className = root.className.replace(/\\bno-js\\b/, '');

  function read() {
    var stored = null;
    try {
      stored = window.localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
    if (stored === 'dark' || stored === 'light') return stored;
    return null;
  }

  function write(theme) {
    try {
      if (theme === null) window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, theme);
    } catch (e) {
      // the choice lasts for this page only
    }
  }

  function apply(theme) {
    if (theme === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }

  function show(button, theme) {
    var name = theme === null ? 'system' : theme;
    var label = button.getAttribute('data-label-' + name);
    if (label) button.setAttribute('aria-label', label);
    var icons = button.querySelectorAll('[data-theme-icon]');
    for (var i = 0; i < icons.length; i += 1) {
      if (icons[i].getAttribute('data-theme-icon') === name) icons[i].removeAttribute('hidden');
      else icons[i].setAttribute('hidden', '');
    }
  }

  var current = read();
  apply(current);

  doc.addEventListener('DOMContentLoaded', function () {
    var buttons = doc.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i += 1) show(buttons[i], current);
    for (var j = 0; j < buttons.length; j += 1) {
      buttons[j].addEventListener('click', function () {
        current = current === null ? 'dark' : current === 'dark' ? 'light' : null;
        apply(current);
        write(current);
        for (var k = 0; k < buttons.length; k += 1) show(buttons[k], current);
      });
    }
  });
})();
`;
