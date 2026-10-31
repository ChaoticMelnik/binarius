import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BotLanguage, type StaffSessionView } from '@binarius/shared';
import type { SafeHtml } from '../html';
import { ADMIN_CLIENT_JS } from './client';
import {
  adminNoticePage,
  auditPage,
  botTextPage,
  botTextsPage,
  brokerAccountsPage,
  confirmPage,
  depositsPage,
  intentPage,
  intentsPage,
  linkPage,
  loginPage,
  overviewPage,
  passwordPage,
  serviceAccountsPage,
  sessionsPage,
  starRefundsPage,
  tokensPage,
  tradingSessionsPage,
  userPage,
  usersPage,
} from './pages';
import {
  ADMIN_CSS,
  ADMIN_FONTS,
  ADMIN_FONTS_PATH,
  ADMIN_FONT_FILES,
  ADMIN_SCRIPT_PATH,
  ADMIN_STYLESHEET_PATH,
} from './static';
import {
  SAMPLE_AUDIT,
  SAMPLE_BOT_TEXT,
  SAMPLE_BOT_TEXTS,
  SAMPLE_BROKER_ACCOUNTS,
  SAMPLE_DEPOSITS,
  SAMPLE_INTENT,
  SAMPLE_INTENTS,
  SAMPLE_LIST_ITEM,
  SAMPLE_ME,
  SAMPLE_OVERVIEW,
  SAMPLE_RENDERED,
  SAMPLE_SERVICE_ACCOUNTS,
  SAMPLE_STAR_REFUNDS,
  SAMPLE_TOKENS,
  SAMPLE_TRADING_SESSIONS,
  SAMPLE_USER,
} from './testing';
import { TEXTS } from './texts';

// The admin pages as static files (#459), for screenshots without starting the web service: each
// page function is called with the SAMPLE_* answers of testing.ts — no Fastify, no backend, no
// network. `--serve` then serves that directory alone on 127.0.0.1 (the screenshot browser does not
// open file: URLs). docs/admin-design-system.md → Screenshots has the procedure.

const LOGIN = SAMPLE_ME.login;

const SAMPLE_STAFF_SESSION: StaffSessionView = {
  id: SAMPLE_ME.sessionId,
  login: LOGIN,
  displayName: 'Ада',
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
  createdAt: '2026-10-07T08:00:00.000Z',
  lastSeenAt: '2026-10-07T08:30:00.000Z',
  expiresAt: '2026-10-08T08:00:00.000Z',
  current: true,
};

export const EXPORTED_PAGES: Readonly<Record<string, () => SafeHtml>> = {
  login: () => loginPage(),
  confirm: () => confirmPage(),
  link: () => linkPage(),
  password: () => passwordPage({ login: LOGIN, others: 1 }),
  'password-refused': () =>
    passwordPage({ message: TEXTS.invalidCurrentPassword, invalid: 'currentPassword' }),
  overview: () => overviewPage(SAMPLE_OVERVIEW.overview, LOGIN),
  users: () => usersPage([SAMPLE_LIST_ITEM], { nextCursor: null, login: LOGIN }),
  user: () => userPage(SAMPLE_USER, LOGIN),
  'user-adjust-refused': () =>
    userPage(SAMPLE_USER, LOGIN, {
      adjustment: {
        message: TEXTS.tokenAdjustInsufficient(SAMPLE_USER.user.tokens.available),
        form: { direction: 'debit', amount: '50', note: 'тест' },
        field: 'amount',
      },
    }),
  sessions: () => sessionsPage([SAMPLE_STAFF_SESSION], LOGIN),
  intents: () =>
    intentsPage(SAMPLE_INTENTS.intents, { filters: {}, nextCursor: null, login: LOGIN }),
  intent: () => intentPage(SAMPLE_INTENT, LOGIN),
  'trading-sessions': () =>
    tradingSessionsPage(SAMPLE_TRADING_SESSIONS.sessions, { nextCursor: null, login: LOGIN }),
  tokens: () => tokensPage(SAMPLE_TOKENS.entries, { filters: {}, nextCursor: null, login: LOGIN }),
  audit: () => auditPage(SAMPLE_AUDIT.entries, { filters: {}, nextCursor: null, login: LOGIN }),
  deposits: () =>
    depositsPage(SAMPLE_DEPOSITS.deposits, { filters: {}, nextCursor: null, login: LOGIN }),
  'broker-accounts': () =>
    brokerAccountsPage(SAMPLE_BROKER_ACCOUNTS.accounts, {
      filters: {},
      nextCursor: null,
      login: LOGIN,
    }),
  'service-accounts': () => serviceAccountsPage(SAMPLE_SERVICE_ACCOUNTS),
  'star-refunds': () =>
    starRefundsPage(SAMPLE_STAR_REFUNDS.requests, { nextCursor: null, login: LOGIN }),
  'bot-texts': () =>
    botTextsPage(SAMPLE_BOT_TEXTS.overrides, { language: BotLanguage.Ru, login: LOGIN }),
  'bot-text': () => botTextPage(SAMPLE_BOT_TEXT, { login: LOGIN, rendered: SAMPLE_RENDERED }),
  'bot-text-refused': () =>
    botTextPage(SAMPLE_BOT_TEXT, {
      login: LOGIN,
      draft: '<b>Привет',
      version: 7,
      problems: [{ key: 'welcome', reason: 'Незакрытый тег <b>' }],
    }),
  'not-found': () => adminNoticePage(TEXTS.notFoundTitle, TEXTS.notFoundBody),
};

