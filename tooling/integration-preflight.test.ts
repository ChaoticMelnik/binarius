import { describe, expect, it } from 'vitest';
import { judgePreflight, type PreflightFacts } from './integration-preflight';

const HOST_MS = 1_790_933_395_686;
const native: PreflightFacts = {
  serverVersionNum: 180_006,
  dataDirectory: '/opt/homebrew/var/postgresql@18',
  dbMs: HOST_MS + 157,
  hostMs: HOST_MS,
  platform: 'darwin',
};

describe('judgePreflight', () => {
  it('accepts the native PostgreSQL 18 on this Mac', () => {
    expect(judgePreflight(native)).toEqual([]);
  });

  it('refuses a server older than 18, and a version it could not read', () => {
    expect(judgePreflight({ ...native, serverVersionNum: 160_013 })).toEqual([
      expect.stringContaining('PostgreSQL 160013; the tests need 18 or newer'),
    ]);
    expect(judgePreflight({ ...native, serverVersionNum: Number.NaN })).toHaveLength(1);
  });

  // the Colima VM after a Mac sleep: its clock 84 minutes behind the host's
  it('refuses a database clock more than a second off, either way, and one it could not read', () => {
    expect(judgePreflight({ ...native, dbMs: HOST_MS - 84 * 60_000 })).toEqual([
      expect.stringContaining('is -5040000 ms off'),
    ]);
    expect(judgePreflight({ ...native, dbMs: HOST_MS + 1_001 })).toHaveLength(1);
    expect(judgePreflight({ ...native, dbMs: HOST_MS - 1_000 })).toEqual([]);
    expect(judgePreflight({ ...native, dbMs: Number.NaN })).toHaveLength(1);
  });

  it('refuses the compose container on a Mac, and allows that path on a Linux host', () => {
    const container = { ...native, dataDirectory: '/var/lib/postgresql/18/docker' };
    expect(judgePreflight(container)).toEqual([
      expect.stringContaining(
        'containerised Postgres (data_directory /var/lib/postgresql/18/docker)',
      ),
    ]);
    expect(judgePreflight({ ...container, platform: 'linux' })).toEqual([]);
  });

  it('names the README section in every refusal', () => {
    const everything = judgePreflight({
      serverVersionNum: 160_013,
      dataDirectory: '/var/lib/postgresql/18/docker',
      dbMs: HOST_MS - 84 * 60_000,
      hostMs: HOST_MS,
      platform: 'darwin',
    });
    expect(everything).toHaveLength(3);
    for (const problem of everything) expect(problem).toContain('see README → Test database');
  });
});
