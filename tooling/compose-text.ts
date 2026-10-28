// A line reader for compose files, for the tests of tooling/: the same shape as
// composeServiceValue in packages/shared/src/testing.ts, which tooling/ cannot import (its
// tsconfig has no path to packages/*/src and @binarius/shared is not linked at the root).

/** The services of the top-level `services:` block, by their two-space `<name>:` lines. */
export function composeServices(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.indexOf('services:');
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^ {2}([\w-]+):\s*$/.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

function serviceLines(yaml: string, service: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && /^ {0,2}\S/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** The service's direct four-space keys, in file order. */
export function composeServiceKeys(yaml: string, service: string): string[] {
  return serviceLines(yaml, service).flatMap((line) => {
    const match = /^ {4}([\w-]+):/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

/** The value of one direct four-space key of a service, as written. */
export function composeServiceValue(
  yaml: string,
  service: string,
  key: string,
): string | undefined {
  for (const line of serviceLines(yaml, service)) {
    const match = /^ {4}([\w-]+):\s*(.*?)\s*$/.exec(line);
    if (match !== null && match[1] === key) return match[2];
  }
  return undefined;
}

/** The lines nested under one direct four-space key of a service, as written. */
export function composeServiceChildLines(yaml: string, service: string, key: string): string[] {
  const lines = serviceLines(yaml, service);
  const start = lines.findIndex((line) => new RegExp(`^ {4}${key}:\\s*$`).test(line));
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && /^ {4}\S/.test(line));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
}

/**
 * A service's `environment:` map: its six-space `NAME: value` lines, the value as written ('' for
 * a valueless entry). The same shape as composeServiceEnvValue in packages/shared/src/testing.ts.
 */
export function composeServiceEnv(yaml: string, service: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of composeServiceChildLines(yaml, service, 'environment')) {
    const match = /^ {6}([A-Z0-9_]+):\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined) env.set(match[1], match[2] ?? '');
  }
  return env;
}
