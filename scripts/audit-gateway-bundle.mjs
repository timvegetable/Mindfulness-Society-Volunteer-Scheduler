#!/usr/bin/env node
/**
 * Gateway bundle audit for the isolated Durable Object staging topology.
 *
 * The gateway must stay thin: it may not contain the production runtime, Zod,
 * Temporal, Node builtins, or the staging service/composition. This script
 * scans the gateway bundle emitted by `build:worker:gateway` and fails when a
 * forbidden token appears, so a heavy import cannot slip past review.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const FORBIDDEN_TOKENS = [
  // Production runtime and its heavy dependencies.
  'from"../server', 'from"../shared', 'from"../worker',
  'createProductionRuntime', 'createStagingReadService', 'createSnapshotBatchReader',
  'request-policy', 'zod', 'js-temporal', 'Temporal.',
  'schedulingRuns', 'workbookConfiguration',
  // Node builtins must never land in a Worker bundle.
  'from"node:', 'from"fs"', 'from"path"', 'from"url"',
  // Secrets or workbook material must not be embedded.
  'private_key', 'BEGIN PRIVATE KEY'
];

function fail(message) {
  console.error(`gateway bundle audit failed: ${message}`);
  process.exitCode = 1;
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else if (['.js', '.mjs'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

const directory = process.argv[2];
if (!directory) {
  fail('a bundle directory is required: audit-gateway-bundle.mjs <dist/worker-gateway>');
  process.exit(1);
}
try {
  await stat(directory);
} catch {
  fail(`bundle directory ${directory} does not exist; run the gateway build first.`);
  process.exit(1);
}

const files = await collectFiles(directory);
if (files.length === 0) {
  fail(`no bundle files found under ${directory}.`);
  process.exit(1);
}

for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const token of FORBIDDEN_TOKENS) {
    if (source.includes(token)) {
      fail(`${file} contains a forbidden token: ${token}`);
    }
  }
}

if (process.exitCode === undefined || process.exitCode === 0) {
  const totalBytes = await Promise.all(files.map(async (file) => (await stat(file)).size));
  const bytes = totalBytes.reduce((total, size) => total + size, 0);
  console.log(`gateway bundle audit passed: ${files.length} file(s), ${bytes} bytes, no forbidden imports.`);
}
