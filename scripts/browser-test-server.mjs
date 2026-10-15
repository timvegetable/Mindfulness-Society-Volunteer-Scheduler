import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, preview } from 'vite';

// Playwright supplies its validated port; this process never takes over the interactive preview.
if (!process.env.BROWSER_TEST_PORT) throw new Error('Start this server with npm run test:browser.');
const port = Number(process.env.BROWSER_TEST_PORT);
const directory = await mkdtemp(join(tmpdir(), 'scheduler-browser-test-'));
// Vite also handles shutdown signals; synchronous exit cleanup runs whichever handler exits first.
process.on('exit', () => { rmSync(directory, { recursive: true, force: true }); });
let server;
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  if (server) {
    server.httpServer.closeAllConnections();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
  process.exit(code);
}
process.on('SIGTERM', () => { void stop(0); });
process.on('SIGINT', () => { void stop(130); });

try {
  const config = { configFile: 'vite.browser.config.ts', build: { outDir: directory, emptyOutDir: true } };
  await build(config);
  server = await preview({ ...config, preview: { host: '127.0.0.1', port, strictPort: true } });
  console.log(`Browser test preview ready: http://127.0.0.1:${port}/__browser-check (fixed build)`);
} catch (error) {
  console.error(error);
  await stop(1);
}
