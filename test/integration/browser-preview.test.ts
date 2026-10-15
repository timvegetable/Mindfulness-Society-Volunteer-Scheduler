import { expect, it } from 'vitest';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

it('serves executable module entries through both friendly interactive preview routes', async () => {
  const server = await createServer({
    configFile: fileURLToPath(new URL('../../vite.browser.config.ts', import.meta.url)),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, open: false },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic preview did not bind a TCP port.');
    for (const path of ['/__browser-check', '/__role-check']) {
      const url = `http://127.0.0.1:${address.port}${path}`;
      const response = await fetch(url);
      expect(response.ok).toBe(true);
      const html = await response.text();
      const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]!);
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) {
        const module = await fetch(new URL(script, url));
        expect(module.status, script).toBe(200);
        expect(module.headers.get('content-type'), script).toMatch(/javascript/);
        await module.body?.cancel();
      }
    }
  } finally { await server.close(); }
});
