import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts', 'tooling/**/*.test.ts'],
    // packages/db's constraint-coverage gate is the last test in its file and asserts what
    // the cases before it observed, so it must run last. This pins the default only — an
    // explicit `--sequence.shuffle` on the command line still overrides it and fails the
    // gate. That direction is safe (a false failure, never a false pass).
    sequence: { shuffle: false },
  },
});
