#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ConfigError, readJsonFile, summarizeConfig, validateConfig } from './lib/config.mjs';

function usage() {
  console.error('Usage: node scripts/rollback.mjs --config PRIVATE_CONFIG_PATH --previous-revision REVISION --sheet-export PATH --static-artifact PATH --report REPORT_PATH [--execute]');
}

function parseArgs(argv) {
  const result = {};
  const flags = new Set(['execute']);
  const values = new Set(['config', 'previous-revision', 'sheet-export', 'static-artifact', 'report']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (flags.has(key)) {
      result[key] = true;
      continue;
    }
    if (!values.has(key)) throw new Error(`Unknown option: --${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    result[key] = value;
    index += 1;
  }
  for (const key of ['config', 'previous-revision', 'sheet-export', 'static-artifact', 'report']) {
    if (!result[key]) throw new Error(`--${key} is required`);
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(result['previous-revision'])) throw new Error('--previous-revision contains unsupported characters');
  return result;
}

async function exists(path, expected) {
  try {
    const info = await stat(path);
    return expected === 'file' ? info.isFile() : expected === 'directory' ? info.isDirectory() : true;
  } catch {
    return false;
  }
}

async function saveReport(path, report) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  usage();
  console.error(error.message);
  process.exit(2);
}

const report = {
  tool: 'rollback',
  status: 'blocked',
  mode: args.execute ? 'execution-requested-but-not-automatic' : 'dry-run-checklist',
  productionMutation: 'none',
  checks: {},
  issues: [],
  administratorReview: [
    'Disable Apps Script writes and verify the write-disabled deployment before changing any production pointer.',
    'Verify the prior completed schedule revision is internally consistent, then switch the current revision pointer to it under the Apps Script scheduling lock.',
    'Restore the exported Sheet tabs only when schema/data review requires it; preserve the export as an immutable rollback artifact.',
    'Restore the previous GitHub Pages static artifact and verify its deployment URL before directing users to it.',
    'Run volunteer and administrator browser verification after rollback, including own-data isolation and the visible revision/status.',
    'Re-enable writes only after a separate administrator review; this command never changes production.'
  ]
};

try {
  const config = await readJsonFile(args.config);
  const configResult = validateConfig(config);
  report.checks.privateConfiguration = configResult.valid;
  report.privateConfigurationSummary = summarizeConfig(config);
  report.issues.push(...configResult.issues);
  report.checks.writeDisabled = config.writeEnabled === false;
  if (config.writeEnabled !== false) report.issues.push('rollback requires writeEnabled=false before any administrator applies the checklist');
  report.checks.previousSheetExportPresent = await exists(args['sheet-export'], 'file');
  report.checks.previousStaticArtifactPresent = await exists(args['static-artifact'], 'file') || await exists(args['static-artifact'], 'directory');
  if (!report.checks.previousSheetExportPresent) report.issues.push('prior Sheet export is missing or unreadable');
  if (!report.checks.previousStaticArtifactPresent) report.issues.push('prior static deployment artifact is missing or unreadable');
  if (args.execute) report.issues.push('automatic production rollback is intentionally unavailable; apply the reviewed checklist through protected administrator controls');
  report.status = report.issues.length === 0 ? 'ready-for-administrator-review' : 'blocked';
} catch (error) {
  report.issues.push(error instanceof ConfigError ? 'configuration could not be loaded' : error.message || 'rollback inputs could not be processed');
}

await saveReport(args.report, report);
console.log(`Wrote rollback checklist (${report.status}).`);
if (report.status !== 'ready-for-administrator-review') process.exitCode = 1;
