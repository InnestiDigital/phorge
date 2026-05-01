#!/usr/bin/env node
// Bin entrypoint for the published `phorge` package.
//
// The TypeScript sources use extensionless / bundler-style imports, so we
// load them at runtime via `tsx` rather than shipping a compiled dist (which
// would require rewriting every import in src/). `tsx` is therefore a regular
// runtime dependency, not a devDependency.
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, 'phorge.ts');

try {
  const { register } = await import('tsx/esm/api');
  register();
  await import(pathToFileURL(entry).href);
} catch (err) {
  console.error(err);
  process.exit(1);
}
