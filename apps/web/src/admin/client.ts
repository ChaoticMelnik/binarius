// The admin pages' one script (#459), served as a file (GET /admin/static/app.js): the CSP allows
// no inline script. It is loaded synchronously in <head>, so the chosen theme is on <html> before
// the first paint. Plain ES5. Nothing depends on it: without it the `no-js` class stays, the theme
// switch is hidden and the system theme applies. It holds no user-facing text — the switch's
// labels come from its own data-label-* attributes.
//
// The copy button next to an id (#656) is the one other behaviour: a click writes its data-copy
// value to the clipboard and shows «copied» for a moment. Without navigator.clipboard (plain http,
// an old browser) the buttons are hidden; a refused write changes nothing.
//
// The third is the forms' confirm and busy state (#657): a submit whose button carries
// data-confirm asks window.confirm first and a «no» cancels it; a submit that goes ahead marks its
// form aria-busy, cleared again on pageshow (a page restored from the back/forward cache). Without
// event.submitter (form.submit(), an old browser) the form submits unasked, as without the script.
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

  var COPIED_MS = 1500;
  var clipboard = window.navigator ? window.navigator.clipboard : undefined;
  var canCopy = !!clipboard && typeof clipboard.writeText === 'function';

  function showCopied(button, copied) {
    var label = button.getAttribute(copied ? 'data-label-copied' : 'data-label-copy');
    if (label) button.setAttribute('aria-label', label);
    var name = copied ? 'check' : 'copy';
    var icons = button.querySelectorAll('[data-copy-icon]');
    for (var i = 0; i < icons.length; i += 1) {
      if (icons[i].getAttribute('data-copy-icon') === name) icons[i].removeAttribute('hidden');
      else icons[i].setAttribute('hidden', '');
    }
  }

  doc.addEventListener('click', function (event) {
    var target = event.target;
    var button = target && target.closest ? target.closest('[data-copy]') : null;
    if (!button || !canCopy) return;
    clipboard.writeText(button.getAttribute('data-copy')).then(
      function () {
        showCopied(button, true);
        window.setTimeout(function () {
          showCopied(button, false);
        }, COPIED_MS);
      },
      function () {
        // nothing was copied; the id is still there to select
      }
    );
  });

  doc.addEventListener('submit', function (event) {
    var form = event.target;
    var submitter = event.submitter;
    var text = submitter && submitter.getAttribute ? submitter.getAttribute('data-confirm') : null;
    if (text && !window.confirm(text)) {
      event.preventDefault();
      return;
    }
    if (form && form.setAttribute) form.setAttribute('aria-busy', 'true');
  });

  window.addEventListener('pageshow', function () {
    var busy = doc.querySelectorAll('form[aria-busy]');
    for (var b = 0; b < busy.length; b += 1) busy[b].removeAttribute('aria-busy');
  });

  doc.addEventListener('DOMContentLoaded', function () {
    if (!canCopy) {
      var copies = doc.querySelectorAll('[data-copy]');
      for (var c = 0; c < copies.length; c += 1) copies[c].setAttribute('hidden', '');
    }
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
