import { defineConfig } from '@playwright/test';

const port = Number(process.env.BROWSER_TEST_PORT ?? '5175');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BROWSER_TEST_PORT must be an integer from 1 to 65535.');
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.spec.ts',
  forbidOnly: !!process.env.CI,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'tablet', use: { viewport: { width: 768, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'node scripts/browser-test-server.mjs',
    env: { BROWSER_TEST_PORT: String(port) },
    url: `${baseURL}/__browser-check`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    timeout: 60_000,
  },
});
