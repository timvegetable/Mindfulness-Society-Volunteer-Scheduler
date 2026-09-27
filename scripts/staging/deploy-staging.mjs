#!/usr/bin/env node
// Deploys the staging Worker, setting its secrets first.
//
// Wrangler needs an API token outside a terminal, and this script is how the
// token stays in one ignored file: it reads the token and the service-account key
// from `staging-local/`, passes them to wrangler through the environment and
// stdin, and never prints either. It refuses to run without an explicit
// confirmation, because a deploy is a release action.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readServiceAccountKey } from './google-auth.mjs';

const ACCOUNT_ID = '868086b4b2dc75413ea149480ae4fe82';

export function parseArguments(argv) {
  const options = {
    tokenFile: 'staging-local/cloudflare-api-token.txt',
    key: 'staging-local/google-service-account.json',
    workbook: undefined,
    environment: 'staging',
    report: undefined,
    confirm: false,
    plan: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${argument} needs a value.`);
      return argv[index];
    };
    if (argument === '--token-file') options.tokenFile = next();
    else if (argument === '--key') options.key = next();
    else if (argument === '--workbook') options.workbook = next();
    else if (argument === '--env') options.environment = next();
    else if (argument === '--report') options.report = next();
    else if (argument === '--confirm-deploy') options.confirm = true;
    else if (argument === '--plan') options.plan = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function wrangler(args, environment, { stdin } = {}) {
  const result = spawnSync('node', ['node_modules/wrangler/bin/wrangler.js', ...args], {
    cwd: resolve('.'),
    encoding: 'utf8',
    input: stdin,
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: environment.token,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      WRANGLER_LOG_PATH: resolve('.jspace/wrangler-logs'),
      WRANGLER_SEND_METRICS: 'false'
    }
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** The only output of a deploy that later steps need. */
export function deployedUrl(output) {
  const match = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/iu.exec(output);
  return match?.[0];
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\nUsage: deploy-staging.mjs [--token-file PATH] [--key PATH] [--workbook ID] [--env staging] [--report PATH] [--plan] --confirm-deploy`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log('Usage: deploy-staging.mjs [--token-file PATH] [--key PATH] [--workbook ID] [--env staging] [--report PATH] [--plan] --confirm-deploy');
    return;
  }

  let serviceAccount;
  try {
    serviceAccount = await readServiceAccountKey(resolve(options.key));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  // A plan is reviewable without the credential; only an actual deploy needs it.
  let token = '';
  const tokenPresent = await readFile(resolve(options.tokenFile), 'utf8').then((value) => value.trim().length > 0).catch(() => false);
  if (options.confirm && !tokenPresent) {
    console.error(`The Cloudflare API token could not be read at ${options.tokenFile}.`);
    process.exitCode = 1;
    return;
  }
  if (tokenPresent) token = (await readFile(resolve(options.tokenFile), 'utf8')).trim();

  const steps = [
    'wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY --env ' + options.environment,
    'wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL --env ' + options.environment,
    `wrangler deploy --env ${options.environment}${options.workbook === undefined ? '' : ` --var STAGING_WORKBOOK_ID:${options.workbook}`}`
  ];
  if (options.plan || !options.confirm) {
    console.log(JSON.stringify({ accountId: ACCOUNT_ID, environment: options.environment, tokenFile: options.tokenFile, tokenPresent, keyPath: options.key, serviceAccountEmail: serviceAccount.clientEmail, workbookOverride: options.workbook ?? null, steps, writes: true }, null, 2));
    if (!options.confirm) {
      console.error('Refusing to deploy: pass --confirm-deploy once the staging deployment is approved.');
      process.exitCode = options.plan ? 0 : 1;
    }
    return;
  }

  const environment = { token };
  const privateKey = wrangler(['secret', 'put', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', '--env', options.environment], environment, { stdin: serviceAccount.privateKey });
  if (privateKey.status !== 0) {
    console.error('Setting GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY failed.');
    console.error((privateKey.stderr || privateKey.stdout).slice(-600));
    process.exitCode = 1;
    return;
  }
  const email = wrangler(['secret', 'put', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', '--env', options.environment], environment, { stdin: serviceAccount.clientEmail });
  if (email.status !== 0) {
    console.error('Setting GOOGLE_SERVICE_ACCOUNT_EMAIL failed.');
    console.error((email.stderr || email.stdout).slice(-600));
    process.exitCode = 1;
    return;
  }

  const deployArgs = ['deploy', '--env', options.environment];
  if (options.workbook !== undefined) deployArgs.push('--var', `STAGING_WORKBOOK_ID:${options.workbook}`);
  const deploy = wrangler(deployArgs, environment);
  const url = deployedUrl(`${deploy.stdout}\n${deploy.stderr}`);
  if (deploy.status !== 0 || url === undefined) {
    console.error('The deploy failed.');
    // The tail is enough to diagnose and contains no secret.
    console.error((deploy.stderr || deploy.stdout).slice(-1200));
    process.exitCode = 1;
    return;
  }

  const report = {
    deployedAt: new Date().toISOString(),
    accountId: ACCOUNT_ID,
    environment: options.environment,
    workerUrl: url,
    execUrl: `${url}/exec`,
    serviceAccountEmail: serviceAccount.clientEmail,
    workbookOverride: options.workbook ?? null,
    // Sanitization: the token, the key and the secret values are never recorded.
    sanitized: true
  };
  const reportPath = resolve(options.report ?? `staging-local/deployment-${options.environment}.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) await main();
