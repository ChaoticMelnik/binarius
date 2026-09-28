// Test-only helpers shared by the apps' suites (subpath `@binarius/shared/testing`).

// Reads one direct key of a compose service out of compose.yaml text, so a test can hold a
// TypeScript timing constant and the container's stop_grace_period together. A service block
// starts at its two-space-indented `<name>:` line and ends at the next line indented the same
// way; only the block's direct (four-space) children count, so a nested `stop_grace_period`
// under some other key, or the same key on a neighbouring service, never matches.
export function composeServiceValue(
  yaml: string,
  service: string,
  key: string,
): string | undefined {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start === -1) return undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^ {2}\S/.test(line)) break;
    const match = /^ {4}([\w-]+):\s*(.*?)\s*$/.exec(line);
    if (match !== null && match[1] === key) return match[2];
  }
  return undefined;
}

// The names under one service's own `environment:` key, so a test can compare what a container
// is given with what its env parser reads. Same shape of scan as composeServiceValue: the
// service block, then its direct four-space `environment:` child, then the six-space names
// under it. A merge key counts as a name, so a shared anchor finding its way back into the
// block is visible rather than silently expanding the set. No service, or no environment
// block, gives undefined — the caller's assertion then fails rather than passing on nothing.
export function composeServiceEnvironmentKeys(yaml: string, service: string): string[] | undefined {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start === -1) return undefined;
  let inside = false;
  const names: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^ {2}\S/.test(line)) break;
    if (/^ {4}\S/.test(line)) {
      if (inside) break;
      inside = line === '    environment:';
      continue;
    }
    if (!inside) continue;
    const match = /^ {6}(<<|[\w-]+):/.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return inside ? names : undefined;
}

// The start-payload corpus, run twice: against startPayloadSchema (packages/shared) and against
// the live users_acquisition_source_check (packages/db). One list, so the two verdicts are
// compared row by row instead of two lists drifting apart.
export const START_PAYLOAD_CORPUS: readonly { label: string; value: string; valid: boolean }[] = [
  { label: '1 char', value: 'a', valid: true },
  { label: '64 chars', value: 'a'.repeat(64), valid: true },
  { label: 'dash underscore', value: 'src_ab-CD9', valid: true },
  { label: '65 chars', value: 'a'.repeat(65), valid: false },
  { label: 'empty', value: '', valid: false },
  { label: 'plus sign', value: 'a+b', valid: false },
  { label: 'space', value: 'a b', valid: false },
  { label: 'newline', value: 'a\nb', valid: false },
  { label: 'cyrillic', value: 'исток', valid: false },
];

// `40s` → 40000; compose accepts h/m/s/ms suffixes, this project only writes seconds
export function composeDurationMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)s$/.exec(value);
  return match === null ? undefined : Number(match[1]) * 1000;
}
