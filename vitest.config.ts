import { defineConfig } from 'vitest/config';

/**
 * Node-side suite. Worker tests run in the Workers runtime instead — see
 * `vitest.worker.config.ts` and `npm run test:worker` — because they must prove
 * the code works without Node globals.
 */
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], exclude: ['**/node_modules/**', 'src/worker/**'] }
});
