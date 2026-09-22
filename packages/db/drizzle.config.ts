import { defineConfig } from 'drizzle-kit';

// generate and check are pure file operations; only the commands that open a connection
// need the URL, so requiring it unconditionally would make an offline drift check impossible
const CONNECTING_COMMANDS = ['migrate', 'push', 'pull', 'studio', 'drop', 'up'];
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
  verbose: true,
});
