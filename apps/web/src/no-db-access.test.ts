import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// This process renders pages and calls the backend. It holds no database connection, and the
// reason is not tidiness: everything it is allowed to read is decided by a staff session the
// backend checks inside the transaction that also records the read. A direct query from here
// would be a read with no audit row behind it.
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const FORBIDDEN = ['@binarius/db', 'pg', 'drizzle-orm', 'ioredis', 'postgres'];

describe('apps/web', () => {
  it.each(FORBIDDEN)('does not depend on %s', (name) => {
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain(name);
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain(name);
  });
});
