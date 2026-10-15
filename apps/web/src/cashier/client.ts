// The one script of the cashier page (#111), served as a file (GET /cashier/static/app.js): the
// page's CSP allows no inline script. Plain ES5 over `window`, because it runs in whatever webview
// the Telegram client brings. It holds no user-facing text — every block it may show is already on
// the page — and it never reads or re-encodes initData: the backend checks the signature over the
// exact string Telegram gave.
//
// The handshake follows the broker's own cashier (broker-web pay-embed.tsx): a session is minted on
// load and the widget's first `ready` takes it while it is young; every later `ready` (the widget
// reloaded itself) gets a fresh one. The session lives only in this closure, in the POST answer and
// in postMessage — never in a URL, never in storage.
export const CASHIER_CLIENT_JS = `(function () {
  'use strict';
  var SESSION_PATH = '/cashier/session';
  var SESSION_REUSE_MS = 45000;
  var HEIGHT_MIN = 520;
  var HEIGHT_MAX = 900;
  var HEIGHT_INITIAL = 720;
  var RETRY_STATES = { busy: true, unavailable: true };

  var webApp = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  var initData = webApp && typeof webApp.initData === 'string' ? webApp.initData : '';
  if (webApp && typeof webApp.ready === 'function') webApp.ready();

  function element(id) {
    return window.document.getElementById(id);
  }

  var frame = element('widget');
  var working = element('working');
  var retry = element('retry');
  var close = element('close');
  // what the backend answered for the frame on screen; null until then, and every message is
  // ignored while it is
  var widgetOrigin = null;
  // the session minted on load, until the first ready takes it
  var pending = null;

  function closeApp() {
    if (webApp && typeof webApp.close === 'function') webApp.close();
  }

  function showState(state) {
    var blocks = window.document.querySelectorAll('[data-state]');
    var known = false;
    for (var index = 0; index < blocks.length; index += 1) {
      if (blocks[index].getAttribute('data-state') === state) known = true;
    }
    var shown = known ? state : 'unavailable';
    for (var other = 0; other < blocks.length; other += 1) {
      blocks[other].hidden = blocks[other].getAttribute('data-state') !== shown;
    }
    if (frame) frame.hidden = true;
    if (working) working.hidden = true;
    var retryable = RETRY_STATES[shown] === true;
    if (retry) retry.hidden = !retryable;
    if (close) close.hidden = retryable || shown === 'open_from_telegram';
  }

  function showWorking() {
    var blocks = window.document.querySelectorAll('[data-state]');
    for (var index = 0; index < blocks.length; index += 1) blocks[index].hidden = true;
    if (retry) retry.hidden = true;
    if (close) close.hidden = true;
    if (working) working.hidden = false;
  }

  // Resolves to the route's answer: { outcome: 'ready', ... } with every field the page uses, or
  // { outcome: <state> }. An answer of any other shape, or none, is 'unavailable'.
  function mint() {
    return window
      .fetch(SESSION_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initData: initData }),
      })
      .then(function (response) {
        return response.json();
      })
      .then(
        function (answer) {
          if (answer === null || typeof answer !== 'object') return { outcome: 'unavailable' };
          if (answer.outcome === 'ready') {
            if (
              typeof answer.session === 'string' &&
              typeof answer.expiresInSec === 'number' &&
              typeof answer.widgetUrl === 'string' &&
              typeof answer.widgetOrigin === 'string'
            ) {
              return answer;
            }
            return { outcome: 'unavailable' };
          }
          return { outcome: typeof answer.outcome === 'string' ? answer.outcome : 'unavailable' };
        },
        function () {
          return { outcome: 'unavailable' };
        },
      );
  }

  function postInit(session) {
    frame.contentWindow.postMessage({ type: 'binodex-embed:init', session: session }, widgetOrigin);
  }

  function onReady() {
    var held = pending;
    pending = null;
    if (held !== null && Date.now() - held.mintedAt < held.reuseMs) {
      postInit(held.session);
      return;
    }
    mint().then(function (answer) {
      if (answer.outcome !== 'ready') {
        showState(answer.outcome);
        return;
      }
      postInit(answer.session);
    });
  }

  function onResize(height) {
    if (typeof height !== 'number' || !isFinite(height)) return;
    frame.style.height = Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, height)) + 'px';
  }

  // Attached before any src is set, so the widget's first ready cannot arrive unheard.
  window.addEventListener('message', function (event) {
    if (
      frame === null ||
      widgetOrigin === null ||
      event.source !== frame.contentWindow ||
      event.origin !== widgetOrigin
    ) {
      return;
    }
    var data = event.data;
    if (data === null || typeof data !== 'object' || typeof data.type !== 'string') return;
    switch (data.type) {
      case 'binodex-embed:ready':
        onReady();
        return;
      case 'binodex-embed:resize':
        onResize(data.height);
        return;
      case 'binodex-embed:close':
        closeApp();
        return;
      // #112 handles these three; until then they change nothing
      case 'binodex-embed:credited':
      case 'binodex-embed:error':
      case 'binodex-embed:reauth-required':
        return;
      default:
        return;
    }
  });

  function load() {
    if (initData === '') {
      showState('open_from_telegram');
      return;
    }
    if (frame === null) {
      showState('unavailable');
      return;
    }
    showWorking();
    mint().then(function (answer) {
      if (answer.outcome !== 'ready') {
        showState(answer.outcome);
        return;
      }
      widgetOrigin = answer.widgetOrigin;
      pending = {
        session: answer.session,
        mintedAt: Date.now(),
        reuseMs: Math.min(SESSION_REUSE_MS, answer.expiresInSec * 1000),
      };
      if (working) working.hidden = true;
      frame.style.height = HEIGHT_INITIAL + 'px';
      frame.hidden = false;
      frame.src = answer.widgetUrl;
    });
  }

  if (retry) retry.addEventListener('click', load);
  if (close) close.addEventListener('click', closeApp);

  load();
})();
`;
