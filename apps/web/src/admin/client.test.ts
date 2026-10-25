import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ADMIN_CLIENT_JS } from './client';

interface FakeElement {
  attributes: Map<string, string>;
  listeners: Record<string, () => void>;
  children: FakeElement[];
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
  querySelectorAll(selector: string): FakeElement[];
}

const element = (attrs: Record<string, string> = {}, children: FakeElement[] = []): FakeElement => {
  const attributes = new Map(Object.entries(attrs));
  const listeners: Record<string, () => void> = {};
  return {
    attributes,
    listeners,
    children,
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => void attributes.set(name, value),
    removeAttribute: (name) => void attributes.delete(name),
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
    // only the `[attribute]` selectors the script asks a button for
    querySelectorAll: (selector) => {
      const name = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
      return name === undefined ? [] : children.filter((child) => child.attributes.has(name));
    },
  };
};

const themeButton = (): FakeElement =>
  element(
    {
      'data-theme-toggle': '',
      'data-label-system': 'Тема: системная',
      'data-label-dark': 'Тема: тёмная',
      'data-label-light': 'Тема: светлая',
      'aria-label': 'Тема: системная',
    },
    [
      element({ 'data-theme-icon': 'system' }),
      element({ 'data-theme-icon': 'dark', hidden: '' }),
      element({ 'data-theme-icon': 'light', hidden: '' }),
    ],
  );

const copyButton = (value: string): FakeElement =>
  element(
    {
      'data-copy': value,
      'aria-label': 'Копировать',
      'data-label-copy': 'Копировать',
      'data-label-copied': 'Скопировано',
    },
    [element({ 'data-copy-icon': 'copy' }), element({ 'data-copy-icon': 'check', hidden: '' })],
  );

// what a click's target answers to `closest('[data-copy]')`: the icon inside the button
const insideOf = (button: FakeElement) => ({
  closest: (selector: string) => (selector === '[data-copy]' ? button : null),
});

type Storage = 'throws' | Record<string, string>;
type Clipboard = 'none' | 'writes' | 'rejects';

function run({
  storage = {},
  button = true,
  clipboard = 'none',
}: { storage?: Storage; button?: boolean; clipboard?: Clipboard } = {}) {
  const root = { ...element(), className: 'no-js' };
  const toggle = button ? themeButton() : undefined;
  const docListeners: Record<string, () => void> = {};
  const store = storage === 'throws' ? undefined : { ...storage };
  const localStorage = {
    getItem: (key: string) => {
      if (store === undefined) throw new Error('SecurityError');
      return store[key] ?? null;
    },
    setItem: (key: string, value: string) => {
      if (store === undefined) throw new Error('SecurityError');
      store[key] = value;
    },
    removeItem: (key: string) => {
      if (store === undefined) throw new Error('SecurityError');
      delete store[key];
    },
  };
  const document = {
    documentElement: root,
    addEventListener: (type: string, listener: () => void) => {
      docListeners[type] = listener;
    },
    querySelectorAll: (selector: string) =>
      selector === '[data-theme-toggle]' && toggle !== undefined
        ? [toggle]
        : selector === '[data-copy]'
          ? [copy]
          : [],
  };
  const copy = copyButton('00000000-0000-4000-8000-0000000000c1');
  const written: string[] = [];
  const timers: (() => void)[] = [];
  const navigator =
    clipboard === 'none'
      ? {}
      : {
          clipboard: {
            writeText: (value: string) => {
              written.push(value);
              return clipboard === 'writes'
                ? Promise.resolve()
                : Promise.reject(new Error('NotAllowedError'));
            },
          },
        };
  const setTimeout = (callback: () => void) => {
    timers.push(callback);
    return timers.length;
  };
  runInNewContext(ADMIN_CLIENT_JS, { window: { document, localStorage, navigator, setTimeout } });
  const visibleIcon = () =>
    toggle?.children
      .find((child) => !child.attributes.has('hidden'))
      ?.getAttribute('data-theme-icon');
  return {
    root,
    toggle,
    store,
    visibleIcon,
    ready: () => docListeners.DOMContentLoaded?.(),
    click: () => toggle?.listeners.click?.(),
    copy,
    written,
    timers,
    visibleCopyIcon: () =>
      copy.children
        .find((child) => !child.attributes.has('hidden'))
        ?.getAttribute('data-copy-icon'),
    // the listener's promise settles on the microtask queue; one macrotask turn drains it
    clickCopy: async () => {
      (docListeners.click as unknown as (event: unknown) => void)({ target: insideOf(copy) });
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    },
  };
}

