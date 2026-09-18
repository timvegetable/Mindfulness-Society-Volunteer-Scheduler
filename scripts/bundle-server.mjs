#!/usr/bin/env node
// Bundles the Apps Script server entry point.
//
// The only transformation beyond esbuild defaults is dropping zod's unused
// locale bundle: `zod/v4/core` re-exports `../locales/index.js`, which pulls in
// ~40 translations (1.6 MB on disk) for languages this deployment never uses.
// The stub keeps `en`, so default message formatting still resolves, while the
// emitted file loses roughly a third of its bytes - which matters because Apps
// Script re-parses the whole file on every execution.
import { build } from 'esbuild';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = `${ROOT}/dist/apps-script/Code.js`;

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
await build({
  entryPoints: [`${ROOT}/src/server/main.ts`],
  bundle: true,
  format: 'iife',
  globalName: 'VolunteerScheduling',
  platform: 'neutral',
  target: 'es2019',
  mainFields: ['module', 'main'],
  outfile: OUT,
  plugins: [keepEnglishLocalesOnly],
  logLevel: 'info'
});

const { size } = await stat(OUT);
console.log(`Code.js: ${(size / 1024).toFixed(0)} KB`);
