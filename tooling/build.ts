import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { build, type Metafile, type Plugin } from 'esbuild';

// The production build (#146, docs/deploy.md -> The build): one ESM bundle per app, so the prod
// profile runs `node apps/<app>/dist/index.js` with no pnpm and no tsx. The output of `tsc -b`
// is not runnable by Node (extensionless relative imports, exports pointing at src/*.ts), so the
// workspace code goes inside the bundle and every third-party package stays outside, resolved
// from apps/<app>/node_modules at run time. That is why each external must be declared in the
// app's own dependencies: a package a bundled workspace package depends on is not on that path.

export class BuildError extends Error {}

export interface AppEntryPoint {
  name: string;
  entry: string;
}

// every directory under apps/ with a src/index.ts is an app; compose.yaml runs the same set
export function appEntryPoints(root: string): AppEntryPoint[] {
  const appsDir = path.join(root, 'apps');
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => ({
      name: dirent.name,
      entry: path.join(appsDir, dirent.name, 'src', 'index.ts'),
    }))
    .filter((app) => existsSync(app.entry))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The package a bare specifier names: `@s/n/x` -> `@s/n`, `a/b` -> `a`. */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** The packages behind these external specifiers that `dependencies` does not declare. */
export function undeclaredExternals(
  externals: ReadonlySet<string>,
  dependencies: Readonly<Record<string, string>>,
): string[] {
  const names = new Set(
    [...externals].filter((specifier) => !isBuiltin(specifier)).map(packageNameOf),
  );
  return [...names].filter((name) => !Object.hasOwn(dependencies, name)).sort();
}

// A CLI's `import.meta.main` guard is true for every module of a bundle, so a CLI pulled in by
// accident would run its main() inside the service; test-only modules have no place there either.
const FORBIDDEN_INPUT = /\/cli\/|export-pages\.ts$|testing\.ts$|\.test\.ts$/;

/** Refuses a bundle that took in a node_modules file or a CLI, testing or test module. */
export function checkInputs(app: string, inputs: Readonly<Record<string, unknown>>): void {
  const fromNodeModules = Object.keys(inputs).filter((input) =>
    input.split('/').includes('node_modules'),
  );
  if (fromNodeModules.length > 0) {
    throw new BuildError(
      `${app}: the bundle took in node_modules files: ${fromNodeModules.join(', ')}`,
    );
  }
  const forbidden = Object.keys(inputs).filter((input) => FORBIDDEN_INPUT.test(input));
  if (forbidden.length > 0) {
    throw new BuildError(
      `${app}: the bundle took in a CLI, testing or test module: ${forbidden.join(', ')}`,
    );
  }
}

// workspace packages are bundled (esbuild follows the symlink and the exports into src/*.ts);
// every other bare specifier, node:* included, stays an import
const externalPackages: Plugin = {
  name: 'external-packages',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith('@binarius/') ? undefined : { path: args.path, external: true },
    );
  },
};

export interface BundleResult {
  outfile: string;
  bytes: number;
  externals: string[];
  metafile: Metafile;
}

export async function bundleApp(
  root: string,
  app: AppEntryPoint,
  outfile: string = path.join(root, 'apps', app.name, 'dist', 'index.js'),
): Promise<BundleResult> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [app.entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    // names stay in stack traces; the map is read only under node --enable-source-maps
    minify: false,
    sourcemap: true,
    metafile: true,
    logLevel: 'silent',
    plugins: [externalPackages],
  });
  if (result.warnings.length > 0) {
    throw new BuildError(
      `${app.name}: esbuild warned: ${result.warnings.map((warning) => warning.text).join('; ')}`,
    );
  }
  const { metafile } = result;
  checkInputs(app.name, metafile.inputs);
  const output = Object.values(metafile.outputs).find((entry) => entry.entryPoint !== undefined);
  if (output === undefined) throw new BuildError(`${app.name}: esbuild wrote no entry output`);
  const externals = [
    ...new Set(output.imports.filter((entry) => entry.external).map((entry) => entry.path)),
  ].sort();
  const manifest = JSON.parse(
    readFileSync(path.join(root, 'apps', app.name, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  const undeclared = undeclaredExternals(new Set(externals), manifest.dependencies ?? {});
  if (undeclared.length > 0) {
    throw new BuildError(
      `${app.name}: the bundle imports packages apps/${app.name}/package.json does not list in ` +
        `dependencies: ${undeclared.join(', ')}`,
    );
  }
  return { outfile, bytes: output.bytes, externals, metafile };
}

async function main(): Promise<number> {
  const root = path.resolve(import.meta.dirname, '..');
  for (const app of appEntryPoints(root)) {
    const result = await bundleApp(root, app);
    const packages = [
      ...new Set(result.externals.filter((specifier) => !isBuiltin(specifier)).map(packageNameOf)),
    ];
    process.stdout.write(
      `${path.relative(root, result.outfile)} ${String(Math.round(result.bytes / 1024))} KB, ` +
        `${String(Object.keys(result.metafile.inputs).length)} inputs, external: ${packages.join(' ')}\n`,
    );
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof BuildError ? error.message : ((error as Error).stack ?? String(error))}\n`,
    );
    process.exitCode = 1;
  }
}
