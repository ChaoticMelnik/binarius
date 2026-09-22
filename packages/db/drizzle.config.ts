import { defineConfig } from 'drizzle-kit';

// Only the commands that open a connection need the URL; generate, check, up and drop are
// pure file operations, and demanding a URL for them would make an offline drift check
// impossible. `introspect` is drizzle-kit's alias for `pull` and does connect, so it belongs
// here — without it the command would fall through to an empty URL and an opaque driver error.
const CONNECTING_COMMANDS = ['migrate', 'push', 'pull', 'introspect', 'studio'];
const needsConnection = process.argv.some((arg) => CONNECTING_COMMANDS.includes(arg));

const url = process.env.DATABASE_URL;
if (needsConnection && (url === undefined || url === '')) {
  throw new Error('DATABASE_URL is required for this command (see README → Database)');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: url ?? '' },
  strict: true,
  verbose: true,
});
