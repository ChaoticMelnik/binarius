import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { CASHIER_CLIENT_JS } from './client';
import { CASHIER_RETRY_STATES, CashierNotice, CashierState } from './pages';

const INIT_DATA = 'query_id=AA%2BBB&user=%7B%22first_name%22%3A%22A+B%22%7D&auth_date=1&hash=ff';
const WIDGET_ORIGIN = 'https://binodex.app';
const WIDGET_URL = 'https://binodex.app/embed/pay?client_id=client';

interface Answer {
  status?: number;
  body: unknown;
}

const ready = (session: string, expiresInSec = 600): Answer => ({
  body: {
    outcome: 'ready',
    session,
    expiresInSec,
    widgetUrl: WIDGET_URL,
    widgetOrigin: WIDGET_ORIGIN,
  },
});

interface FakeElement {
  hidden: boolean;
  state?: string;
  notice?: string;
  listeners: Record<string, () => void>;
  getAttribute(name: string): string | null;
  addEventListener(type: string, listener: () => void): void;
}

const element = (init: { hidden: boolean; state?: string; notice?: string }): FakeElement => {
  const listeners: Record<string, () => void> = {};
  return {
    ...init,
    listeners,
    getAttribute: (name) =>
      name === 'data-state'
        ? (init.state ?? null)
        : name === 'data-notice'
          ? (init.notice ?? null)
          : null,
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
  };
};

// 'defer': the answer is held until the test settles it through `deferred`
type Scripted = Answer | 'reject' | 'not-json' | 'defer';

interface Options {
  // undefined: the SDK never loaded, so there is no Telegram global at all
  initData?: string;
  // answers of POST /cashier/session in order
  answers?: Scripted[];
  // answers of POST /cashier/credited in order; 204 when the list is spent
  creditedAnswers?: Scripted[];
  // WebApp.viewportStableHeight, 570 by default; 'absent': the SDK has no such property
  viewportStableHeight?: unknown;
  // false: the SDK has no onEvent
  onEvent?: false;
}

const respond = (next: Answer | 'reject' | 'not-json') => {
  if (next === 'reject') return Promise.reject(new Error('network'));
  if (next === 'not-json') {
    return Promise.resolve({ ok: false, json: () => Promise.reject(new Error('not json')) });
  }
  const status = next.status ?? 200;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(next.body),
  });
};

