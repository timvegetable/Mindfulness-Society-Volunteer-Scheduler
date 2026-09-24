import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

describe('Apps Script deployment report', () => {
  it('reports a push-only execution without claiming the pinned deployment changed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'apps-script-push-only-'));
    try {
      const dist = join(workspace, 'dist', 'apps-script');
      const bin = join(workspace, 'bin');
      const configPath = join(workspace, 'private-config.json');
      const reportPath = join(workspace, 'report.json');
      const claspLogPath = join(workspace, 'clasp-calls.log');
      await mkdir(dist, { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeFile(join(workspace, '.clasp.json'), JSON.stringify({ rootDir: 'dist/apps-script' }));
      await writeFile(join(dist, 'appsscript.json'), '{}');
      await writeFile(join(dist, 'Code.js'), '// test bundle');
      await writeFile(configPath, JSON.stringify({
        environment: 'production',
        timeZone: 'America/New_York',
        displayIncrementMinutes: 15,
        operatingHours: { start: '09:00', end: '17:00' },
        administratorRecipients: ['admin@example.org'],
        oauthAudience: 'test-oauth-client-123',
        appsScriptUrl: 'https://script.google.com/macros/s/test-deployment/exec',
        sheetId: 'A'.repeat(25),
        sheetOwnerEmail: 'owner@example.org',
        writeEnabled: false
      }));

      const claspPath = join(bin, 'clasp');
      await writeFile(claspPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$CLASP_CALL_LOG"
if [ "$1" = push ]; then printf 'Pushed 2 files.\\n'; else exit 1; fi
`);
      await chmod(claspPath, 0o755);

      const scriptPath = resolve(process.cwd(), 'scripts/deploy-apps-script.mjs');
      const result = spawnSync(process.execPath, [
        scriptPath,
        '--config', configPath,
        '--server-dist', 'dist/apps-script',
        '--report', reportPath,
        '--execute',
        '--confirm',
        'DEPLOY_APPS_SCRIPT_WITH_WRITES_DISABLED'
      ], {
        cwd: workspace,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          CLASP_CALL_LOG: claspLogPath
        }
      });

      if (result.status !== 0) {
        throw new Error(`deployment script exited ${String(result.status)}\n${result.stdout}\n${result.stderr}\n${await readFile(reportPath, 'utf8').catch(() => '')}`);
      }
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
        status: string;
        productionMutation: string;
        checks: { claspPushSucceeded?: boolean; deploymentUpdated?: boolean };
      };
      expect(report.status).toBe('pushed-only-write-disabled');
      expect(report.productionMutation).toContain('source pushed');
      expect(report.productionMutation).toContain('no pinned deployment was updated');
      expect(report.checks.claspPushSucceeded).toBe(true);
      expect(report.checks.deploymentUpdated).toBeUndefined();
      expect(await readFile(claspLogPath, 'utf8')).toBe('push --force\n');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
