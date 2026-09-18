#!/usr/bin/env node
// Packages the reviewed migration artifacts into an Apps Script source file so an
// administrator can run validateMigrationWorkbook() then loadMigrationWorkbook()
// from the Apps Script editor. Nothing is written to any Sheet by this script.
//
// The payload is declared with `var` on purpose: Apps Script evaluates each file
// in its own script scope, so `const`/`let` in one file are not visible to the
// bundle's IIFE, while `var` lands on the global object where the loader reads it.
// The payload holds real names and email addresses: it is written only to
// dist/ and migration-output/ (both gitignored) and must be deleted from the
// Apps Script project after the load completes.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = `${ROOT}/migration-output`;
const BUNDLE_DIR = `${ROOT}/dist/apps-script`;
const TABS = { volunteers: 'volunteers.json', centers: 'centers.json', sessions: 'sessions.json' };

async function readRows(file) {
  try {
    const parsed = JSON.parse(await readFile(`${OUT_DIR}/${file}`, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${file} is not an array`);
    return parsed;
  } catch (error) {
    throw new Error(`cannot build the migration payload: ${file} is unreadable (${error.message}); run build-roster.mjs and build-sessions.mjs first`);
  }
}

const payload = { generatedAt: new Date().toISOString() };
for (const [key, file] of Object.entries(TABS)) payload[key] = await readRows(file);

const source = `/**
 * GENERATED migration payload - contains real volunteer contact data.
 * Do not commit this file and delete it from the Apps Script project once the
 * migration has been loaded. Re-generate with scripts/build-migration-payload.mjs.
 *
 * Run order in the Apps Script editor:
 *   1. validateMigrationWorkbook()  - validates every row, writes nothing
 *   2. set Script Property WRITE_ENABLED = true
 *   3. loadMigrationWorkbook()      - writes Volunteers, Centers, Sessions
 *   4. delete this file and set WRITE_ENABLED = false
 */
var MIGRATION_PAYLOAD = ${JSON.stringify(payload, null, 2)};
`;

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/MigrationPayload.gs`, source, { mode: 0o600 });
try {
  await writeFile(`${BUNDLE_DIR}/MigrationPayload.gs`, source, { mode: 0o600 });
  console.log(`wrote dist/apps-script/MigrationPayload.gs (${source.length} bytes) ready for clasp push`);
} catch (error) {
  console.log(`wrote migration-output/MigrationPayload.gs (${source.length} bytes); bundle copy skipped: ${error.message}`);
}
console.log(`payload: ${payload.volunteers.length} volunteers, ${payload.centers.length} centers, ${payload.sessions.length} sessions`);