describe('the admin pages script (#459)', () => {
  it('J1 puts a stored theme on <html> before DOMContentLoaded and drops no-js', () => {
    const page = run({ storage: { 'admin-theme': 'dark' } });
    expect(page.root.getAttribute('data-theme')).toBe('dark');
    expect(page.root.className).not.toContain('no-js');
    page.ready();
    expect(page.toggle?.getAttribute('aria-label')).toBe('Тема: тёмная');
    expect(page.visibleIcon()).toBe('dark');
  });

  it('J2 leaves the system theme with nothing stored, and still drops no-js', () => {
    const page = run();
    expect(page.root.getAttribute('data-theme')).toBeNull();
    expect(page.root.className).not.toContain('no-js');
  });

  it('J3 cycles system → dark → light → system, storing the choice', () => {
    const page = run();
    page.ready();
    expect(page.visibleIcon()).toBe('system');

    page.click();
    expect(page.root.getAttribute('data-theme')).toBe('dark');
    expect(page.store).toEqual({ 'admin-theme': 'dark' });
    expect(page.toggle?.getAttribute('aria-label')).toBe('Тема: тёмная');
    expect(page.visibleIcon()).toBe('dark');

    page.click();
    expect(page.root.getAttribute('data-theme')).toBe('light');
    expect(page.store).toEqual({ 'admin-theme': 'light' });
    expect(page.toggle?.getAttribute('aria-label')).toBe('Тема: светлая');
    expect(page.visibleIcon()).toBe('light');

    page.click();
    expect(page.root.getAttribute('data-theme')).toBeNull();
    expect(page.store).toEqual({});
    expect(page.toggle?.getAttribute('aria-label')).toBe('Тема: системная');
    expect(page.visibleIcon()).toBe('system');
  });

  it('J4 survives a storage that throws: system theme, and a click still switches', () => {
    const page = run({ storage: 'throws' });
    expect(page.root.getAttribute('data-theme')).toBeNull();
    page.ready();
    expect(() => page.click()).not.toThrow();
    expect(page.root.getAttribute('data-theme')).toBe('dark');
  });

  it('J5 ignores a stored value that is not a theme', () => {
    const page = run({ storage: { 'admin-theme': 'blue' } });
    expect(page.root.getAttribute('data-theme')).toBeNull();
    page.ready();
    expect(page.visibleIcon()).toBe('system');
  });

  it('J6 does nothing more on a page without the switch', () => {
    const page = run({ button: false, storage: { 'admin-theme': 'light' } });
    expect(() => page.ready()).not.toThrow();
    expect(page.root.getAttribute('data-theme')).toBe('light');
  });
});

describe('the copy button (#656)', () => {
  it('J7 copies the data-copy value, shows «copied», and goes back after the timer', async () => {
    const page = run({ clipboard: 'writes' });
    page.ready();
    expect(page.copy.attributes.has('hidden')).toBe(false);

    await page.clickCopy();
    expect(page.written).toEqual(['00000000-0000-4000-8000-0000000000c1']);
    expect(page.copy.getAttribute('aria-label')).toBe('Скопировано');
    expect(page.visibleCopyIcon()).toBe('check');

    expect(page.timers).toHaveLength(1);
    page.timers[0]?.();
    expect(page.copy.getAttribute('aria-label')).toBe('Копировать');
    expect(page.visibleCopyIcon()).toBe('copy');
  });

  it('J8 hides every copy button without navigator.clipboard, and a click does nothing', async () => {
    const page = run({ clipboard: 'none' });
    page.ready();
    expect(page.copy.attributes.has('hidden')).toBe(true);

    await page.clickCopy();
    expect(page.copy.getAttribute('aria-label')).toBe('Копировать');
    expect(page.visibleCopyIcon()).toBe('copy');
    expect(page.timers).toEqual([]);
  });

  it('J9 leaves the button as it was when the write is refused', async () => {
    const page = run({ clipboard: 'rejects' });
    page.ready();

    await expect(page.clickCopy()).resolves.toBeUndefined();
    expect(page.written).toEqual(['00000000-0000-4000-8000-0000000000c1']);
    expect(page.copy.getAttribute('aria-label')).toBe('Копировать');
    expect(page.visibleCopyIcon()).toBe('copy');
    expect(page.timers).toEqual([]);
  });
});
