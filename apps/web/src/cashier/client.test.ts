import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { CASHIER_CLIENT_JS } from './client';
import { CASHIER_RETRY_STATES, CashierState } from './pages';

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
  listeners: Record<string, () => void>;
  getAttribute(name: string): string | null;
  addEventListener(type: string, listener: () => void): void;
}

const element = (init: { hidden: boolean; state?: string }): FakeElement => {
  const listeners: Record<string, () => void> = {};
  return {
    ...init,
    listeners,
    getAttribute: (name) => (name === 'data-state' ? (init.state ?? null) : null),
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
  };
};

interface Options {
  // undefined: the SDK never loaded, so there is no Telegram global at all
  initData?: string;
  // answers of POST /cashier/session in order; a function answers with a rejected fetch
  answers?: (Answer | 'reject' | 'not-json')[];
}

function run(options: Options) {
  const order: string[] = [];
  let now = 1_000_000;
  const answers = [...(options.answers ?? [ready('S1')])];
  const blocks = Object.values(CashierState).map((state) => element({ hidden: true, state }));
  const posted: { message: unknown; target: unknown }[] = [];
  const widgetWindow = {
    postMessage: vi.fn((message: unknown, target: unknown) => {
      posted.push({ message, target });
    }),
  };
  const assigned: string[] = [];
  const frame = {
    ...element({ hidden: true }),
    contentWindow: widgetWindow,
    style: { height: '' },
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
  const webApp = { initData: options.initData, ready: vi.fn(), close: vi.fn() };
  const fetch = vi.fn((url: string, init: { method: string; headers: unknown; body: string }) => {
    order.push('fetch');
    void init;
    const next = answers.shift();
    if (next === undefined) throw new Error(`unexpected fetch of ${url}`);
    if (next === 'reject') return Promise.reject(new Error('network'));
    if (next === 'not-json') {
      return Promise.resolve({ ok: false, json: () => Promise.reject(new Error('not json')) });
    }
    const status = next.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(next.body),
    });
  });
  const listeners: ((event: unknown) => void)[] = [];
  const parent = { postMessage: vi.fn() };
  const location = { href: 'https://binarius.example/cashier', replace: vi.fn(), assign: vi.fn() };
  const history = { replaceState: vi.fn(), pushState: vi.fn() };
  const sandbox: Record<string, unknown> = {
    document: {
      body: { getAttribute: (name: string) => (name === 'data-page' ? 'cashier' : null) },
      getElementById: (id: string) => elements[id] ?? null,
      querySelectorAll: (selector: string) => (selector === '[data-state]' ? blocks : []),
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
  const advance = (ms: number) => {
    now += ms;
  };
  return {
    elements,
    frame,
    shown,
    fetch,
    webApp,
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
    const { fetch, frame, posted, shown, elements, webApp } = await loaded();
    expect(webApp.ready).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/cashier/session');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify({ initData: INIT_DATA }));
    expect(frame.src).toBe(WIDGET_URL);
    expect(frame.hidden).toBe(false);
    expect(frame.style.height).toBe('720px');
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
    expect(frame.style.height).toBe('720px');
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
    expect(frame.style.height).toBe('720px');
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

describe('resize (C7)', () => {
  it.each([
    ['a string', '800', '720px'],
    ['NaN', Number.NaN, '720px'],
    ['Infinity', Number.POSITIVE_INFINITY, '720px'],
    ['no height', undefined, '720px'],
    ['100', 100, '520px'],
    ['5000', 5000, '900px'],
    ['700', 700, '700px'],
  ])('%s -> %s', async (_label, height, expected) => {
    const { deliver, frame } = await loaded();
    deliver({ type: 'binodex-embed:resize', height });
    expect(frame.style.height).toBe(expected);
  });
});

describe('close (C8) and the events of #112 (C9)', () => {
  it('closes the Mini App once on close', async () => {
    const { deliver, webApp } = await loaded();
    deliver({ type: 'binodex-embed:close' });
    expect(webApp.close).toHaveBeenCalledOnce();
  });

  it.each(['binodex-embed:credited', 'binodex-embed:error', 'binodex-embed:reauth-required'])(
    '%s changes nothing yet',
    async (type) => {
      const { deliver, posted, fetch, shown, frame, webApp } = await loaded();
      deliver({ type, session: 'x', amount: 1 });
      await settle();
      expect(posted).toEqual([]);
      expect(fetch).toHaveBeenCalledOnce();
      expect(shown()).toEqual([]);
      expect(frame.hidden).toBe(false);
      expect(webApp.close).not.toHaveBeenCalled();
    },
  );
});

describe('the states (C11)', () => {
  it.each(Object.values(CashierState).filter((state) => state !== 'open_from_telegram'))(
    'shows %s with its button, the iframe hidden',
    async (state) => {
      const { shown, frame, elements } = await loaded({
        initData: INIT_DATA,
        answers: [{ status: state === 'busy' ? 429 : 200, body: { outcome: state } }],
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

  it.each([
    ['an unknown outcome', { status: 200, body: { outcome: 'something_new' } }],
    ['a ready answer without a session', { body: { ...(ready('S1').body as object), session: 1 } }],
    ['no outcome', { body: { ok: true } }],
    ['a JSON null', { body: null }],
    ['a body that is not JSON', 'not-json' as const],
    ['a rejected fetch', 'reject' as const],
  ])('shows unavailable for %s', async (_label, answer) => {
    const { shown, frame, elements } = await loaded({ initData: INIT_DATA, answers: [answer] });
    expect(shown()).toEqual(['unavailable']);
    expect(frame.hidden).toBe(true);
    expect(elements.retry?.hidden).toBe(false);
  });

  it('«Повторить» runs the load again', async () => {
    const { elements, fetch, frame, shown } = await loaded({
      initData: INIT_DATA,
      answers: [{ status: 500, body: { outcome: 'unavailable' } }, ready('S1')],
    });
    expect(shown()).toEqual(['unavailable']);
    elements.retry?.listeners.click?.();
    expect(elements.working?.hidden).toBe(false);
    expect(shown()).toEqual([]);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
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
