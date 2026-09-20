#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ConfigError, assertValidConfig, publicProjection, readJsonFile } from './lib/config.mjs';

function usage() {
  console.error('Usage: node scripts/render-public-config.mjs --config PRIVATE_CONFIG_PATH --output public/config.json');
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--config', '--output'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    result[arg.slice(2)] = value;
    index += 1;
  }
  if (!result.config || !result.output) throw new Error('--config and --output are required');
  return result;
}

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
  assertValidConfig(config, 'private configuration');
  const projection = publicProjection(config);
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o644 });
  console.log('Rendered public configuration with only the Apps Script URL, OAuth client ID, and scheduling time zone.');
} catch (error) {
  const issues = error instanceof ConfigError ? error.issues : [error.message];
  console.error('Public configuration was not written.');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exitCode = 1;
}
