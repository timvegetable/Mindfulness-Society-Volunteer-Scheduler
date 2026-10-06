import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { connect } from 'node:net';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'log-file': { type: 'string' } } });
const log = values['log-file'] ? createWriteStream(values['log-file'], { flags: 'a', mode: 0o600 }) : undefined;
const children = new Set();
const env = { ...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' };
let stopping = false;
function report(message, error = false) {
  if (error) console.error(message); else console.log(message);
  if (!stopping) log?.write(`${message}\n`);
}
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch (error) { if (error.code !== 'ESRCH') console.error('Could not stop preview process:', error.code); }
  }
  log?.end();
}
function run(args) {
  const child = spawn('npm', args, { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout.on('data', chunk => { process.stdout.write(chunk); if (!stopping) log?.write(chunk); });
  child.stderr.on('data', chunk => { process.stderr.write(chunk); if (!stopping) log?.write(chunk); });
  child.on('error', error => { console.error('Preview process failed:', error.code); stop(1); });
  child.on('close', () => children.delete(child));
  return child;
}
function occupied(port) {
  return new Promise(resolve => {
    const socket = connect({ host: 'localhost', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));
log?.on('error', error => { console.error('Preview log failed:', error.code); stop(1); });

try {
  for (const port of [5173, 8787]) {
    if (await occupied(port)) throw new Error(`Port ${port} is occupied. Stop the existing preview before starting another.`);
  }
  if (stopping) throw new Error('Preview startup interrupted.');
  // Wrangler needs the initial asset directory; no database initialization occurs.
  const build = run(['exec', 'vite', 'build']);
  const code = await new Promise(resolve => build.once('exit', resolve));
  if (code !== 0 || stopping) throw new Error('Initial client build did not finish successfully.');
  const worker = run(['run', 'dev:worker']);
  const client = run(['run', 'dev:client']);
  for (const child of [worker, client]) child.once('exit', code => {
    if (!stopping) { report(`Preview service exited (${code ?? 'signal'}).`); stop(code || 1); }
  });
  const urls = ['http://localhost:5173/', 'http://localhost:8787/client-config'];
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (!stopping && Date.now() < deadline) {
    const checks = await Promise.all(urls.map(async url => {
      try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); return response.ok; }
      catch { return false; }
    }));
    if (checks.every(Boolean)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!stopping && !ready) throw new Error('Preview readiness timed out; inspect client and Worker diagnostics above.');
  if (ready) report('Preview ready: client http://localhost:5173/ and Worker http://localhost:8787/');
} catch (error) {
  if (!stopping) { report(error.message, true); stop(1); }
}
