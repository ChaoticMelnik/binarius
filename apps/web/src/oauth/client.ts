// The one script of the Mini App login pages, served as a file (GET /oauth/static/app.js) rather
// than inlined: the pages' CSP allows no inline script. Plain ES5 over `window`, because it runs
// in whatever webview the Telegram client brings. It holds no user-facing text — every block it
// may show is already on the page, rendered by the server — and it never reads, parses or
// re-encodes initData: the backend checks the signature over the exact string Telegram gave.
export const OAUTH_CLIENT_JS = `(function () {
  'use strict';
  var webApp = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  var initData = webApp && typeof webApp.initData === 'string' ? webApp.initData : '';
  if (webApp && typeof webApp.ready === 'function') webApp.ready();

  function element(id) {
    return window.document.getElementById(id);
  }

  function showOutcome(outcome) {
    var blocks = window.document.querySelectorAll('[data-outcome]');
    var known = false;
    for (var index = 0; index < blocks.length; index += 1) {
      if (blocks[index].getAttribute('data-outcome') === outcome) known = true;
    }
    var shown = known ? outcome : 'unknown';
    for (var other = 0; other < blocks.length; other += 1) {
      blocks[other].hidden = blocks[other].getAttribute('data-outcome') !== shown;
    }
    var working = element('working');
    if (working) working.hidden = true;
    var close = element('close');
    if (close && initData !== '') close.hidden = false;
  }

  var close = element('close');
  if (close) {
    close.addEventListener('click', function () {
      if (webApp && typeof webApp.close === 'function') webApp.close();
    });
  }

  var page = window.document.body.getAttribute('data-page');

  if (page === 'login') {
    var authorize = element('authorize');
    if (initData === '') {
      if (authorize) authorize.hidden = true;
      showOutcome('open_from_telegram');
      return;
    }
    // the same webview, so the SDK's sessionStorage copy of the launch data survives the round
    // trip through the broker and the callback page reads it back
    if (authorize) window.location.replace(authorize.href);
    return;
  }

  if (page === 'callback') {
    if (initData === '') {
      showOutcome('open_from_telegram');
      return;
    }
    var query = new window.URLSearchParams(window.location.search);
    var body = JSON.stringify({ state: query.get('state'), code: query.get('code'), initData: initData });
    // before the call: a reload must land on the notice, not post a spent code again
    window.history.replaceState(null, '', window.location.pathname);
    window
      .fetch('/oauth/callback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
      })
      .then(function (response) {
        if (!response.ok) return 'unknown';
        return response.json().then(function (answer) {
          return answer && typeof answer.outcome === 'string' ? answer.outcome : 'unknown';
        });
      })
      .then(showOutcome, function () {
        showOutcome('unknown');
      });
  }
})();
`;