function run(options: Options) {
  const order: string[] = [];
  let now = 1_000_000;
  const answers = [...(options.answers ?? [ready('S1')])];
  const creditedAnswers = [...(options.creditedAnswers ?? [])];
  const blocks = Object.values(CashierState).map((state) => element({ hidden: true, state }));
  const notices = Object.values(CashierNotice).map((notice) => element({ hidden: true, notice }));
  // every request the script made, in order
  const requests: { url: string; body: string }[] = [];
  // the held answers, oldest first; settle one with its answer
  const deferred: ((answer: Answer | 'reject' | 'not-json') => void)[] = [];
  const posted: { message: unknown; target: unknown }[] = [];
  const widgetWindow = {
    postMessage: vi.fn((message: unknown, target: unknown) => {
      posted.push({ message, target });
    }),
  };
  const assigned: string[] = [];
  let frameTop = 0;
  const frame = {
    ...element({ hidden: true }),
    contentWindow: widgetWindow,
    style: { height: '' },
    getBoundingClientRect: () => ({ top: frameTop }),
    _src: '',
    get src() {
      return this._src;
    },
    set src(value: string) {
      order.push('src');
      assigned.push(value);
      this._src = value;
    },
  };
  const elements: Record<string, FakeElement> = {
    working: element({ hidden: false }),
    retry: element({ hidden: true }),
    close: element({ hidden: true }),
    widget: frame,
  };
  const viewportHandlers: ((event: unknown) => void)[] = [];
  const webApp: Record<string, unknown> = {
    initData: options.initData,
    ready: vi.fn(),
    close: vi.fn(),
    onEvent: vi.fn((type: string, handler: (event: unknown) => void) => {
      if (type === 'viewportChanged') viewportHandlers.push(handler);
    }),
    viewportStableHeight: 'viewportStableHeight' in options ? options.viewportStableHeight : 570,
  };
  if (options.viewportStableHeight === 'absent') delete webApp.viewportStableHeight;
  if (options.onEvent === false) delete webApp.onEvent;
  const bodyAttributes = new Map<string, string>();
  const fetch = vi.fn((url: string, init: { method: string; headers: unknown; body: string }) => {
    order.push('fetch');
    requests.push({ url, body: init.body });
    const queue = url === '/cashier/credited' ? creditedAnswers : answers;
    const next =
      queue.shift() ?? (url === '/cashier/credited' ? { status: 204, body: null } : undefined);
    if (next === undefined) throw new Error(`unexpected fetch of ${url}`);
    if (next === 'defer') {
      return new Promise((resolve, reject) => {
        deferred.push((answer) => {
          respond(answer).then(resolve, reject);
        });
      });
    }
    return respond(next);
  });
  const listeners: ((event: unknown) => void)[] = [];
  const parent = { postMessage: vi.fn() };
  const location = { href: 'https://binarius.example/cashier', replace: vi.fn(), assign: vi.fn() };
  const history = { replaceState: vi.fn(), pushState: vi.fn() };
  const sandbox: Record<string, unknown> = {
    document: {
      body: {
        getAttribute: (name: string) =>
          name === 'data-page' ? 'cashier' : (bodyAttributes.get(name) ?? null),
        setAttribute: (name: string, value: string) => {
          bodyAttributes.set(name, value);
        },
        removeAttribute: (name: string) => {
          bodyAttributes.delete(name);
        },
        hasAttribute: (name: string) => bodyAttributes.has(name),
      },
      getElementById: (id: string) => elements[id] ?? null,
      querySelectorAll: (selector: string) =>
        selector === '[data-state]' ? blocks : selector === '[data-notice]' ? notices : [],
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === 'message') {
        order.push('listen');
        listeners.push(listener);
      }
    },
    parent,
    location,
    history,
    fetch,
    Date: { now: () => now },
    innerHeight: 800,
    pageYOffset: 0,
    ...(options.initData === undefined ? {} : { Telegram: { WebApp: webApp } }),
  };
  sandbox.window = sandbox;
  runInNewContext(CASHIER_CLIENT_JS, sandbox);

  const deliver = (data: unknown, from: { source?: unknown; origin?: string } = {}) => {
    for (const listener of listeners) {
      listener({
        data,
        source: 'source' in from ? from.source : widgetWindow,
        origin: from.origin ?? WIDGET_ORIGIN,
      });
    }
  };
  const shown = () => blocks.filter((block) => !block.hidden).map((block) => block.state);
  const noticed = () => notices.filter((block) => !block.hidden).map((block) => block.notice);
  // what the script wrote into the page besides `hidden` and the frame's own fields
  const written = () =>
    [...blocks, ...notices, ...Object.values(elements)].flatMap((target) =>
      Object.keys(target).filter((key) => key === 'textContent' || key === 'innerHTML'),
    );
  const advance = (ms: number) => {
    now += ms;
  };
  const setFrameTop = (top: number) => {
    frameTop = top;
  };
  const viewportChanged = (isStateStable: boolean) => {
    for (const handler of viewportHandlers) handler.call(webApp, { isStateStable });
  };
  const widgetShown = () => bodyAttributes.has('data-widget');
  return {
    sandbox,
    setFrameTop,
    viewportChanged,
    widgetShown,
    elements,
    frame,
    shown,
    fetch,
    requests,
    deferred,
    noticed,
    written,
    webApp: webApp as typeof webApp & {
      ready: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      onEvent: ReturnType<typeof vi.fn>;
    },
    posted,
    assigned,
    deliver,
    advance,
    order,
    parent,
    location,
    history,
    widgetWindow,
  };
}

