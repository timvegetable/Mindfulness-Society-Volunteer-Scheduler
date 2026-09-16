#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ConfigError,
  readJsonFile,
  summarizeConfig,
  validateConfig,
  validatePublicConfig
} from './lib/config.mjs';

function usage() {
  console.error('Usage: node scripts/validate-config.mjs --config PATH [--public-config PATH] [--report PATH]');
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!['config', 'public-config', 'report'].includes(key)) throw new Error(`Unknown option: --${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

async function saveReport(path, report) {
  if (!path) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`Wrote scrubbed validation report (${report.status}).`);
}

const report = {
  tool: 'validate-config',
  status: 'invalid',
  checks: {},
  issues: [],
  administratorReview: [
    'Confirm the IANA time zone and display increment match the scheduling policy.',
    'Confirm operating hours and administrator notification recipients.',
    'Confirm OAuth audience and Apps Script deployment are the intended production values.',
    'Confirm protected Sheet ID and owner are private, administrator-controlled values.',
    'Keep writeEnabled false until production migration, preview, and browser verification are accepted.'
  ]
};

let args;
try {
  args = parseArgs(process.argv.slice(2));
  if (!args.config) throw new Error('--config is required');
} catch (error) {
  usage();
  console.error(error.message);
  process.exitCode = 2;
} 

if (process.exitCode === undefined) {
  try {
    const config = await readJsonFile(args.config);
    const privateResult = validateConfig(config);
    report.checks.privateConfiguration = privateResult.valid;
    report.checks.summary = summarizeConfig(config);
    report.issues.push(...privateResult.issues);

    if (args['public-config']) {
      const publicConfig = await readJsonFile(args['public-config']);
      const publicResult = validatePublicConfig(publicConfig, config);
      report.checks.publicConfiguration = publicResult.valid;
      report.issues.push(...publicResult.issues);
    }
    report.status = report.issues.length === 0 ? 'valid' : 'invalid';
  } catch (error) {
    report.issues.push(...(error instanceof ConfigError ? error.issues : [error.message]));
    report.status = 'invalid';
  }

  await saveReport(args.report, report);
  if (report.status !== 'valid') process.exitCode = 1;
}
