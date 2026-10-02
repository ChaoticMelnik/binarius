import { configDefaults, defineConfig } from 'vitest/config';

// The one definition of an integration test: it talks to the Postgres in DATABASE_URL or the
// Redis in REDIS_URL. tooling/vitest-projects.test.ts holds every test file to this name.
export const INTEGRATION_TEST_GLOB = '{apps,packages}/*/src/**/*.{db,redis}.test.ts';

export default defineConfig({
  test: {
    // packages/db's constraint-coverage gate (every CHECK, unique index, FK and trigger) is the
    // last test in its file and asserts what the cases before it observed, so it must run last.
    // This pins the default only — an explicit `--sequence.shuffle` on the command line still
    // overrides it and fails the gate. That direction is safe (a false failure, never a false
    // pass). Both projects inherit it through `extends: true`.
    sequence: { shuffle: false },
    // The root is not a project in vitest 5: `include` lives in the projects below, and a root
    // `include` would be concatenated into both of them by the config merge.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/src/**/*.test.ts', 'tooling/**/*.test.ts'],
          exclude: [...configDefaults.exclude, INTEGRATION_TEST_GLOB],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [INTEGRATION_TEST_GLOB],
          // A starved dev VM (2 vCPU under a busy host) took createTempDatabase (CREATE DATABASE
          // and every migration) past the 10 s default; 170 ms alone, 1.2 s with 8 in parallel
          // on an idle VM. 60 s still shows a real migration hang within a minute (#166).
          hookTimeout: 60_000,
          // Under the same load `trade-intent-ops` "does not deadlock…" (≈140 transactions) and
          // `cli/staff reset-password` (production scrypt cost) passed 5 s. Kept below
          // hookTimeout, which tooling/vitest-projects.test.ts asserts.
          testTimeout: 20_000,
        },
      },
    ],
  },
});
