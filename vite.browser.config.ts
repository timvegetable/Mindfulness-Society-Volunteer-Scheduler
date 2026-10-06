import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.ts';

// This entry exists only in the explicitly selected development server.
export default mergeConfig(base, defineConfig({
  server: { port: 5174, strictPort: true },
  plugins: [{
    name: 'synthetic-browser-workspace',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__browser-check', async (_request, response, next) => {
        try {
          const html = await server.transformIndexHtml('/__browser-check', `<!doctype html>
            <html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Synthetic browser check</title></head>
            <body><aside id="browser-check"></aside><div id="app"></div><script type="module" src="/test/browser/workspace.ts"></script></body></html>`);
          response.setHeader('Content-Type', 'text/html');
          response.end(html);
        } catch (error) { next(error); }
      });
    },
  }],
}));
