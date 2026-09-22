/* Paste this file into DevTools on the deployed client, then call
   runReadLatencyProbe({ appsScriptUrl, credential }). The credential lives only
   in this invocation and is never printed or written to storage. */
(() => {
  const routes = [
    ['Schedule', 'admin.schedule.read'],
    ['Insights', 'admin.insights.read']
  ];
  const percentile = (sorted, p) => sorted[Math.ceil(sorted.length * p) - 1];
  const summarize = (samples) => {
    const sorted = [...samples].sort((a, b) => a - b);
    if (!sorted.length) return null;
    return { min: sorted[0], median: sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2, p95: percentile(sorted, 0.95), max: sorted.at(-1) };
  };
  const outcome = (status, contentType, body) => {
    if (status === 404 && /html/i.test(contentType) && /<html|<!doctype/i.test(body)) return 'handoff_404_html';
    if (/html/i.test(contentType) || /<html|<!doctype/i.test(body)) return 'upstream_html';
    let parsed;
    try { parsed = JSON.parse(body); } catch { return 'invalid_json'; }
    if (parsed?.ok === true && 'data' in parsed) return 'success';
    if (parsed?.ok === false) return `api_${String(parsed.error?.code ?? 'error').replace(/[^a-zA-Z0-9_]/g, '')}`;
    return 'invalid_envelope';
  };
  async function runReadLatencyProbe({ appsScriptUrl, credential, samples = 40, warmups = 2 }) {
    if (typeof appsScriptUrl !== 'string' || !/^https:\/\//.test(appsScriptUrl) || typeof credential !== 'string' || !credential || !Number.isInteger(samples) || samples < 40 || warmups !== 2) throw new Error('Provide an HTTPS URL, an in-memory credential, at least 40 samples, and two warm-ups.');
    const report = { measuredAt: new Date().toISOString(), warmups, targetMs: 2000, routes: {} };
    for (const [route, operation] of routes) {
      const attempts = [];
      let successful = 0;
      for (let index = -warmups; successful < samples && index < samples * 3; index += 1) {
        const probeId = `read-probe-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
        const start = performance.now();
        let classification;
        try {
          const response = await fetch(appsScriptUrl, {
            method: 'POST', credentials: 'omit', redirect: 'follow',
            headers: { 'Content-Type': 'text/plain;charset=utf-8', Accept: 'application/json' },
            body: JSON.stringify({ operation, payload: {}, idempotencyKey: probeId, credential })
          });
          // Read only to classify the response. Neither body nor redirect URL is retained.
          classification = outcome(response.status, response.headers.get('content-type') ?? '', await response.text());
        } catch { classification = 'network_error'; }
        attempts.push({ probeId, durationMs: Math.round(performance.now() - start), outcome: classification, warmup: index < 0 });
        if (index >= 0 && classification === 'success') successful += 1;
      }
      const eligible = attempts.filter((attempt) => !attempt.warmup && attempt.outcome === 'success').map((attempt) => attempt.durationMs);
      const failures = attempts.filter((attempt) => !attempt.warmup && attempt.outcome !== 'success');
      report.routes[route] = { attempts, successful: eligible.length, failures: failures.length, exclusions: warmups, statsMs: summarize(eligible), passes: eligible.length >= 40 && summarize(eligible).p95 <= 2000 };
    }
    console.table(Object.fromEntries(Object.entries(report.routes).map(([route, value]) => [route, { attempts: value.attempts.length, successful: value.successful, failures: value.failures, p95Ms: value.statsMs?.p95, passes: value.passes }])));
    return report;
  }
  globalThis.runReadLatencyProbe = runReadLatencyProbe;
})();
