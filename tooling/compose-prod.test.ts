import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appEntryPoints } from './build';
import { composeServiceKeys, composeServices, composeServiceValue } from './compose-text';

// compose.prod.yaml is an override of compose.yaml and changes three things only (#146, Rule 52):
// the app commands, log rotation, and a restart policy for postgres and redis. The CI compose job
// checks the merged configuration on the runner's Compose; these pins hold the file's text.

const root = path.resolve(import.meta.dirname, '..');
const base = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
const prod = readFileSync(path.join(root, 'compose.prod.yaml'), 'utf8');

const baseServices = composeServices(base);
const prodServices = composeServices(prod);

const DEV_COMMAND = /^pnpm --filter @binarius\/([\w-]+) dev$/;

describe('compose.prod.yaml', () => {
  it('P1 names only services compose.yaml has', () => {
    expect(prodServices.length).toBeGreaterThan(0);
    expect(prodServices.filter((service) => !baseServices.includes(service))).toEqual([]);
  });

  it('P2 runs the bundle of every app compose.yaml runs under tsx watch', () => {
    const devApps = baseServices.filter((service) =>
      DEV_COMMAND.test(composeServiceValue(base, service, 'command') ?? ''),
    );
    expect(
      devApps.map(
        (service) => DEV_COMMAND.exec(composeServiceValue(base, service, 'command') ?? '')?.[1],
      ),
    ).toEqual(devApps);
    expect(devApps.sort()).toEqual(appEntryPoints(root).map((app) => app.name));
    for (const app of devApps) {
      expect(composeServiceValue(prod, app, 'command'), app).toBe(`node apps/${app}/dist/index.js`);
    }
  });

  it('P3 rotates the logs of every service of compose.yaml at 10m x 3', () => {
    for (const service of baseServices) {
      expect(composeServiceValue(prod, service, 'logging'), service).toBe('*logging');
    }
    const anchor = /^x-logging: &logging\n((?: {2}.*\n)+)/m.exec(prod)?.[1] ?? '';
    expect(anchor).toContain('  driver: json-file\n');
    expect(anchor).toContain('    max-size: "10m"\n');
    expect(anchor).toContain('    max-file: "3"\n');
  });

  it('P4 sets nothing but command, logging and restart', () => {
    for (const service of prodServices) {
      expect(
        composeServiceKeys(prod, service).filter(
          (key) => !['command', 'logging', 'restart'].includes(key),
        ),
        service,
      ).toEqual([]);
    }
  });

  it("P5 gives postgres and redis the app anchor's restart policy", () => {
    const anchorRestart = /^x-app: &app\n(?: {2}.*\n)*? {2}restart: (.+)$/m.exec(base)?.[1];
    expect(anchorRestart).toBe('${COMPOSE_RESTART:-unless-stopped}');
    for (const service of ['postgres', 'redis']) {
      expect(composeServiceValue(prod, service, 'restart'), service).toBe(anchorRestart);
    }
  });
});
