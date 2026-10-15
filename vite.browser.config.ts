import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig, type Connect } from 'vite';
import base from './vite.config.ts';

const routes: Record<string, string> = {
  '/__browser-check': '/test/browser/workspace.html',
  '/__role-check': '/test/browser/role-workspace.html',
};
function installRoutes(server: { middlewares: Connect.Server }) {
  server.middlewares.use((request, _response, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const entry = routes[url.pathname];
    if (entry) request.url = entry + url.search;
    next();
  });
}

// Synthetic entries are selected only by this opt-in configuration.
export default mergeConfig(base, defineConfig({
  appType: 'mpa',
  server: { port: 5174, strictPort: true },
  build: {
    outDir: 'dist/browser-test',
    rolldownOptions: { input: Object.values(routes).map(path => fileURLToPath(new URL(`.${path}`, import.meta.url))) },
  },
  plugins: [{
    name: 'synthetic-browser-workspace',
    configureServer: installRoutes,
    configurePreviewServer: installRoutes,
  }],
}));
