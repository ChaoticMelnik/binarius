import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// A package's own directory, for the files it reads at run time. Not import.meta.url: in a bundle
// (tooling/build.ts) every module shares the bundle's URL, so `new URL('./assets/x',
// import.meta.url)` would point into apps/bot/dist/. The package name is resolved instead: from
// src/ by the package's self-reference, from the bundle the same way (it lies inside apps/bot/),
// and from another app's bundle through its node_modules symlink, realpath'd. The package must
// list "./package.json" in its exports, or Node refuses the subpath (docs/deploy.md -> Files a
// package reads).
export const packageRoot = (name: string, importMetaUrl: string): string =>
  path.dirname(createRequire(importMetaUrl).resolve(`${name}/package.json`));

// A file of this package, checked for read access when the module that names it is imported: a
// wrong path then stops the process at its start instead of costing the first card its picture.
export const botFile = (...segments: string[]): string => {
  const file = path.join(packageRoot('@binarius/bot', import.meta.url), ...segments);
  accessSync(file, constants.R_OK);
  return file;
};

// A file of @binarius/shared (#859: the wait's media, which the backend's session wait reads too),
// found and checked the same way
export const sharedFile = (...segments: string[]): string => {
  const file = path.join(packageRoot('@binarius/shared', import.meta.url), ...segments);
  accessSync(file, constants.R_OK);
  return file;
};
