#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  ConfigError,
  readJsonFile,
  summarizeConfig,
  validateConfig,
  validatePublicConfig
} from './lib/config.mjs';

const PRIVATE_CONTENT_PATTERN = /(?:"(?:sheetId|sheetOwnerEmail|administratorRecipients|oauthAudience|writeEnabled)"|private_key|client_secret|service_account)/iu;
const FORBIDDEN_FILE_PATTERN = /(?:^|\/)(?:\.env(?:\.|$)|\.clasp\.json$|credentials?[^/]*|service-account[^/]*|private[^/]*)/iu;

function usage() {
  console.error('Usage: node scripts/deployment-check.mjs --config PRIVATE_CONFIG_PATH --public-config PUBLIC_CONFIG_PATH --dist CLIENT_DIST_PATH [--server-dist APPS_SCRIPT_DIST_PATH] [--report REPORT_PATH] [--allow-write-enabled --confirm-write-enabled ENABLE_PRODUCTION_WRITES]');
}

function parseArgs(argv) {
  const result = {};
  const flags = new Set(['allow-write-enabled']);
  const values = new Set(['config', 'public-config', 'dist', 'server-dist', 'report', 'confirm-write-enabled']);
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
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  for (const key of ['config', 'public-config', 'dist']) if (!result[key]) throw new Error(`--${key} is required`);
  if (result['allow-write-enabled'] && result['confirm-write-enabled'] !== 'ENABLE_PRODUCTION_WRITES') {
    throw new Error('--allow-write-enabled requires --confirm-write-enabled ENABLE_PRODUCTION_WRITES');
  }
  if (!result['allow-write-enabled'] && result['confirm-write-enabled']) {
    throw new Error('--confirm-write-enabled is only valid with --allow-write-enabled');
  }
  return result;
}

async function walkFiles(root, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(path, relative));
    else if (entry.isFile()) files.push({ path, relative });
  }
  return files;
}

async function saveReport(path, report) {
  if (!path) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`Wrote scrubbed deployment report (${report.status}).`);
}

const report = {
  tool: 'deployment-check',
  status: 'blocked',
  productionMutation: 'none',
  administratorReview: [
    'Confirm private configuration values are loaded from an administrator-controlled secret or local file, never from the public bundle.',
    'Keep Apps Script writeEnabled=false for initial deployment and migration. Enabling writes requires a deliberate protected deployment review.',
    'Retain the previous completed scheduling revision and an exported Sheet snapshot before publishing a new revision.',
    'Retain the previous GitHub Pages artifact and Apps Script deployment identifier for rollback.',
    'After deployment, browser-verify volunteer own-data isolation, administrator controls, preview state, and failed-write behavior.'
  ],
  checks: {},
  issues: []
};

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  usage();
  console.error(error.message);
  process.exit(2);
}

try {
  const config = await readJsonFile(args.config);
  const privateResult = validateConfig(config);
  report.checks.privateConfiguration = privateResult.valid;
  report.privateConfigurationSummary = summarizeConfig(config);
  report.issues.push(...privateResult.issues);

  if (config.writeEnabled === true && !args['allow-write-enabled']) {
    report.issues.push('writeEnabled must be false for a safe deployment check; no production writes are enabled');
  }
  if (config.writeEnabled === true && args['allow-write-enabled']) {
    report.checks.explicitWriteApproval = true;
    report.warnings = ['writeEnabled is true and was explicitly approved for this check; review the deployment boundary before proceeding.'];
  } else {
    report.checks.explicitWriteApproval = false;
  }

  const publicConfig = await readJsonFile(args['public-config']);
  const publicResult = validatePublicConfig(publicConfig, config);
  report.checks.publicConfiguration = publicResult.valid;
  report.issues.push(...publicResult.issues);

  let clientFiles = [];
  try {
    const distInfo = await stat(args.dist);
    if (!distInfo.isDirectory()) report.issues.push('client dist path is not a directory');
    else clientFiles = await walkFiles(args.dist);
  } catch {
    report.issues.push('client dist path is missing or unreadable');
  }
  report.checks.clientDistPresent = clientFiles.length > 0;
  const clientRelative = new Set(clientFiles.map((file) => file.relative));
  if (!clientRelative.has('index.html')) report.issues.push('client dist is missing index.html');
  if (!clientRelative.has('config.json')) report.issues.push('client dist is missing generated config.json');

  let unsafeFiles = [];
  let unsafeContentFiles = [];
  for (const file of clientFiles) {
    if (FORBIDDEN_FILE_PATTERN.test(file.relative)) unsafeFiles.push(basename(file.relative));
    try {
      const bytes = await readFile(file.path);
      if (bytes.byteLength <= 8 * 1024 * 1024 && PRIVATE_CONTENT_PATTERN.test(bytes.toString('utf8'))) unsafeContentFiles.push(basename(file.relative));
    } catch {
      report.issues.push('client artifact contains an unreadable file');
    }
  }
  if (unsafeFiles.length > 0) report.issues.push('client artifact contains a forbidden private/credential file');
  if (unsafeContentFiles.length > 0) report.issues.push('client artifact contains a private configuration key or credential marker');
  report.checks.noPrivateArtifactFiles = unsafeFiles.length === 0;
  report.checks.noPrivateContentMarkers = unsafeContentFiles.length === 0;
  report.clientFileCount = clientFiles.length;

  if (clientRelative.has('config.json')) {
    try {
      const builtPublicConfig = JSON.parse(await readFile(join(args.dist, 'config.json'), 'utf8'));
      const builtResult = validatePublicConfig(builtPublicConfig, config);
      report.checks.builtPublicConfiguration = builtResult.valid;
      report.issues.push(...builtResult.issues);
    } catch {
      report.checks.builtPublicConfiguration = false;
      report.issues.push('generated client config.json is not valid JSON');
    }
  }

  if (args['server-dist']) {
    try {
      const serverFiles = await walkFiles(args['server-dist']);
      report.checks.serverDistPresent = serverFiles.some((file) => file.relative === 'Code.js') && serverFiles.some((file) => file.relative === 'appsscript.json');
      report.serverFileCount = serverFiles.length;
      if (!report.checks.serverDistPresent) report.issues.push('Apps Script dist must contain Code.js and appsscript.json');
      const migrationArtifacts = serverFiles.filter((file) => file.relative === 'MigrationPayload.gs');
      report.checks.noMigrationPayload = migrationArtifacts.length === 0;
      if (migrationArtifacts.length > 0) {
        report.issues.push('Apps Script dist contains MigrationPayload.gs; it is a temporary migration-only file that must be deleted before an ordinary deployment');
      }
    } catch {
      report.checks.serverDistPresent = false;
      report.issues.push('Apps Script dist path is missing or unreadable');
    }
  }

  report.status = report.issues.length === 0 ? 'ready' : 'blocked';
} catch (error) {
  report.issues.push(error instanceof ConfigError ? 'configuration could not be loaded' : error.message || 'deployment inputs could not be processed');
}

await saveReport(args.report, report);
if (report.status !== 'ready') process.exitCode = 1;
