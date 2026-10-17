// Generates a private, revision-fenced REST batch. This script never contacts production.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--backup', '--out', '--database-id'].includes(args[i]) || !args[i + 1] || Object.hasOwn(options, args[i])) throw Error('Use --backup <private.sql> --out <private-prefix> --database-id <target UUID>');
  options[args[i]] = args[i + 1];
}
if (!options['--backup'] || !options['--out'] || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options['--database-id'] ?? '')) throw Error('A backup, private output prefix and target database UUID are required');
const root = fileURLToPath(new URL('../', import.meta.url)), work = await mkdtemp(join(tmpdir(), 'schedule-backfill-'));
const sqlite = new DatabaseSync(':memory:');
try {
  sqlite.exec(await readFile(resolve(options['--backup']), 'utf8'));
  if (sqlite.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || sqlite.prepare('PRAGMA foreign_key_check').all().length) throw Error('Backup integrity check failed');
  sqlite.exec(await readFile(join(root, 'migrations/0004_schedule_reads.sql'), 'utf8'));
  await build({ stdin: { contents: `export {prepareScheduleBackfill} from ${JSON.stringify(join(root, 'src/worker/repositories/database.ts'))};`,
    resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'prepare.mjs'), logLevel: 'silent' });
  const { prepareScheduleBackfill } = await import(pathToFileURL(join(work, 'prepare.mjs')).href);
  const db = { prepare(sql) {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw Error('Backfill generator attempted a write');
    return { sql, params: [], bind(...params) { return { sql, params }; } };
  }, async batch(statements) { return statements.map(({ sql, params }) => ({ results: sqlite.prepare(sql).all(...params), success: true })); } };
  const plan = await prepareScheduleBackfill(db);
  const request = JSON.stringify({ batch: plan.map(({ sql, values }) => ({ sql, params: values })) });
  const manifest = { format: 1, databaseId: options['--database-id'], sourceDataRevision: Number(sqlite.prepare("SELECT value FROM meta WHERE key='dataRevision'").get()?.value ?? 0),
    requestSha256: createHash('sha256').update(request).digest('hex'), statements: plan.length };
  // Reserve both paths; never overwrite another operator's private plan.
  await writeFile(resolve(options['--out'] + '.request.json'), request, { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(options['--out'] + '.manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ prepared: true, statements: plan.length, productionContacted: false }) + '\n');
} finally { sqlite.close(); await rm(work, { recursive: true, force: true }); }
