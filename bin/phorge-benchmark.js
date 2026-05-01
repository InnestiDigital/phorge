#!/usr/bin/env node
// Bin entrypoint for `phorge-benchmark` — see bin/phorge.js for rationale.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, 'phorge-benchmark.ts');

try {
  const { register } = await import('tsx/esm/api');
  register();
  await import(pathToFileURL(entry).href);
} catch (err) {
  console.error(err);
  process.exit(1);
}
