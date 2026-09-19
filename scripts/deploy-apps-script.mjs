#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { ConfigError, readJsonFile, summarizeConfig, validateConfig } from './lib/config.mjs';

function usage() {
  console.error('Usage: node scripts/deploy-apps-script.mjs --config PRIVATE_CONFIG_PATH --server-dist APPS_SCRIPT_DIST_PATH --report REPORT_PATH [--deployment-id ID] [--execute --confirm DEPLOY_APPS_SCRIPT_WITH_WRITES_DISABLED]');
}

function parseArgs(argv) {
  const result = {};
  const values = new Set(['config', 'server-dist', 'report', 'confirm', 'deployment-id']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--execute') {
      result.execute = true;
      continue;
    }
    if (!values.has(arg.slice(2)) || !arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    result[arg.slice(2)] = value;
    index += 1;
  }
  for (const key of ['config', 'server-dist', 'report']) if (!result[key]) throw new Error(`--${key} is required`);
  if (result.execute && result.confirm !== 'DEPLOY_APPS_SCRIPT_WITH_WRITES_DISABLED') {
    throw new Error('--execute requires --confirm DEPLOY_APPS_SCRIPT_WITH_WRITES_DISABLED');
  }
  if (!result.execute && result.confirm) throw new Error('--confirm is only valid with --execute');
  return result;
}

async function saveReport(path, report) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function runClasp(rootDir, deploymentId) {
  // A published web app serves a pinned version, so pushing code without a new
  // version leaves production on the previous build. When the deployment id is
  // supplied, redeploy it to the freshly pushed code.
  const args = deploymentId
    ? ['create-deployment', '--deploymentId', deploymentId, '--description', `deploy ${new Date().toISOString()}`]
    : ['push', '--rootDir', rootDir];
  return new Promise((resolve) => {
    const child = spawn('clasp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let outputBytes = 0;
    child.stdout.on('data', (chunk) => { outputBytes += chunk.byteLength; });
    child.stderr.on('data', (chunk) => { outputBytes += chunk.byteLength; });
    child.on('error', () => resolve({ ok: false, outputBytes }));
    child.on('exit', (code, signal) => resolve({ ok: code === 0, outputBytes, signal: signal ?? null }));
  });
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
  tool: 'deploy-apps-script',
  status: 'blocked',
  mode: args.execute ? 'explicit-execution' : 'dry-run-checklist',
  productionMutation: 'none',
  checks: {},
  issues: [],
  administratorReview: [
    'Export the current Sheet tabs and record the last completed schedule revision before deployment.',
    'Verify the Apps Script private property or configuration has writeEnabled=false before pushing code.',
    'Verify the intended Apps Script project/deployment identity using administrator-owned clasp credentials.',
    'After deployment, exercise authentication, authorization, preview, stale revision, and failed-write behavior before enabling writes.',
    'Pass --deployment-id so the published URL is redeployed to the pushed code; a pinned deployment otherwise keeps serving the previous version.',
    'Retain the prior Apps Script deployment and Sheet export for rollback.'
  ]
};

try {
  const config = await readJsonFile(args.config);
  const configResult = validateConfig(config);
  report.checks.privateConfiguration = configResult.valid;
  report.privateConfigurationSummary = summarizeConfig(config);
  report.issues.push(...configResult.issues);
  report.checks.writeDisabled = config.writeEnabled === false;
  if (config.writeEnabled !== false) report.issues.push('Apps Script deployment requires writeEnabled=false');

  try {
    const serverInfo = await stat(args['server-dist']);
    report.checks.serverDistPresent = serverInfo.isDirectory();
    if (serverInfo.isDirectory()) {
      const names = await readFile(`${args['server-dist']}/appsscript.json`, 'utf8').then(() => true).catch(() => false);
      const code = await readFile(`${args['server-dist']}/Code.js`, 'utf8').then(() => true).catch(() => false);
      report.checks.serverManifestPresent = names;
      report.checks.serverBundlePresent = code;
      if (!names || !code) report.issues.push('Apps Script dist must contain Code.js and appsscript.json');
      const migrationPayload = await stat(`${args['server-dist']}/MigrationPayload.gs`).then(() => true).catch(() => false);
      report.checks.noMigrationPayload = !migrationPayload;
      if (migrationPayload) {
        report.issues.push('Apps Script dist contains MigrationPayload.gs; delete the migration payload after loading it and rebuild dist before an ordinary deployment');
      }
    } else {
      report.issues.push('Apps Script dist path is not a directory');
    }
  } catch {
    report.checks.serverDistPresent = false;
    report.issues.push('Apps Script dist path is missing or unreadable');
  }

  if (args.execute && report.issues.length === 0) {
    const deploymentId = args['deployment-id'];
    if (deploymentId) report.checks.deploymentId = deploymentId;
    const push = await runClasp(args['server-dist']);
    report.checks.claspPushSucceeded = push.ok;
    if (!push.ok) report.issues.push('clasp push failed or clasp is unavailable; prior deployment remains unchanged');
    if (push.ok && deploymentId) {
      const deployed = await runClasp(args['server-dist'], deploymentId);
      report.checks.deploymentUpdated = deployed.ok;
      if (!deployed.ok) report.issues.push('clasp could not update the deployment, so the published URL still serves the previous version');
    }
    report.productionMutation = report.issues.length === 0 ? 'Apps Script code pushed and the pinned deployment updated; write gate remained disabled' : 'none';
  }
  report.status = report.issues.length === 0 ? (args.execute ? 'deployed-write-disabled' : 'ready-for-administrator-review') : 'blocked';
} catch (error) {
  report.issues.push(error instanceof ConfigError ? 'configuration could not be loaded' : error.message || 'Apps Script deployment inputs could not be processed');
}

await saveReport(args.report, report);
console.log(`Wrote Apps Script deployment report (${report.status}).`);
if (report.status === 'blocked') process.exitCode = 1;
