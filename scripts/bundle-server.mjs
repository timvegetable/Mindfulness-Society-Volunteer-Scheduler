#!/usr/bin/env node
// Bundles the Apps Script server entry point.
//
// Minification and dropping zod's unused locale bundle reduce parse work.
// `zod/v4/core` re-exports `../locales/index.js`, which pulls in
// ~40 translations (1.6 MB on disk) for languages this deployment never uses.
// The stub keeps `en`, so default message formatting still resolves, while the
// emitted file loses roughly a third of its bytes - which matters because Apps
// Script re-parses the whole file on every execution.
import { build } from 'esbuild';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const flags = process.argv.slice(2);
const trial = flags.includes('--unminified-trial');
if (flags.some((arg) => arg !== '--unminified-trial')) throw new Error('Only --unminified-trial is supported');
const OUT_DIR = `${ROOT}/dist/${trial ? 'apps-script-unminified-trial' : 'apps-script'}`;
const OUT = `${OUT_DIR}/Code.js`;
// The migration payload is a separate, temporary file that is pasted into the
// Apps Script project by hand. A stale copy left in the dist directory would be
// pushed by `clasp push` on every later deployment, so remove it up front.
const LEGACY_MIGRATION_PAYLOAD = `${OUT_DIR}/MigrationPayload.gs`;

const keepEnglishLocalesOnly = {
  name: 'drop-unused-zod-locales',
  setup(builder) {
    builder.onResolve({ filter: /locales\/index\.js$/ }, (args) => {
      if (!args.importer.includes('zod')) return undefined;
      return { path: 'zod-locales-stub', namespace: 'zod-locales-stub' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'zod-locales-stub' }, () => ({
      contents: 'export { default as en } from "zod/v4/locales/en.js";',
      loader: 'js',
      resolveDir: ROOT
    }));
  }
};

await mkdir(dirname(OUT), { recursive: true });
const staleMigrationPayload = await stat(LEGACY_MIGRATION_PAYLOAD).then(() => true).catch(() => false);
if (staleMigrationPayload) {
  await rm(LEGACY_MIGRATION_PAYLOAD, { force: true });
  console.log('Removed stale dist/apps-script/MigrationPayload.gs');
}
const result = await build({
  entryPoints: [`${ROOT}/src/server/main.ts`],
  bundle: true,
  format: 'iife',
  globalName: 'VolunteerScheduling',
  platform: 'neutral',
  target: 'es2019',
  mainFields: ['module', 'main'],
  outfile: OUT,
  plugins: [keepEnglishLocalesOnly],
  minify: !trial,
  metafile: true,
  logLevel: 'info'
});

const { size } = await stat(OUT);
console.log(`Code.js: ${(size / 1024).toFixed(0)} KB`);
const inputs = Object.entries(result.metafile.inputs)
  .map(([path, value]) => ({ path: path.replaceAll(ROOT + '/', ''), bytes: value.bytes }))
  .sort((left, right) => right.bytes - left.bytes);
const outputs = Object.entries(result.metafile.outputs)
  .map(([path, value]) => ({ path: path.replaceAll(ROOT + '/', ''), bytes: value.bytes,
    inputs: Object.entries(value.inputs).map(([input, contribution]) => ({ path: input.replaceAll(ROOT + '/', ''), bytesInOutput: contribution.bytesInOutput })).sort((left, right) => right.bytesInOutput - left.bytesInOutput) }));
await writeFile(`${ROOT}/dist/bundle-evidence${trial ? '-unminified-trial' : ''}.json`, JSON.stringify({ minified: !trial, emittedBytes: size, inputs, outputs }, null, 2) + '\n');
