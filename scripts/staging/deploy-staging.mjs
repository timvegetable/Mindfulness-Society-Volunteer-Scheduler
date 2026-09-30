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
/** The name prefix that keeps an ad-hoc binding inside the staging deployment. */
const VARIABLE_PREFIX = 'STAGING_';
/** The variables this tool writes itself, with the flag that owns each. */
const TOOL_VARIABLES = new Map([
  ['STAGING_DEPLOYED_AT', 'every deploy stamps its own version marker'],
  ['STAGING_WORKBOOK_ID', 'use --workbook, which the tool records as the workbook override']
]);
/** The plan cannot know the marker's value; it is stamped when the deploy runs. */
const DEPLOYED_AT_PLACEHOLDER = '<generated at deploy time>';

/**
 * Parses one `--var NAME:VALUE`. The repeatable option exists so instrumentation
 * and fixture bindings (`STAGING_BRACKET_HOLD_MS`, `STAGING_CONTROL_AUTHORITY`)
 * no longer require a transient edit to `wrangler.jsonc`, which the 2026-09-29
 * D1 rehearsal did. Names are restricted to `STAGING_*`, and the two variables
 * the tool writes itself are refused, so a typo can neither bind a
 * production-shaped name nor shadow the deployment marker the version-lag check
 * reads.
 */
export function parseVariable(argument, raw) {
  const separator = raw.indexOf(':');
  if (separator === -1) throw new Error(`${argument} ${raw} is malformed: use --var NAME:VALUE.`);
  const name = raw.slice(0, separator);
  const value = raw.slice(separator + 1);
  if (name.length === 0) throw new Error(`${argument} ${raw} is malformed: the name before the colon is empty.`);
  if (value.trim().length === 0) throw new Error(`${argument} ${name}: is malformed: the value after the colon is empty.`);
  if (!name.startsWith(VARIABLE_PREFIX) || name.length === VARIABLE_PREFIX.length) {
    throw new Error(`${argument} ${name} is refused: a staging deployment variable name must begin with ${VARIABLE_PREFIX}.`);
  }
  const toolNote = TOOL_VARIABLES.get(name);
  if (toolNote !== undefined) throw new Error(`${argument} ${name} is refused: ${toolNote}.`);
  return { name, value };
}