const relative = (urlPath: string): string => urlPath.replace(/^\//, '');

/** Writes the static files and one `<page>.html` per EXPORTED_PAGES key into `outDir`. */
export async function exportAdminPages(outDir: string): Promise<string[]> {
  const fontsDir = path.join(outDir, relative(ADMIN_FONTS_PATH));
  await mkdir(fontsDir, { recursive: true });
  await writeFile(path.join(outDir, relative(ADMIN_STYLESHEET_PATH)), ADMIN_CSS);
  await writeFile(path.join(outDir, relative(ADMIN_SCRIPT_PATH)), ADMIN_CLIENT_JS);
  for (const file of ADMIN_FONT_FILES) {
    await writeFile(path.join(fontsDir, file), ADMIN_FONTS[file]);
  }
  const written: string[] = [];
  for (const [name, render] of Object.entries(EXPORTED_PAGES)) {
    const file = path.join(outDir, `${name}.html`);
    await writeFile(file, render().value);
    written.push(file);
  }
  return written;
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Serves `dir` alone, GET only, on 127.0.0.1; a path that resolves outside it is a 404. */
export function serveDirectory(dir: string, port: number): Promise<Server> {
  const root = path.resolve(dir);
  const server = createServer((request, response) => {
    const notFound = () => {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
    };
    if (request.method !== 'GET') return notFound();
    let urlPath: string;
    try {
      urlPath = decodeURIComponent((request.url ?? '/').split('?', 1)[0] ?? '/');
    } catch {
      return notFound();
    }
    const file = path.resolve(root, `.${path.posix.sep}${urlPath}`);
    if (!file.startsWith(root + path.sep)) return notFound();
    const type = TYPES[path.extname(file)];
    if (type === undefined) return notFound();
    stat(file).then(
      (info) => {
        if (!info.isFile()) return notFound();
        response.writeHead(200, { 'content-type': type });
        createReadStream(file).pipe(response);
        return undefined;
      },
      () => notFound(),
    );
    return undefined;
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function main(args: readonly string[]): Promise<void> {
  const [outDir, flag, portArg] = args;
  if (outDir === undefined || (flag !== undefined && flag !== '--serve')) {
    throw new Error('usage: admin:export <dir> [--serve <port>]');
  }
  const dir = path.resolve(outDir);
  for (const file of await exportAdminPages(dir)) process.stdout.write(`${file}\n`);
  if (flag === undefined) return;
  const port = Number(portArg);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('--serve needs a port');
  }
  const server = await serveDirectory(dir, port);
  process.stdout.write(`pid=${process.pid}\nurl=http://127.0.0.1:${port}/\n`);
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await main(process.argv.slice(2));
}
