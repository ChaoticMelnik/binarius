import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// A file of @binarius/shared the backend reads at run time (#860: the scanner's animation of the
// session's wait, the bot's own file). Not import.meta.url: in a bundle (tooling/build.ts) every
// module shares the bundle's URL. The package name is resolved instead, through this app's
// node_modules symlink, realpath'd; the package lists "./package.json" in its exports
// (docs/deploy.md -> Files a package reads). Checked for read access when the module that names it
// is imported: a wrong path then stops the process at its start instead of costing the first
// waiting message.
export const sharedFile = (...segments: string[]): string => {
  const root = path.dirname(
    createRequire(import.meta.url).resolve('@binarius/shared/package.json'),
  );
  const file = path.join(root, ...segments);
  accessSync(file, constants.R_OK);
  return file;
};