export function parseArguments(argv) {
  const options = {
    tokenFile: 'staging-local/cloudflare-api-token.txt',
    key: 'staging-local/google-service-account.json',
    workbook: undefined,
    environment: 'staging',
    /** Which bundle to deploy: the baseline Worker, the DO host, or the gateway. */
    target: 'baseline',
    /** Repeatable `--var NAME:VALUE` bindings, in the order they were given. */
    variables: [],
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
    else if (argument === '--var') {
      const variable = parseVariable(argument, next());
      if (options.variables.some((existing) => existing.name === variable.name)) {
        throw new Error(`${argument} ${variable.name} was given twice; one value per variable.`);
      }
      options.variables.push(variable);
    }
    else if (argument === '--target') {
      const value = next();
      if (!['baseline', 'host', 'gateway'].includes(value)) throw new Error(`--target must be baseline, host or gateway, not ${value}.`);
      options.target = value;
    }
    else if (argument === '--benchmark-enabled') options.benchmarkEnabled = true;
    else if (argument === '--report') options.report = next();
    else if (argument === '--confirm-deploy') options.confirm = true;
    else if (argument === '--plan') options.plan = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.target !== 'baseline') options.environment = options.target === 'host' ? 'staging-host' : 'staging-gateway';
  if (options.benchmarkEnabled === true && options.target !== 'host') throw new Error('--benchmark-enabled applies to the host target only; the flag lives on the Durable Object host.');
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

/**
 * Every `--var` binding a deploy passes, in the order wrangler receives them:
 * the version marker, the workbook override, the benchmark switch, then the
 * operator's repeatable `--var` values. The plan prints the same list with the
 * marker's value still ungenerated, so what a reviewer approves is exactly what
 * the deploy sets, and the report records the same list afterwards.
 */
export function deployVariables(options, deployedAt) {
  const variables = [{ name: 'STAGING_DEPLOYED_AT', value: deployedAt }];
  if (options.workbook !== undefined) variables.push({ name: 'STAGING_WORKBOOK_ID', value: options.workbook });
  if (options.benchmarkEnabled === true) variables.push({ name: 'STAGING_PREVIEW_BENCHMARK_ENABLED', value: 'true' });
  variables.push(...options.variables);
  return variables;
}

/**
 * The deployment report a run writes. It is built as a pure function so the
 * recorded bindings are contractual: an instrumentation rehearsal is
 * reproducible from its report without a second deploy.
 */
export function deploymentReport(options, { deployedAt, url, serviceAccountEmail }) {
  return {
    deployedAt,
    accountId: ACCOUNT_ID,
    environment: options.environment,
    target: options.target,
    // The gateway serves /exec and, when the benchmark is enabled, the preview
    // route; the host serves nothing publicly.
    workerUrl: url ?? null,
    ...(url === null || url === undefined
      ? {}
      : {
        execUrl: `${url}/exec`,
        ...(options.target === 'gateway' ? { benchmarkUrl: `${url}/benchmark/schedule-preview` } : {})
      }),
    serviceAccountEmail: serviceAccountEmail ?? null,
    workbookOverride: options.workbook ?? null,
    benchmarkEnabled: options.benchmarkEnabled === true,
    // Every binding the deployment set, the operator's `--var` values verbatim.
    // These are instrumentation and fixture bindings, not secrets: a value given
    // here is recorded in the report and in the plan, so key material must keep
    // going through `wrangler secret put`, which never echoes it.
    variables: deployVariables(options, deployedAt),
    // Sanitization: the token, the key and the secret values are never recorded.
    sanitized: true
  };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\nUsage: deploy-staging.mjs [--token-file PATH] [--key PATH] [--workbook ID] [--var NAME:VALUE] [--env staging] [--report PATH] [--plan] --confirm-deploy`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log('Usage: deploy-staging.mjs [--token-file PATH] [--key PATH] [--workbook ID] [--var NAME:VALUE] [--env staging] [--report PATH] [--plan] --confirm-deploy');
    return;
  }

  // The gateway holds no Google credentials and needs no key material, so the
  // helper never reads it for that target. The host and the baseline do.
  let serviceAccount;
  if (options.target !== 'gateway') {
    try {
      serviceAccount = await readServiceAccountKey(resolve(options.key));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
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

  // The plan names every binding the deploy will pass, including the marker the
  // real deploy stamps, so the review covers the instrumentation `--var` values
  // that would otherwise need a transient wrangler.jsonc edit.
  const plannedVariables = deployVariables(options, DEPLOYED_AT_PLACEHOLDER);
  const deployStep = `wrangler deploy --env ${options.environment}${plannedVariables.map((variable) => ` --var ${variable.name}:${variable.value}`).join('')}`;
  // Google credentials are provisioned only where they are used: the DO host
  // and the baseline Worker, never the gateway.
  const steps = options.target === 'gateway'
    ? [deployStep]
    : [
      deployStep,
      'wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY --env ' + options.environment,
      'wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL --env ' + options.environment
    ];
  if (options.plan || !options.confirm) {
    console.log(JSON.stringify({
      accountId: ACCOUNT_ID,
      environment: options.environment,
      target: options.target,
      // The isolated topology deploys the host before the gateway; every
      // deployment, including cold-start redeploys, needs its own approval.
      deploymentOrder: options.target === 'baseline' ? null : 'host first, then gateway',
      tokenFile: options.tokenFile,
      tokenPresent,
      keyPath: options.target === 'gateway' ? null : options.key,
      serviceAccountEmail: serviceAccount?.clientEmail ?? null,
      workbookOverride: options.workbook ?? null,
      variables: plannedVariables,
      steps,
      writes: true
    }, null, 2));
    if (!options.confirm) {
      console.error('Refusing to deploy: pass --confirm-deploy once the staging deployment is approved.');
      process.exitCode = options.plan ? 0 : 1;
    }
    return;
  }

  // Code first, then secrets. Cloudflare refuses a secret whose name the deployed
  // version already binds as a plain variable (error 10053), so a change of
  // binding kind only takes effect if the deploy clears the variable first.
  const environment = { token };
  // Every deployment stamps its own marker, so the host's responses carry the
  // version a measurement can verify the object against before counting cold
  // observations (a redeploy does not immediately restart an existing object).
  const deployedAt = new Date().toISOString();
  const deployArgs = ['deploy', '--env', options.environment, ...deployVariables(options, deployedAt).flatMap((variable) => ['--var', `${variable.name}:${variable.value}`])];
  const deploy = wrangler(deployArgs, environment);
  let url = deployedUrl(`${deploy.stdout}\n${deploy.stderr}`);
  // The DO host has no workers.dev endpoint, so a missing URL is expected there.
  const urlExpected = options.target === 'baseline' || options.target === 'gateway';
  if (deploy.status !== 0 || (url === undefined && urlExpected)) {
    console.error('The deploy failed.');
    // The tail is enough to diagnose and contains no secret.
    console.error((deploy.stderr || deploy.stdout).slice(-1200));
    process.exitCode = 1;
    return;
  }

  if (options.target !== 'gateway') {
    for (const [name, value] of [['GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', serviceAccount.privateKey], ['GOOGLE_SERVICE_ACCOUNT_EMAIL', serviceAccount.clientEmail]]) {
      const result = wrangler(['secret', 'put', name, '--env', options.environment], environment, { stdin: value });
      if (result.status !== 0) {
        console.error(`Setting ${name} failed.`);
        console.error((result.stderr || result.stdout).slice(-600));
        process.exitCode = 1;
        return;
      }
    }
  }

  // A secret upload creates a new version; re-read the URL in case it changed.
  url = url ?? deployedUrl(`${deploy.stdout}\n${deploy.stderr}`);

  const report = deploymentReport(options, { deployedAt, url, serviceAccountEmail: serviceAccount?.clientEmail });
  const reportPath = resolve(options.report ?? `staging-local/deployment-${options.environment}.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) await main();
