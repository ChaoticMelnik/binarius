import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { OAUTH_CLIENT_JS } from './client';
import { CallbackOutcome } from './pages';

// `+` is a signed space and `%2B` a signed plus: the script must post them exactly as given
const INIT_DATA = 'query_id=AA%2BBB&user=%7B%22first_name%22%3A%22A+B%22%7D&auth_date=1&hash=ff';
const AUTHORIZE_HREF = 'https://binodex.app/oauth/authorize?state=s&redirect_uri=x';

interface FakeElement {
  hidden: boolean;
  href?: string;
  outcome?: string;
  listeners: Record<string, () => void>;
  getAttribute(name: string): string | null;
  addEventListener(type: string, listener: () => void): void;
}

const element = (init: { hidden: boolean; href?: string; outcome?: string }): FakeElement => {
  const listeners: Record<string, () => void> = {};
  return {
    ...init,
    listeners,
    getAttribute: (name) => (name === 'data-outcome' ? (init.outcome ?? null) : null),
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
  };
};

type FetchResult = { ok: boolean; json: () => Promise<unknown> };

interface Options {
  page: 'login' | 'callback';
  // undefined: the SDK never loaded, so there is no Telegram global at all
  initData?: string;
  search?: string;
  fetch?: () => Promise<FetchResult>;
}

function run(options: Options) {
  const order: string[] = [];
  const blocks = Object.values(CallbackOutcome).map((outcome) =>
    element({ hidden: true, outcome }),
  );
  const elements: Record<string, FakeElement> = {
    working: element({ hidden: false }),
    close: element({ hidden: true }),
    authorize: element({ hidden: false, href: AUTHORIZE_HREF }),
  };
  const webApp = {
    initData: options.initData,
    ready: vi.fn(),
    close: vi.fn(),
  };
  const fetch = vi.fn((url: string, init: { method: string; headers: unknown; body: string }) => {
    order.push('fetch');
    void url;
    void init;
    return (
      options.fetch ??
      (() => Promise.resolve({ ok: true, json: () => Promise.resolve({ outcome: 'linked' }) }))
    )();
  });
  const location = {
    search: options.search ?? '',
    pathname: '/oauth/callback',
    replace: vi.fn(),
  };
  const history = {
    replaceState: vi.fn(() => {
      order.push('replaceState');
    }),
  };
  const sandbox: Record<string, unknown> = {
    document: {
      body: { getAttribute: (name: string) => (name === 'data-page' ? options.page : null) },
      getElementById: (id: string) => elements[id] ?? null,
      querySelectorAll: (selector: string) => (selector === '[data-outcome]' ? blocks : []),
    },
    location,
    history,
    fetch,
    URLSearchParams,
    ...(options.initData === undefined ? {} : { Telegram: { WebApp: webApp } }),
  };
  sandbox.window = sandbox;
  runInNewContext(OAUTH_CLIENT_JS, sandbox);

  const shown = () => blocks.filter((block) => !block.hidden).map((block) => block.outcome);
  return { elements, shown, fetch, location, history, webApp, order };
}

// lets the fetch chain settle
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the login page script', () => {
  it('navigates the same webview to the broker when launched from Telegram', () => {
    const { location, webApp, shown } = run({ page: 'login', initData: INIT_DATA });
    expect(webApp.ready).toHaveBeenCalledOnce();
    expect(location.replace).toHaveBeenCalledWith(AUTHORIZE_HREF);
    expect(shown()).toEqual([]);
  });

  it.each([
    ['empty launch data', ''],
    ['no Telegram SDK', undefined],
  ])('stays put with %s and asks to open it from Telegram', (_label, initData) => {
    const { location, elements, shown } = run({
      page: 'login',
      ...(initData === undefined ? {} : { initData }),
    });
    expect(location.replace).not.toHaveBeenCalled();
    expect(elements.authorize?.hidden).toBe(true);
    expect(elements.working?.hidden).toBe(true);
    expect(shown()).toEqual(['open_from_telegram']);
  });
});

describe('the callback page script', () => {
  const search = `?code=CODE-1&state=STATE-1`;

  it('posts state, code and the raw launch data, after dropping the query', async () => {
    const { fetch, history, order, shown, elements } = run({
      page: 'callback',
      initData: INIT_DATA,
      search,
    });
    await settle();

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/oauth/callback');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(init?.body).toBe(
      JSON.stringify({ state: 'STATE-1', code: 'CODE-1', initData: INIT_DATA }),
    );
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/oauth/callback');
    expect(order).toEqual(['replaceState', 'fetch']);
    expect(shown()).toEqual(['linked']);
    expect(elements.working?.hidden).toBe(true);
    expect(elements.close?.hidden).toBe(false);
  });

  it.each([
    ['empty launch data', ''],
    ['no Telegram SDK', undefined],
  ])('calls nothing with %s and asks to open it from Telegram', async (_label, initData) => {
    const { fetch, shown, elements } = run({
      page: 'callback',
      search,
      ...(initData === undefined ? {} : { initData }),
    });
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(shown()).toEqual(['open_from_telegram']);
    // outside Telegram there is nothing for the button to close
    expect(elements.close?.hidden).toBe(true);
  });

  it.each([
    ['busy', 'busy'],
    ['start_over', 'start_over'],
    ['an outcome the page has no block for', 'unknown'],
  ])('shows the block the server named: %s', async (outcome, expected) => {
    const { shown } = run({
      page: 'callback',
      initData: INIT_DATA,
      search,
      fetch: () =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              outcome: outcome === 'an outcome the page has no block for' ? 'odd' : outcome,
            }),
        }),
    });
    await settle();
    expect(shown()).toEqual([expected]);
  });

  it.each([
    ['a rejected fetch', () => Promise.reject(new TypeError('network'))],
    [
      'a 500',
      () => Promise.resolve({ ok: false, json: () => Promise.resolve({ outcome: 'linked' }) }),
    ],
    ['a body that is not JSON', () => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('x')) })],
    ['a body without an outcome', () => Promise.resolve({ ok: true, json: () => Promise.resolve(null) })],
  ])('never claims an outcome after %s', async (_label, fetch) => {
    const { shown } = run({ page: 'callback', initData: INIT_DATA, search, fetch });
    await settle();
    expect(shown()).toEqual(['unknown']);
  });

  it('closes the Mini App from the button', () => {
    const { elements, webApp } = run({ page: 'callback', initData: INIT_DATA, search });
    elements.close?.listeners.click?.();
    expect(webApp.close).toHaveBeenCalledOnce();
  });
});
