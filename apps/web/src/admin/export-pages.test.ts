import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { telegramHtmlProblems } from '@binarius/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_CLIENT_JS } from './client';
import { EXPORTED_PAGES, exportAdminPages, serveDirectory } from './export-pages';
import type { AdminNavKey } from './pages';
import { ADMIN_CSS, ADMIN_FONTS, ADMIN_FONT_FILES } from './static';
import { SAMPLE_RENDERED } from './testing';

// every nav key and the page that must mark it current
const NAV_PAGES: Readonly<Record<AdminNavKey, string>> = {
  overview: 'overview',
  users: 'users',
  sessions: 'sessions',
  intents: 'intents',
  tradingSessions: 'trading-sessions',
  tokens: 'tokens',
  audit: 'audit',
  botTexts: 'bot-texts',
  deposits: 'deposits',
  brokerAccounts: 'broker-accounts',
  serviceAccounts: 'service-accounts',
  starRefunds: 'star-refunds',
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'admin-export-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the admin pages export (#459)', () => {
  it('E1 writes the stylesheet, the script, the fonts and one file per page', async () => {
    expect(Object.keys(EXPORTED_PAGES).length).toBeGreaterThanOrEqual(23);
    await exportAdminPages(dir);

    expect(await readFile(path.join(dir, 'admin/static/admin.css'), 'utf8')).toBe(ADMIN_CSS);
    expect(await readFile(path.join(dir, 'admin/static/app.js'), 'utf8')).toBe(ADMIN_CLIENT_JS);
    for (const file of ADMIN_FONT_FILES) {
      const written = await readFile(path.join(dir, 'admin/static/fonts', file));
      expect(written.equals(ADMIN_FONTS[file])).toBe(true);
    }
    const pages = (await readdir(dir)).filter((name) => name.endsWith('.html')).sort();
    expect(pages).toEqual(
      Object.keys(EXPORTED_PAGES)
        .map((name) => `${name}.html`)
        .sort(),
    );
  });

  it('E2 links every page to the admin stylesheet and script', async () => {
    await exportAdminPages(dir);
    for (const name of Object.keys(EXPORTED_PAGES)) {
      const page = await readFile(path.join(dir, `${name}.html`), 'utf8');
      expect(page, name).toContain('<link rel="stylesheet" href="/admin/static/admin.css" />');
      expect(page, name).toContain('<script src="/admin/static/app.js"></script>');
    }
  });

  // the CSP allows neither, so one would silently not apply in the browser
  it('E3 puts no inline style and no inline script on any page', async () => {
    await exportAdminPages(dir);
    for (const name of Object.keys(EXPORTED_PAGES)) {
      const page = await readFile(path.join(dir, `${name}.html`), 'utf8');
      expect(page, name).not.toContain('style="');
      expect(page, name).not.toContain('<style');
      expect(page, name).not.toMatch(/<script(?![^>]*\ssrc=)/);
      expect(page, name).not.toMatch(/\son[a-z]+="/);
    }
  });

  it('E4 marks each section current on its own page only', async () => {
    await exportAdminPages(dir);
    for (const [key, name] of Object.entries(NAV_PAGES)) {
      expect(Object.keys(EXPORTED_PAGES), key).toContain(name);
      const page = await readFile(path.join(dir, `${name}.html`), 'utf8');
      expect(page.match(/aria-current="page"/g), name).toHaveLength(1);
      const current = /<a href="([^"]*)"\s+aria-current="page"/.exec(page)?.[1];
      expect(current, name).toBe(`/admin/${name}`);
    }
  });

  // #657: the refused states of the forms, for their screenshots; each marks one field and points
  // it at the message
  it.each([
    ['bot-text-refused', 'source-problems'],
    ['password-refused', 'password-error'],
    ['user-adjust-refused', 'adjust-error'],
  ])('E6 %s marks one field, described by the message %s', (name, id) => {
    const page = EXPORTED_PAGES[name]?.().value ?? '';
    expect(page.match(/aria-invalid="true"/g)).toHaveLength(1);
    expect(page).toContain(`aria-invalid="true" aria-describedby="${id}"`);
    expect(page.match(new RegExp(`\\sid="${id}"`, 'g'))).toHaveLength(1);
  });

  it('E6 shows the preview on bot-text, from Telegram HTML the backend would accept', () => {
    expect(SAMPLE_RENDERED.kind).toBe('html');
    if (SAMPLE_RENDERED.kind !== 'html') return;
    expect(telegramHtmlProblems(SAMPLE_RENDERED.telegramHtml)).toEqual([]);
    expect(EXPORTED_PAGES['bot-text']?.().value).toContain('<div class="tg-bubble">');
  });

  it.each(['bot-text', 'password', 'user'])('E6 %s, not refused, marks no field', (name) => {
    expect(EXPORTED_PAGES[name]?.().value).not.toContain('aria-invalid');
  });

  describe('E5 the static server', () => {
    let server: Server | undefined;

    afterEach(async () => {
      await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
      server = undefined;
    });

    const fetchRaw = (port: number, urlPath: string) =>
      new Promise<{ status: number; type: string | undefined; body: string }>((resolve, reject) => {
        // a raw path: fetch() and new URL() would normalise the `..` away before sending
        const req = request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body }),
          );
        });
        req.on('error', reject);
        req.end();
      });

    it('serves the exported directory alone, on loopback only', async () => {
      const site = path.join(dir, 'site');
      await mkdir(site);
      await exportAdminPages(site);
      await writeFile(path.join(dir, 'outside.html'), 'secret');
      server = await serveDirectory(site, 0);
      const { address, port } = server.address() as AddressInfo;
      expect(address).toBe('127.0.0.1');

      const page = await fetchRaw(port, '/overview.html');
      expect(page.status).toBe(200);
      expect(page.type).toBe('text/html; charset=utf-8');
      const css = await fetchRaw(port, '/admin/static/admin.css');
      expect(css.status).toBe(200);
      expect(css.type).toBe('text/css; charset=utf-8');

      for (const outside of [
        '/../outside.html',
        '/%2e%2e/outside.html',
        '/admin/../../outside.html',
      ]) {
        const refused = await fetchRaw(port, outside);
        expect(refused.status, outside).toBe(404);
        expect(refused.body, outside).not.toContain('secret');
      }
      expect((await fetchRaw(port, '/nope.html')).status).toBe(404);
      expect((await fetchRaw(port, '/admin/static')).status).toBe(404);

      const closing = server;
      server = undefined;
      await new Promise((resolve) => closing.close(resolve));
      const again = await serveDirectory(site, port);
      await new Promise((resolve) => again.close(resolve));
    });
  });
});
