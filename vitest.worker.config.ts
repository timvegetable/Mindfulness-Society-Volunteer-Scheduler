import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * Worker-native test run. These tests execute inside workerd — the same runtime
 * the staging Worker uses — so they prove the code does not depend on Node
 * globals and that WebCrypto, `Request`/`Response` and the fetch handler behave
 * as the deployed slice will. The Node suite keeps its own config.
 */
export default defineWorkersConfig({
  test: {
    include: ['src/worker/**/*.test.ts'],
    poolOptions: {
      workers: {
        // Compatibility date and vars come from the pinned Worker configuration,
        // so tests and the deployed slice cannot drift apart.
        wrangler: { configPath: './wrangler.jsonc' }
      }
    }
  }
});