// lets the fetch chain settle
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const loaded = async (options: Options = { initData: INIT_DATA }) => {
  const page = run(options);
  await settle();
  return page;
};

describe('the load', () => {
  it('mints a session, shows the widget at the answered URL and posts nothing yet', async () => {
    const { fetch, frame, posted, shown, elements, webApp, widgetShown } = await loaded();
    expect(webApp.ready).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/cashier/session');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify({ initData: INIT_DATA }));
    expect(frame.src).toBe(WIDGET_URL);
    expect(frame.hidden).toBe(false);
    expect(frame.style.height).toBe('570px');
    expect(widgetShown()).toBe(true);
    expect(elements.working?.hidden).toBe(true);
    expect(shown()).toEqual([]);
    expect(posted).toEqual([]);
  });

  // C13
  it('listens for messages before the widget is loaded', async () => {
    const { order } = await loaded();
    expect(order).toEqual(['listen', 'fetch', 'src']);
  });

  // C10
  it.each([
    ['empty launch data', ''],
    ['no Telegram SDK', undefined],
  ])('with %s asks to open it from Telegram, without a request', async (_label, initData) => {
    const { fetch, frame, shown, elements } = await loaded(
      initData === undefined ? {} : { initData },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(frame.src).toBe('');
    expect(frame.hidden).toBe(true);
    expect(shown()).toEqual(['open_from_telegram']);
    expect(elements.retry?.hidden).toBe(true);
    expect(elements.close?.hidden).toBe(true);
  });
});

describe('the message filter', () => {
  // C1
  it('ignores the right message from a wrong origin', async () => {
    const { deliver, posted, fetch, frame } = await loaded();
    deliver({ type: 'binodex-embed:ready' }, { origin: 'https://evil.example' });
    deliver({ type: 'binodex-embed:resize', height: 900 }, { origin: 'https://evil.example' });
    deliver({ type: 'binodex-embed:close' }, { origin: 'https://binodex.app.evil.example' });
    await settle();
    expect(posted).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(frame.style.height).toBe('570px');
  });

  // C2
  it('ignores the right message from the right origin but another window', async () => {
    const { deliver, posted, fetch, parent, webApp, frame } = await loaded();
    deliver({ type: 'binodex-embed:ready' }, { source: parent });
    deliver({ type: 'binodex-embed:resize', height: 900 }, { source: parent });
    deliver({ type: 'binodex-embed:close' }, { source: null });
    await settle();
    expect(posted).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(webApp.close).not.toHaveBeenCalled();
    expect(frame.style.height).toBe('570px');
  });

  it('ignores every message before the widget is loaded', async () => {
    const page = run({ initData: INIT_DATA });
    page.deliver({ type: 'binodex-embed:ready' });
    await settle();
    expect(page.posted).toEqual([]);
    expect(page.fetch).toHaveBeenCalledOnce();
  });

  // C3
  it.each([
    ['null', null],
    ['a string', 'binodex-embed:ready'],
    ['no type', { session: 'x' }],
    ['a non-string type', { type: 1 }],
    ['an unknown type', { type: 'binodex-embed:something' }],
  ])('ignores data that is %s', async (_label, data) => {
    const { deliver, posted, fetch, shown, frame } = await loaded();
    deliver(data);
    await settle();
    expect(posted).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(shown()).toEqual([]);
    expect(frame.hidden).toBe(false);
  });
});

describe('ready -> init', () => {
  // C4, C6
  it('gives the first ready the load session, and every later one a fresh session', async () => {
    const { deliver, posted, fetch } = await loaded({
      initData: INIT_DATA,
      answers: [ready('S1'), ready('S2')],
    });
    deliver({ type: 'binodex-embed:ready' });
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
    expect(posted).toEqual([
      { message: { type: 'binodex-embed:init', session: 'S1' }, target: WIDGET_ORIGIN },
    ]);

    deliver({ type: 'binodex-embed:ready' });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(posted[1]).toEqual({
      message: { type: 'binodex-embed:init', session: 'S2' },
      target: WIDGET_ORIGIN,
    });
  });

  // C5
  it.each([
    ['after 45 s', 600, 45_000],
    ['after the session expired, sooner than 45 s', 30, 30_000],
  ])('mints fresh for the first ready %s', async (_label, expiresInSec, wait) => {
    const { deliver, posted, fetch, advance } = await loaded({
      initData: INIT_DATA,
      answers: [ready('S1', expiresInSec), ready('S2')],
    });
    advance(wait);
    deliver({ type: 'binodex-embed:ready' });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(posted).toEqual([
      { message: { type: 'binodex-embed:init', session: 'S2' }, target: WIDGET_ORIGIN },
    ]);
  });

  it('reuses the load session one millisecond before its window ends', async () => {
    const { deliver, posted, fetch, advance } = await loaded({
      initData: INIT_DATA,
      answers: [ready('S1', 30)],
    });
    advance(29_999);
    deliver({ type: 'binodex-embed:ready' });
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
    expect(posted.map((entry) => entry.message)).toEqual([
      { type: 'binodex-embed:init', session: 'S1' },
    ]);
  });

  // C14
  it('shows the state of a failed fresh mint and posts nothing', async () => {
    const { deliver, posted, shown, frame, elements } = await loaded({
      initData: INIT_DATA,
      answers: [ready('S1'), ready('S2'), { body: { outcome: 'relogin' } }],
    });
    deliver({ type: 'binodex-embed:ready' });
    await settle();
    deliver({ type: 'binodex-embed:ready' });
    await settle();
    deliver({ type: 'binodex-embed:ready' });
    await settle();
    expect(posted.map((entry) => (entry.message as { session: string }).session)).toEqual([
      'S1',
      'S2',
    ]);
    expect(shown()).toEqual(['relogin']);
    expect(frame.hidden).toBe(true);
    expect(elements.close?.hidden).toBe(false);
  });
});

describe("the frame's height (#671)", () => {
  it('H1 fills the visible height on load and listens for viewportChanged', async () => {
    const { frame, webApp, widgetShown } = await loaded();
    expect(frame.style.height).toBe('570px');
    expect(webApp.onEvent).toHaveBeenCalledWith('viewportChanged', expect.any(Function));
    expect(widgetShown()).toBe(true);
  });

  it('H2 shrinks by a notice above the frame, rounding down', async () => {
    const { deliver, frame, setFrameTop, widgetShown } = await loaded();
    setFrameTop(56);
    deliver({ type: 'binodex-embed:credited' });
    expect(frame.style.height).toBe('514px');
    setFrameTop(56.5);
    deliver({ type: 'binodex-embed:error' });
    expect(frame.style.height).toBe('513px');
    expect(frame.hidden).toBe(false);
    expect(widgetShown()).toBe(true);
  });

  it.each([
    [400, '480px'],
    [479, '480px'],
    [480, '480px'],
    [481, '481px'],
  ])('H3 a visible height of %s gives %s', async (viewportStableHeight, expected) => {
    const { frame } = await loaded({ initData: INIT_DATA, viewportStableHeight });
    expect(frame.style.height).toBe(expected);
  });

  it('H4 follows stable viewportChanged events only', async () => {
    const { frame, webApp, viewportChanged } = await loaded();
    webApp.viewportStableHeight = 844;
    viewportChanged(true);
    expect(frame.style.height).toBe('844px');
    webApp.viewportStableHeight = 300;
    viewportChanged(false);
    expect(frame.style.height).toBe('844px');
    webApp.viewportStableHeight = 600;
    viewportChanged(true);
    expect(frame.style.height).toBe('600px');
  });

  it.each([
    ['absent', 'absent'],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['0', 0],
    ['-1', -1],
    ['a string', '570'],
  ])('H5 a viewportStableHeight that is %s falls back to the window', async (_label, value) => {
    const { frame } = await loaded({ initData: INIT_DATA, viewportStableHeight: value });
    expect(frame.style.height).toBe('800px');
  });

  it.each([
    ['a string', '800'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['no height', undefined],
    ['100', 100],
    ['5000', 5000],
    ['700', 700],
  ])('H6 ignores the widget resize with %s', async (_label, height) => {
    const { deliver, frame } = await loaded();
    deliver({ type: 'binodex-embed:resize', height });
    expect(frame.style.height).toBe('570px');
  });

  const failedFreshMint = async () => {
    const page = await loaded({
      initData: INIT_DATA,
      answers: [ready('S1'), { body: { outcome: 'relogin' } }],
    });
    page.deliver({ type: 'binodex-embed:reauth-required' });
    await settle();
    expect(page.shown()).toEqual(['relogin']);
    return page;
  };

  it('H7 a state after a failed fresh mint brings the title back', async () => {
    const { frame, widgetShown } = await failedFreshMint();
    expect(frame.hidden).toBe(true);
    expect(widgetShown()).toBe(false);
  });

  it('H7b a stable viewportChanged leaves a hidden frame alone', async () => {
    const { frame, webApp, viewportChanged } = await failedFreshMint();
    webApp.viewportStableHeight = 900;
    viewportChanged(true);
    expect(frame.style.height).toBe('570px');
  });

  it('H8 «Повторить» keeps the title while the cashier opens, then fits the widget', async () => {
    const { elements, webApp, frame, widgetShown } = await loaded({
      initData: INIT_DATA,
      answers: [UNAVAILABLE, UNAVAILABLE, ready('S1')],
    });
    expect(widgetShown()).toBe(false);
    elements.retry?.listeners.click?.();
    expect(elements.working?.hidden).toBe(false);
    expect(widgetShown()).toBe(false);
    webApp.viewportStableHeight = 650;
    await settle();
    expect(widgetShown()).toBe(true);
    expect(frame.style.height).toBe('650px');
  });

  it('H9 measures the frame from the top of a scrolled page', async () => {
    const { frame, sandbox, setFrameTop, viewportChanged } = await loaded();
    sandbox.pageYOffset = 40;
    setFrameTop(-40);
    viewportChanged(true);
    expect(frame.style.height).toBe('570px');
    setFrameTop(16);
    viewportChanged(true);
    expect(frame.style.height).toBe('514px');
  });

  it('H10 loads the widget with an SDK without onEvent', async () => {
    const { frame, widgetShown } = await loaded({ initData: INIT_DATA, onEvent: false });
    expect(frame.hidden).toBe(false);
    expect(frame.style.height).toBe('570px');
    expect(widgetShown()).toBe(true);
  });

  it('H11 fits the widget again when a fresh mint brings it back', async () => {
    const { deliver, frame, webApp, shown, widgetShown } = await loaded({
      initData: INIT_DATA,
      answers: [ready('S1'), BUSY, ready('S2')],
    });
    deliver({ type: 'binodex-embed:ready' });
    await settle();
    deliver({ type: 'binodex-embed:ready' });
    await settle();
    expect(shown()).toEqual(['busy']);
    webApp.viewportStableHeight = 700;
    deliver({ type: 'binodex-embed:reauth-required' });
    await settle();
    expect(widgetShown()).toBe(true);
    expect(frame.style.height).toBe('700px');
  });

  it('H12 keeps the title on open_from_telegram', async () => {
    const { widgetShown, frame } = await loaded({ initData: '' });
    expect(frame.hidden).toBe(true);
    expect(widgetShown()).toBe(false);
  });
});

describe('close (C8)', () => {
  it('closes the Mini App once on close', async () => {
    const { deliver, webApp } = await loaded();
    deliver({ type: 'binodex-embed:close' });
    expect(webApp.close).toHaveBeenCalledOnce();
  });
});

describe('the states (C11)', () => {
  it.each(Object.values(CashierState).filter((state) => state !== 'open_from_telegram'))(
    'shows %s with its button, the iframe hidden',
    async (state) => {
      const answer = { status: state === 'busy' ? 429 : 200, body: { outcome: state } };
      // unavailable is asked once more at once (C20)
      const { shown, frame, elements } = await loaded({
        initData: INIT_DATA,
        answers: state === 'unavailable' ? [answer, answer] : [answer],
      });
      expect(shown()).toEqual([state]);
      expect(frame.hidden).toBe(true);
      expect(frame.src).toBe('');
      expect(elements.working?.hidden).toBe(true);
      const retryable = CASHIER_RETRY_STATES.includes(state);
      expect(elements.retry?.hidden).toBe(!retryable);
      expect(elements.close?.hidden).toBe(retryable);
    },
  );

  it('shows open_from_telegram from the route with neither button', async () => {
    const { shown, elements } = await loaded({
      initData: INIT_DATA,
      answers: [{ body: { outcome: 'open_from_telegram' } }],
    });
    expect(shown()).toEqual(['open_from_telegram']);
    expect(elements.retry?.hidden).toBe(true);
    expect(elements.close?.hidden).toBe(true);
  });

  it('shows unavailable for an unknown outcome, without asking again', async () => {
    const { shown, frame, elements, fetch } = await loaded({
      initData: INIT_DATA,
      answers: [{ status: 200, body: { outcome: 'something_new' } }],
    });
    expect(shown()).toEqual(['unavailable']);
    expect(frame.hidden).toBe(true);
    expect(elements.retry?.hidden).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['the route', { status: 500, body: { outcome: 'unavailable' } }],
    ['a ready answer without a session', { body: { ...(ready('S1').body as object), session: 1 } }],
    ['no outcome', { body: { ok: true } }],
    ['a JSON null', { body: null }],
    ['a body that is not JSON', 'not-json' as const],
    ['a rejected fetch', 'reject' as const],
  ])('shows unavailable from %s after the second answer', async (_label, answer) => {
    const { shown, frame, elements, fetch } = await loaded({
      initData: INIT_DATA,
      answers: [answer, answer],
    });
    expect(shown()).toEqual(['unavailable']);
    expect(frame.hidden).toBe(true);
    expect(elements.retry?.hidden).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('«Повторить» runs the load again', async () => {
    const { elements, fetch, frame, shown } = await loaded({
      initData: INIT_DATA,
      answers: [
        { status: 500, body: { outcome: 'unavailable' } },
        { status: 500, body: { outcome: 'unavailable' } },
        ready('S1'),
      ],
    });
    expect(shown()).toEqual(['unavailable']);
    elements.retry?.listeners.click?.();
    expect(elements.working?.hidden).toBe(false);
    expect(shown()).toEqual([]);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(frame.src).toBe(WIDGET_URL);
    expect(frame.hidden).toBe(false);
  });

  it('«Вернуться в Telegram» closes the Mini App', async () => {
    const { elements, webApp } = await loaded({
      initData: INIT_DATA,
      answers: [{ body: { outcome: 'blocked' } }],
    });
    elements.close?.listeners.click?.();
    expect(webApp.close).toHaveBeenCalledOnce();
  });
});

describe('the session never in a URL (C12)', () => {
  it('assigns and requests only URLs without it, and touches neither history nor location', async () => {
    const { deliver, assigned, fetch, history, location } = await loaded({
      initData: INIT_DATA,
      answers: [ready('SESSION-ONE'), ready('SESSION-TWO')],
    });
    deliver({ type: 'binodex-embed:ready' });
    await settle();
    deliver({ type: 'binodex-embed:ready' });
    await settle();
    const urls = [...assigned, ...fetch.mock.calls.map(([url]) => url)];
    expect(urls).toEqual([WIDGET_URL, '/cashier/session', '/cashier/session']);
    for (const url of urls) {
      expect(url).not.toContain('SESSION-ONE');
      expect(url).not.toContain('SESSION-TWO');
    }
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(history.pushState).not.toHaveBeenCalled();
    expect(location.replace).not.toHaveBeenCalled();
    expect(location.assign).not.toHaveBeenCalled();
    expect(location.href).toBe('https://binarius.example/cashier');
  });
});

const BUSY: Answer = { status: 429, body: { outcome: 'busy' } };
const UNAVAILABLE: Answer = { status: 500, body: { outcome: 'unavailable' } };
const sessionsPosted = (posted: { message: unknown }[]) =>
  posted.map((entry) => (entry.message as { session: string }).session);

describe('credited (C15, C16)', () => {
  it('C15 shows the credited notice, keeps the widget and posts initData alone', async () => {
    const { deliver, noticed, frame, requests, posted, shown } = await loaded();
    deliver({ type: 'binodex-embed:credited', amount: 100, currency: 'USD' });
    await settle();
    expect(noticed()).toEqual(['credited']);
    expect(shown()).toEqual([]);
    expect(frame.hidden).toBe(false);
    expect(requests.slice(1)).toEqual([
      { url: '/cashier/credited', body: JSON.stringify({ initData: INIT_DATA }) },
    ]);
    expect(posted).toEqual([]);
  });

  it.each([
    ['a rejected fetch', 'reject' as const],
    ['a 500', { status: 500, body: null }],
    ['a 429', { status: 429, body: { outcome: 'busy' } }],
  ])('C16 changes nothing else on %s', async (_label, answer) => {
    const { deliver, noticed, frame, posted, shown, elements, fetch } = await loaded({
      initData: INIT_DATA,
      creditedAnswers: [answer],
    });
    deliver({ type: 'binodex-embed:credited' });
    await settle();
    expect(noticed()).toEqual(['credited']);
    expect(shown()).toEqual([]);
    expect(frame.hidden).toBe(false);
    expect(elements.retry?.hidden).toBe(true);
    expect(posted).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('error (C17)', () => {
  it('shows the fixed notice over the widget and never reads the message', async () => {
    const message = '<img src=x onerror=alert(1)>';
    const { deliver, noticed, frame, written, requests, shown } = await loaded();
    deliver({ type: 'binodex-embed:credited' });
    deliver({ type: 'binodex-embed:error', message });
    await settle();
    expect(noticed()).toEqual(['widget_error']);
    expect(shown()).toEqual([]);
    expect(frame.hidden).toBe(false);
    expect(written()).toEqual([]);
    for (const request of requests) expect(request.body).not.toContain('onerror');
  });
});

describe('reauth-required (C18, C19, C22)', () => {
  it('C18 posts a fresh session to the same frame without a reload, and drops the load session', async () => {
    const { deliver, posted, fetch, assigned } = await loaded({
      initData: INIT_DATA,
      answers: [ready('S1'), ready('S2'), ready('S3')],
    });
    deliver({ type: 'binodex-embed:reauth-required' });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(posted).toEqual([
      { message: { type: 'binodex-embed:init', session: 'S2' }, target: WIDGET_ORIGIN },
    ]);
    expect(assigned).toEqual([WIDGET_URL]);

    deliver({ type: 'binodex-embed:ready' });
    await settle();
    expect(sessionsPosted(posted)).toEqual(['S2', 'S3']);
    expect(assigned).toEqual([WIDGET_URL]);
  });

  it.each([
    ['two reauth-required', ['binodex-embed:reauth-required', 'binodex-embed:reauth-required']],
    ['a ready and a reauth-required', ['binodex-embed:ready', 'binodex-embed:reauth-required']],
  ])('C19 coalesces %s while a mint is in flight: one POST, one init', async (_label, types) => {
    const { deliver, posted, fetch, deferred } = await loaded({
      initData: INIT_DATA,
      answers: [ready('S1'), 'defer'],
    });
    deliver({ type: 'binodex-embed:reauth-required' });
    for (const type of types) deliver({ type });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    deferred[0]?.(ready('S2'));
    await settle();
    expect(sessionsPosted(posted)).toEqual(['S2']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('C22 shows busy from a reauth mint without asking again, hiding the notice', async () => {
    const { deliver, shown, fetch, posted, noticed, frame } = await loaded({
      initData: INIT_DATA,
      answers: [ready('S1'), BUSY],
    });
    deliver({ type: 'binodex-embed:credited' });
    deliver({ type: 'binodex-embed:reauth-required' });
    await settle();
    expect(shown()).toEqual(['busy']);
    expect(noticed()).toEqual([]);
    expect(frame.hidden).toBe(true);
    expect(posted).toEqual([]);
    expect(fetch.mock.calls.filter(([url]) => url === '/cashier/session')).toHaveLength(2);
  });
});

describe('one more mint on unavailable (C20)', () => {
  it('on the load: the second answer loads the widget', async () => {
    const { deliver, frame, posted, fetch, shown } = await loaded({
      initData: INIT_DATA,
      answers: [UNAVAILABLE, ready('S1')],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(shown()).toEqual([]);
    expect(frame.src).toBe(WIDGET_URL);
    deliver({ type: 'binodex-embed:ready' });
    await settle();
    expect(sessionsPosted(posted)).toEqual(['S1']);
  });

  it.each([
    ['a fresh ready', 'binodex-embed:ready', 'not-json' as const],
    ['reauth-required', 'binodex-embed:reauth-required', 'reject' as const],
  ])('on %s: the second answer is posted', async (_label, type, failure) => {
    const { deliver, posted, fetch, shown } = await loaded({
      initData: INIT_DATA,
      answers: [ready('S1'), failure, ready('S2')],
    });
    if (type === 'binodex-embed:ready') {
      deliver({ type });
      await settle();
    }
    deliver({ type });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(shown()).toEqual([]);
    expect(sessionsPosted(posted).at(-1)).toBe('S2');
  });

  it('shows unavailable after two, posting nothing', async () => {
    const { deliver, posted, fetch, shown } = await loaded({
      initData: INIT_DATA,
      answers: [ready('S1'), UNAVAILABLE, UNAVAILABLE],
    });
    deliver({ type: 'binodex-embed:reauth-required' });
    await settle();
    expect(shown()).toEqual(['unavailable']);
    expect(posted).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('the order of mint results (C21)', () => {
  // a fresh mint in flight, then «Повторить» starts a new load that shows its widget
  const reloadedDuringMint = async () => {
    const page = await loaded({
      initData: INIT_DATA,
      answers: [ready('S1'), 'defer', ready('S3')],
    });
    page.deliver({ type: 'binodex-embed:reauth-required' });
    await settle();
    page.elements.retry?.listeners.click?.();
    await settle();
    expect(page.assigned).toEqual([WIDGET_URL, WIDGET_URL]);
    return page;
  };

  it('a: drops a failure of the older load', async () => {
    const { deferred, shown, frame, elements } = await reloadedDuringMint();
    deferred[0]?.(BUSY);
    await settle();
    expect(shown()).toEqual([]);
    expect(frame.hidden).toBe(false);
    expect(elements.retry?.hidden).toBe(true);
  });

  it('b: posts no session of the older load', async () => {
    const { deferred, posted, deliver } = await reloadedDuringMint();
    deferred[0]?.(ready('S2'));
    await settle();
    expect(posted).toEqual([]);
    deliver({ type: 'binodex-embed:ready' });
    await settle();
    expect(sessionsPosted(posted)).toEqual(['S3']);
  });

  it('c: shows the widget again when a fresh mint succeeds after one failed', async () => {
    const { deliver, posted, frame, shown, elements } = await loaded({
      initData: INIT_DATA,
      answers: [ready('S1'), BUSY, ready('S2')],
    });
    deliver({ type: 'binodex-embed:ready' });
    await settle();
    deliver({ type: 'binodex-embed:ready' });
    await settle();
    expect(shown()).toEqual(['busy']);
    expect(frame.hidden).toBe(true);

    deliver({ type: 'binodex-embed:reauth-required' });
    await settle();
    expect(frame.hidden).toBe(false);
    expect(shown()).toEqual([]);
    expect(elements.retry?.hidden).toBe(true);
    expect(elements.close?.hidden).toBe(true);
    expect(sessionsPosted(posted)).toEqual(['S1', 'S2']);
  });
});
