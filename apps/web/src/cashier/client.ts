// The one script of the cashier page (#111), served as a file (GET /cashier/static/app.js): the
// page's CSP allows no inline script. Plain ES5 over `window`, because it runs in whatever webview
// the Telegram client brings. It holds no user-facing text — every block it may show is already on
// the page — and it never reads or re-encodes initData: the backend checks the signature over the
// exact string Telegram gave.
//
// The handshake follows the broker's own cashier (broker-web pay-embed.tsx): a session is minted on
// load and the widget's first `ready` takes it while it is young; every later `ready` (the widget
// reloaded itself) and every `reauth-required` gets a fresh one, posted to the same frame without a
// reload (#112). The session lives only in this closure, in the POST answer and in postMessage —
// never in a URL, never in storage.
//
// Mint results are ordered (#112, docs/deposit.md -> The page): a load bumps the generation, and a
// result of an older one is dropped whole; at most one fresh mint is in flight, and an event that
// needs one while it is coalesces into it. Any mint answering `unavailable` is repeated once at
// once: the page cannot tell a broker 401 (the next call exchanges the token) from an outage.
//
// `credited` and `error` show a notice above the widget, which stays. Neither event's payload is
// read: the credited POST carries initData alone, and the widget's error message is never shown.
//
// The frame's height (#671, docs/deposit.md -> The frame's height): while the widget is on screen
// the frame fills the visible area of the Mini App under whatever stands above it, so the sheet the
// widget draws at its frame's bottom sits at the screen's bottom. It is refitted when the widget is
// shown, when a notice changes and on every stable viewportChanged; the widget's own resize is
// ignored.
export const CASHIER_CLIENT_JS = `(function () {
  'use strict';
  var SESSION_PATH = '/cashier/session';
  var CREDITED_PATH = '/cashier/credited';
  var SESSION_REUSE_MS = 45000;
  var HEIGHT_MIN = 480;
  var RETRY_STATES = { busy: true, unavailable: true };

  var webApp = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  var initData = webApp && typeof webApp.initData === 'string' ? webApp.initData : '';
  if (webApp && typeof webApp.ready === 'function') webApp.ready();

  function element(id) {
    return window.document.getElementById(id);
  }

  var frame = element('widget');
  var body = window.document.body;
  var working = element('working');
  var retry = element('retry');
  var close = element('close');
  // what the backend answered for the frame on screen; null until then, and every message is
  // ignored while it is
  var widgetOrigin = null;
  // the session minted on load, until the first ready takes it or a reauth drops it
  var pending = null;
  // bumped by every load; a mint result of an older generation is dropped
  var generation = 0;
  // a fresh mint (ready, reauth-required) is in flight
  var minting = false;

  function closeApp() {
    if (webApp && typeof webApp.close === 'function') webApp.close();
  }

  // the last stable height the Telegram client reported; an SDK without one leaves the window's
  function visibleHeight() {
    var height = webApp ? webApp.viewportStableHeight : undefined;
    if (typeof height !== 'number' || !isFinite(height) || height <= 0) height = window.innerHeight;
    return height;
  }

  // Never below HEIGHT_MIN: under it the page scrolls rather than the form collapsing.
  function fit() {
    if (frame === null || frame.hidden) return;
    var top = frame.getBoundingClientRect().top + (window.pageYOffset || 0);
    frame.style.height = Math.max(HEIGHT_MIN, Math.floor(visibleHeight() - top)) + 'px';
  }

  // data-widget on body hides the title and main's vertical padding while the widget is on screen
  function setFrameShown(shown) {
    if (frame === null) return;
    frame.hidden = !shown;
    if (shown) body.setAttribute('data-widget', '');
    else body.removeAttribute('data-widget');
    if (shown) fit();
  }

  function showNotice(notice) {
    var notices = window.document.querySelectorAll('[data-notice]');
    for (var index = 0; index < notices.length; index += 1) {
      notices[index].hidden = notices[index].getAttribute('data-notice') !== notice;
    }
    fit();
  }

  function hideStates() {
    var blocks = window.document.querySelectorAll('[data-state]');
    for (var index = 0; index < blocks.length; index += 1) blocks[index].hidden = true;
    if (retry) retry.hidden = true;
    if (close) close.hidden = true;
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
    setFrameShown(false);
    if (working) working.hidden = true;
    var retryable = RETRY_STATES[shown] === true;
    if (retry) retry.hidden = !retryable;
    if (close) close.hidden = retryable || shown === 'open_from_telegram';
    showNotice(null);
  }

  function showWorking() {
    hideStates();
    showNotice(null);
    if (working) working.hidden = false;
  }

  // the widget back on screen, whatever an earlier failure hid
  function showWidget() {
    hideStates();
    if (working) working.hidden = true;
    setFrameShown(true);
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

  // One mint, and a second at once when the first answers unavailable, unless a load has started
  // since; the second answer is the answer.
  function mintOnceMore(started) {
    return mint().then(function (answer) {
      if (answer.outcome !== 'unavailable' || started !== generation) return answer;
      return mint();
    });
  }

  function postInit(session) {
    frame.contentWindow.postMessage({ type: 'binodex-embed:init', session: session }, widgetOrigin);
  }

  function freshMint() {
    if (minting) return;
    minting = true;
    var started = generation;
    mintOnceMore(started).then(function (answer) {
      if (started !== generation) return;
      minting = false;
      if (answer.outcome !== 'ready') {
        showState(answer.outcome);
        return;
      }
      showWidget();
      postInit(answer.session);
    });
  }

  function onReady() {
    var held = pending;
    pending = null;
    if (held !== null && Date.now() - held.mintedAt < held.reuseMs) {
      postInit(held.session);
      return;
    }
    freshMint();
  }

  function onReauthRequired() {
    pending = null;
    freshMint();
  }

  // Fire and forget: the deposit happened at the broker whatever this POST meets, so its answer
  // changes nothing here.
  function onCredited() {
    showNotice('credited');
    window
      .fetch(CREDITED_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initData: initData }),
      })
      .then(
        function () {},
        function () {},
      );
  }

  if (webApp && typeof webApp.onEvent === 'function') {
    webApp.onEvent('viewportChanged', function (event) {
      if (event && event.isStateStable) fit();
    });
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
        // the frame is fitted to the visible area (#671); the widget's own height scrolls inside it
        return;
      case 'binodex-embed:close':
        closeApp();
        return;
      case 'binodex-embed:reauth-required':
        onReauthRequired();
        return;
      case 'binodex-embed:credited':
        onCredited();
        return;
      case 'binodex-embed:error':
        showNotice('widget_error');
        return;
      default:
        return;
    }
  });

  function load() {
    generation += 1;
    var started = generation;
    pending = null;
    minting = false;
    // messages of the frame on screen are ignored until this load's answer names its origin
    widgetOrigin = null;
    if (initData === '') {
      showState('open_from_telegram');
      return;
    }
    if (frame === null) {
      showState('unavailable');
      return;
    }
    showWorking();
    mintOnceMore(started).then(function (answer) {
      if (started !== generation) return;
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
      showWidget();
      frame.src = answer.widgetUrl;
    });
  }

  if (retry) retry.addEventListener('click', load);
  if (close) close.addEventListener('click', closeApp);

  load();
})();
`;
