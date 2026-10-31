import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The bot's image is node:alpine, and @resvg/resvg-js loads a native build per platform from an
// optional package (#318); the backend renders the daily summary card with it too (#881). The host and CI install the darwin or glibc one, so pnpm check never
// loads the musl build; this holds at least that the lockfile can install it on both pilot CPUs.
// Loading it is the owner's check in the container (docs/bot-session.md → The summary card).

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
const manifestOf = (relative: string) =>
  JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as Manifest;
const VERSION = manifestOf('../package.json').dependencies?.['@resvg/resvg-js'] ?? '';
// the backend's bundle requires it (Rule 52); the root's devDependency is the tests' and tooling's
const OTHER_VERSIONS = [
  manifestOf('../../backend/package.json').dependencies?.['@resvg/resvg-js'],
  manifestOf('../../../package.json').devDependencies?.['@resvg/resvg-js'],
];
const MUSL = ['linux-x64-musl', 'linux-arm64-musl'].map(
  (platform) => `@resvg/resvg-js-${platform}@${VERSION}`,
);
const lockfile = readFileSync(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8');

// the `packages:` entries of `names` that the lockfile lacks, each with its libc: [musl]
const missingMusl = (lock: string, names: readonly string[]): string[] =>
  names.filter(
    (name) =>
      !new RegExp(
        `\\n  '${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\n(    .*\\n)*?    libc: \\[musl\\]\\n`,
      ).test(lock),
  );

describe('the musl builds of the card renderer', () => {
  it('pins @resvg/resvg-js to one exact version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('L0 the backend and the root pin the same version, so the musl builds checked are theirs', () => {
    expect(OTHER_VERSIONS).toEqual([VERSION, VERSION]);
  });

  it('L1 the lockfile carries the x64 and arm64 musl builds of that version', () => {
    expect(missingMusl(lockfile, MUSL)).toEqual([]);
  });

  it('L2 the check reports a build the lockfile lost', () => {
    const [first] = MUSL;
    const lost = lockfile.replace(`\n  '${first ?? ''}':\n`, '\n  removed:\n');
    expect(lost).not.toBe(lockfile);
    expect(missingMusl(lost, MUSL)).toEqual([first]);
  });
});
