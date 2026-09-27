import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployedUrl } from '../../../scripts/staging/deploy-staging.mjs';

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
