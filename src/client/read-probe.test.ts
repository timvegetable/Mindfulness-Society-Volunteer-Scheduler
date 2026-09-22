import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('browser read probe', () => {
  it('counts a redirect handoff ending in 404 HTML as a failed attempt', async () => {
    let calls = 0;
    let clock = 0;
    const sandbox: Record<string, unknown> = {
      console: { table: () => undefined },
      performance: { now: () => { clock += 100; return clock; } },
      fetch: async () => {
        calls += 1;
        const handoffFailure = calls === 3;
        return {
          status: handoffFailure ? 404 : 200,
          headers: { get: () => handoffFailure ? 'text/html' : 'application/json' },
          text: async () => handoffFailure ? '<!DOCTYPE html><html><body>Sorry, unable to open the file at this time.</body></html>' : '{"ok":true,"data":{}}'
        };
      }
    };
    runInNewContext(readFileSync('scripts/browser-read-probe.js', 'utf8'), sandbox);
    const probe = sandbox.runReadLatencyProbe as (options: { appsScriptUrl: string; credential: string }) => Promise<{ routes: Record<string, { attempts: Array<{ outcome: string }>; successful: number; failures: number; statsMs: { p95: number } }> }>;
    const report = await probe({ appsScriptUrl: 'https://script.google.com/macros/s/example/exec', credential: 'in-memory-only' });
    expect(report.routes.Schedule?.attempts.some((attempt) => attempt.outcome === 'handoff_404_html')).toBe(true);
    expect(report.routes.Schedule).toMatchObject({ successful: 40, failures: 1 });
    expect(report.routes.Insights).toMatchObject({ successful: 40, failures: 0 });
    expect(calls).toBe(85);
  });

  it('uses signed-in route measurements without reading credentials or responses', async () => {
    let now = 0;
    let scheduleReads = 0;
    const entries: Record<string, Array<{ startTime: number; duration: number }>> = {
      'route-load:schedule': [],
      'route-load:insights': []
    };
    const listeners = new Set<() => void>();
    const status = { textContent: '' };
    const location = { hash: '#schedule' };
    const links = ['#import', '#schedule', '#insights'].map((hash) => ({
      getAttribute: () => hash,
      click: () => {
        location.hash = hash;
        now += 1;
        if (hash === '#schedule' || hash === '#insights') {
          const label = `route-load:${hash.slice(1)}`;
          if (hash === '#schedule') scheduleReads += 1;
          status.textContent = hash === '#schedule' && scheduleReads === 3
            ? 'We could not refresh this section. Showing the last loaded data.' : '';
          entries[label]?.push({ startTime: now, duration: hash === '#schedule' ? 1100 : 1900 });
        }
        for (const listener of [...listeners]) listener();
      }
    }));
    const sandbox: Record<string, unknown> = {
      console: { table: () => undefined },
      location,
      document: {
        querySelectorAll: () => links,
        getElementById: (id: string) => id === 'route-status' ? status : { textContent: '' }
      },
      performance: { now: () => now, getEntriesByName: (name: string) => entries[name] ?? [] },
      addEventListener: (_name: string, listener: () => void) => { listeners.add(listener); },
      removeEventListener: (_name: string, listener: () => void) => { listeners.delete(listener); },
      setTimeout,
      clearTimeout
    };
    runInNewContext(readFileSync('scripts/browser-signed-in-read-probe.js', 'utf8'), sandbox);
    const probe = sandbox.runSignedInReadProbe as () => Promise<{ routes: Record<string, {
      attempts: Array<{ outcome: string }>;
      successful: number;
      failures: number;
      exclusions: number;
      statsMs: { p95: number };
    }> }>;
    const report = await probe();
    expect(report.routes.Schedule).toMatchObject({ successful: 40, failures: 1, exclusions: 2, statsMs: { p95: 1100 } });
    expect(report.routes.Insights).toMatchObject({ successful: 40, failures: 0, exclusions: 2, statsMs: { p95: 1900 } });
    expect(report.routes.Schedule?.attempts.some((attempt) => attempt.outcome === 'refresh_failed')).toBe(true);
  });
});
