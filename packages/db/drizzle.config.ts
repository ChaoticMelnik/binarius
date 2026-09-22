import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  throw new Error('DATABASE_URL is required (export it from .env.example, see README)');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
