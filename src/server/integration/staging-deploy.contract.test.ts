import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployedUrl, deploymentReport, deployVariables, parseArguments } from '../../../scripts/staging/deploy-staging.mjs';

/**
 * The staging deploy and endpoint-verification tools are release actions, so the
 * tests that matter most are the ones proving they refuse: no deploy without an
 * explicit confirmation and a token, no verification against a host that is not a
 * staging Worker.
 */

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const DEPLOY = join(ROOT, 'scripts/staging/deploy-staging.mjs');
const VERIFY = join(ROOT, 'scripts/staging/verify-worker.mjs');

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('staging deploy tool', () => {
  it('reads the worker URL out of wrangler output', () => {
    const output = [
      'Total Upload: 1303.44 KiB / gzip: 237.17 KiB',
      'Uploaded volunteer-scheduling-staging (3.21 sec)',
      'Deployed volunteer-scheduling-staging triggers (0.42 sec)',
      '  https://volunteer-scheduling-staging.example-account.workers.dev',
      'Current Version ID: 5b1c2e3d-0000-4000-8000-abcdefabcdef'
    ].join('\n');
    expect(deployedUrl(output)).toBe('https://volunteer-scheduling-staging.example-account.workers.dev');
    expect(deployedUrl('no url here')).toBeUndefined();
  });

  it('prints the reviewable plan whether or not the credential is present', () => {
    const result = run(DEPLOY, ['--plan']);
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout) as { accountId: string; tokenPresent: boolean; steps: string[]; writes: boolean };
    expect(plan.accountId).toBe('868086b4b2dc75413ea149480ae4fe82');
    // Whether the ignored token file exists is local state, not a property of the
    // tool, so the plan only has to report it as a boolean.
    expect(typeof plan.tokenPresent).toBe('boolean');
    expect(plan.steps).toHaveLength(3);
    // Code before secrets: a secret whose name the deployed version binds as a
    // variable is refused until the deploy has cleared it.
    expect(plan.steps[0]).toContain('wrangler deploy --env staging');
    expect(plan.steps[1]).toContain('secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');
    expect(plan.writes).toBe(true);
  });

  it('refuses to deploy without the confirmation flag', () => {
    const result = run(DEPLOY, []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing to deploy');
  });

  it('refuses to deploy when the token file is missing', () => {
    const result = run(DEPLOY, ['--confirm-deploy', '--token-file', 'staging-local/does-not-exist.txt']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not be read');
  });

  it('refuses an unknown argument rather than ignoring it', () => {
    const result = run(DEPLOY, ['--account', 'someone-elses']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown argument');
  });

  it('accepts repeatable STAGING_* variables and shows them verbatim in the plan', () => {
    const result = run(DEPLOY, ['--plan', '--var', 'STAGING_BRACKET_HOLD_MS:8000', '--var', 'STAGING_CONTROL_AUTHORITY:workbook-control']);
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout) as { steps: string[]; variables: Array<{ name: string; value: string }> };
    expect(plan.variables).toEqual(expect.arrayContaining([
      { name: 'STAGING_BRACKET_HOLD_MS', value: '8000' },
      { name: 'STAGING_CONTROL_AUTHORITY', value: 'workbook-control' }
    ]));
    expect(plan.steps[0]).toContain('--var STAGING_BRACKET_HOLD_MS:8000');
    expect(plan.steps[0]).toContain('--var STAGING_CONTROL_AUTHORITY:workbook-control');

    // Only the first colon splits, so a value that itself contains one survives.
    const withColon = run(DEPLOY, ['--plan', '--var', 'STAGING_GATEWAY_URL:https://example.test/x']);
    expect(withColon.status).toBe(0);
    expect((JSON.parse(withColon.stdout) as { variables: Array<{ name: string; value: string }> }).variables)
      .toContainEqual({ name: 'STAGING_GATEWAY_URL', value: 'https://example.test/x' });
  });

  it('always plans the STAGING_DEPLOYED_AT marker the real deploy stamps', () => {
    const result = run(DEPLOY, ['--plan']);
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout) as { steps: string[]; variables: Array<{ name: string; value: string }> };
    expect(plan.variables[0]?.name).toBe('STAGING_DEPLOYED_AT');
    expect(plan.steps[0]).toContain('--var STAGING_DEPLOYED_AT:');
    // The deployed value is generated at deploy time and comes first, so the
    // version marker a measurement verifies is never an operator value.
    const options = parseArguments(['--confirm-deploy', '--var', 'STAGING_BRACKET_HOLD_MS:8000']);
    expect(deployVariables(options, '2026-09-29T00:00:00.000Z')[0])
      .toEqual({ name: 'STAGING_DEPLOYED_AT', value: '2026-09-29T00:00:00.000Z' });
  });

  it('records the requested variables in the deployment report', () => {
    const options = parseArguments([
      '--confirm-deploy', '--workbook', 'sheet-123',
      '--var', 'STAGING_BRACKET_HOLD_MS:8000', '--var', 'STAGING_CONTROL_AUTHORITY:workbook-control'
    ]);
    const report = deploymentReport(options, {
      deployedAt: '2026-09-29T00:00:00.000Z',
      url: 'https://volunteer-scheduling-staging.example-account.workers.dev',
      serviceAccountEmail: 'reader@example.test'
    });

    expect(report.variables).toEqual([
      { name: 'STAGING_DEPLOYED_AT', value: '2026-09-29T00:00:00.000Z' },
      { name: 'STAGING_WORKBOOK_ID', value: 'sheet-123' },
      { name: 'STAGING_BRACKET_HOLD_MS', value: '8000' },
      { name: 'STAGING_CONTROL_AUTHORITY', value: 'workbook-control' }
    ]);
    expect(report.execUrl).toBe('https://volunteer-scheduling-staging.example-account.workers.dev/exec');
    expect(report.sanitized).toBe(true);
  });

  it('refuses a variable name that is not staging-scoped', () => {
    const result = run(DEPLOY, ['--plan', '--var', 'PRODUCTION_WRITE_ENABLED:true']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must begin with STAGING_');
    // Nothing was printed as deployable.
    expect(result.stdout).toBe('');
  });

  it('refuses malformed variables, duplicates and the tool-owned bindings', () => {
    for (const [value, fragment] of [
      ['STAGING_NO_COLON', 'is malformed'],
      [':8000', 'the name before the colon is empty'],
      ['STAGING_EMPTY:', 'the value after the colon is empty'],
      ['STAGING_DEPLOYED_AT:now', 'is refused'],
      ['STAGING_WORKBOOK_ID:sheet-1', 'use --workbook']
    ] as const) {
      const result = run(DEPLOY, ['--plan', '--var', value]);
      expect(result.status, value).toBe(1);
      expect(result.stderr, value).toContain(fragment);
    }

    const missing = run(DEPLOY, ['--plan', '--var']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('--var needs a value');

    // Two values for one name would deploy whichever wrangler kept last.
    const duplicate = run(DEPLOY, ['--plan', '--var', 'STAGING_A:1', '--var', 'STAGING_A:2']);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain('was given twice');
  });

  it('keeps --workbook as the single source of the workbook override', () => {
    const result = run(DEPLOY, ['--plan', '--workbook', 'sheet-123']);
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout) as { steps: string[]; workbookOverride: string | null; variables: Array<{ name: string; value: string }> };
    expect(plan.workbookOverride).toBe('sheet-123');
    expect(plan.variables).toContainEqual({ name: 'STAGING_WORKBOOK_ID', value: 'sheet-123' });
    expect(plan.variables.filter((variable) => variable.name === 'STAGING_WORKBOOK_ID')).toHaveLength(1);
    expect(plan.steps[0]).toContain('--var STAGING_WORKBOOK_ID:sheet-123');

    const without = run(DEPLOY, ['--plan']);
    const bare = JSON.parse(without.stdout) as { workbookOverride: string | null; variables: Array<{ name: string; value: string }> };
    expect(bare.workbookOverride).toBeNull();
    expect(bare.variables.some((variable) => variable.name === 'STAGING_WORKBOOK_ID')).toBe(false);
  });
});

describe('staging endpoint verifier', () => {
  it('requires the staging Worker endpoint and refuses any other host', () => {
    expect(run(VERIFY, []).stderr).toContain('must be the staging Worker https endpoint');
    expect(run(VERIFY, ['--url', 'https://example.test/exec']).stderr).toContain('staging-shaped');
    expect(run(VERIFY, ['--url', 'https://volunteer-scheduling.example.workers.dev/exec']).stderr).toContain('staging-shaped');
    expect(run(VERIFY, ['--url', 'http://volunteer-scheduling-staging.example.workers.dev/exec']).stderr).toContain('https');
  });

  it('refuses an unknown argument', () => {
    const result = run(VERIFY, ['--url', 'https://volunteer-scheduling-staging.example.workers.dev/exec', '--token', 'x']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown argument');
  });
});
