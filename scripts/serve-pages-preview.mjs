#!/usr/bin/env node
// Local stand-in for a GitHub Pages project site: serves dist/client under a path
// prefix so anything fetched from a root-absolute path 404s exactly as it does on
// https://<user>.github.io/<repo>/.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../dist/client/', import.meta.url).pathname;
const PREFIX = '/Mindfulness-Society-Volunteer-Scheduler';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith(`${PREFIX}/`) && url.pathname !== PREFIX) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found\n');
    return;
  }
  const relative = url.pathname.slice(PREFIX.length).replace(/^\/+/, '') || 'index.html';
  const file = join(ROOT, normalize(relative).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found\n');
  }
}).listen(8788, '127.0.0.1', () => console.log(`serving dist/client at http://127.0.0.1:8788${PREFIX}/`));
