/* Paste into DevTools on the signed-in deployed client and call
   runSignedInReadProbe(). It navigates the existing app and reads only its
   route-load performance entries and generic refresh status. */
(() => {
  const routes = [
    { name: 'Schedule', hash: '#schedule', label: 'route-load:schedule' },
    { name: 'Insights', hash: '#insights', label: 'route-load:insights' }
  ];
  const percentile = (sorted, p) => sorted[Math.ceil(sorted.length * p) - 1];
  const summarize = (samples) => {
    const sorted = [...samples].sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return {
      min: sorted[0],
      median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
      p95: percentile(sorted, 0.95),
      max: sorted.at(-1)
    };
  };
  const linkFor = (hash) => [...document.querySelectorAll('a[href]')]
    .find((link) => link.getAttribute('href') === hash);
  async function navigate(hash) {
    if (location.hash === hash) return;
    const link = linkFor(hash);
    if (!link) throw new Error(`The ${hash} navigation link is unavailable.`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        removeEventListener('hashchange', changed);
        reject(new Error(`Navigation to ${hash} did not complete.`));
      }, 5000);
      function changed() {
        clearTimeout(timeout);
        resolve();
      }
      addEventListener('hashchange', changed, { once: true });
      link.click();
    });
  }
  async function readOnce(route, warmup) {
    // Import has no automatic service read. Visiting it ensures that clicking
    // the same measured route again still starts a fresh request.
    await navigate('#import');
    const started = performance.now();
    await navigate(route.hash);
    const status = document.getElementById('route-status');
    const app = document.getElementById('app');
    const deadline = performance.now() + 90000;
    let entry;
    let outcome;
    while (performance.now() < deadline) {
      entry = performance.getEntriesByName(route.label, 'measure')
        .findLast((candidate) => candidate.startTime >= started);
      if (entry) {
        const message = status?.textContent?.trim() ?? '';
        if (!message) { outcome = 'success'; break; }
        if (message.startsWith('We could not') || app?.textContent?.includes('We could not load this section.')) {
          outcome = 'refresh_failed';
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      probeId: `signed-in-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      durationMs: entry ? Math.round(entry.duration) : Math.round(performance.now() - started),
      outcome: outcome ?? 'timeout',
      warmup
    };
  }
  async function runSignedInReadProbe({ samples = 40, warmups = 2 } = {}) {
    if (!Number.isInteger(samples) || samples < 40 || warmups !== 2) {
      throw new Error('Use at least 40 successful samples and two warm-ups.');
    }
    if (!linkFor('#import') || routes.some((route) => !linkFor(route.hash))) {
      throw new Error('Sign in as an administrator and open Schedule or Insights first.');
    }
    const report = {
      measuredAt: new Date().toISOString(),
      source: 'deployed-client-route-load-performance',
      targetMs: 2000,
      warmups,
      routes: Object.fromEntries(routes.map((route) => [route.name, { attempts: [] }]))
    };
    for (let index = -warmups; index < samples * 3; index += 1) {
      for (const route of routes) {
        const attempts = report.routes[route.name].attempts;
        const successes = attempts.filter((attempt) => !attempt.warmup && attempt.outcome === 'success').length;
        if (index >= 0 && successes >= samples) continue;
        attempts.push(await readOnce(route, index < 0));
      }
      if (routes.every((route) => report.routes[route.name].attempts
        .filter((attempt) => !attempt.warmup && attempt.outcome === 'success').length >= samples)) break;
    }
    for (const route of routes) {
      const result = report.routes[route.name];
      const eligible = result.attempts.filter((attempt) => !attempt.warmup && attempt.outcome === 'success')
        .map((attempt) => attempt.durationMs);
      result.successful = eligible.length;
      result.failures = result.attempts.filter((attempt) => !attempt.warmup && attempt.outcome !== 'success').length;
      result.exclusions = result.attempts.filter((attempt) => attempt.warmup).length;
      result.statsMs = summarize(eligible);
      result.passes = eligible.length >= samples && result.statsMs.p95 <= 2000;
    }
    console.table(Object.fromEntries(routes.map((route) => {
      const result = report.routes[route.name];
      return [route.name, {
        attempts: result.attempts.length,
        successful: result.successful,
        failures: result.failures,
        minMs: result.statsMs?.min,
        medianMs: result.statsMs?.median,
        p95Ms: result.statsMs?.p95,
        maxMs: result.statsMs?.max,
        passes: result.passes
      }];
    })));
    return report;
  }
  globalThis.runSignedInReadProbe = runSignedInReadProbe;
})();
