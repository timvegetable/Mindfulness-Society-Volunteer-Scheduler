// Local Google sign-in capture for staging measurements.
//
// Serves one page on the loopback origin the staging OAuth client already
// allows, takes the Google Identity Services ID token the operator's browser
// produces, sanity-checks that it is a token for the expected audience, and
// writes it to an ignored private path. It never verifies a signature — the
// service under test does that — and it never prints, logs or returns the token.
import { createServer } from 'node:http';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export const DEFAULT_ORIGIN_PORT = 8788;
export const DEFAULT_OUT = 'staging-local/credential-rehearsal.txt';
const MAX_TOKEN_BYTES = 8_192;

export class CredentialCaptureError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'CredentialCaptureError';
    this.status = status;
  }
}

/** The token may only land in ignored private storage. */
export function assertPrivatePath(path) {
  const resolved = resolve(path);
  const privateRoot = resolve('staging-local');
  if (resolved !== privateRoot && !resolved.startsWith(`${privateRoot}${sep}`)) {
    throw new CredentialCaptureError(500, `Refusing to write outside staging-local: ${path}`);
  }
  return resolved;
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Structural and audience check only. Returns the claims worth reporting; it
 * deliberately does not decide whether the token is authentic.
 */
export function inspectIdToken(token, expectedAudience, nowMs = Date.now()) {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (trimmed.length === 0) throw new CredentialCaptureError(400, 'The request carried no token.');
  if (trimmed.length > MAX_TOKEN_BYTES) throw new CredentialCaptureError(400, 'That token is implausibly large.');
  const parts = trimmed.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new CredentialCaptureError(400, 'That is not a three-part ID token.');
  let claims;
  try {
    claims = decodeSegment(parts[1]);
  } catch {
    throw new CredentialCaptureError(400, 'The token payload is not readable JSON.');
  }
  if (!claims || typeof claims !== 'object') throw new CredentialCaptureError(400, 'The token payload is not an object.');
  if (claims.aud !== expectedAudience) throw new CredentialCaptureError(400, 'That token is for a different audience.');
  if (typeof claims.exp !== 'number') throw new CredentialCaptureError(400, 'The token has no expiry.');
  if (claims.exp * 1000 <= nowMs) throw new CredentialCaptureError(400, 'That token has already expired.');
  return {
    audience: claims.aud,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    minutesRemaining: Math.round((claims.exp * 1000 - nowMs) / 60_000),
    hasEmail: typeof claims.email === 'string' && claims.email.length > 0,
    emailVerified: claims.email_verified === true
  };
}

/** The sign-in page: audience only, no secret, no third-party script but GIS. */
export function signInPage(expectedAudience, origin) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Staging sign-in</title>
  <style>body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:38rem;padding:0 1rem}code{background:#f2f2f2;padding:.1rem .3rem}</style>
</head>
<body>
  <h1>Staging credential capture</h1>
  <p>Sign in with a Google account whose email is in the synthetic staging <code>Users</code> tab. The ID token is
  written to ignored private storage on this machine; the page never sends it anywhere else.</p>
  <div id="g_id_button"></div>
  <p id="status" role="status"></p>
  <script src="https://accounts.google.com/gsi/client" async defer></script>
  <script>
    const AUDIENCE = ${JSON.stringify(expectedAudience)};
    function report(message) { document.getElementById('status').textContent = message; }
    function onCredential(response) {
      report('Submitting…');
      fetch('/credential', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: response.credential })
        .then(async (result) => { const body = await result.json(); report(body.message || (result.ok ? 'Captured.' : 'Refused.')); })
        .catch(() => report('The local capture endpoint could not be reached.'));
    }
    window.addEventListener('load', () => {
      if (!window.google || !google.accounts) { report('Google sign-in did not load; check the network and reload.'); return; }
      google.accounts.id.initialize({ client_id: AUDIENCE, callback: onCredential, auto_select: false });
      google.accounts.id.renderButton(document.getElementById('g_id_button'), { theme: 'outline', size: 'large', text: 'signin_with' });
    });
  </script>
  <p style="color:#666">Local origin: <code>${origin}</code>. The token expires about an hour after sign-in.</p>
</body>
</html>`;
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_TOKEN_BYTES) {
        rejectBody(new CredentialCaptureError(413, 'That body is too large to be a token.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => rejectBody(new CredentialCaptureError(400, 'The request could not be read.')));
  });
}

/**
 * Starts the capture server. `onCaptured` receives the summary so a caller can
 * print it; the token itself is written to disk and never returned.
 */
export async function startCredentialCapture(options) {
  const audience = options.audience;
  if (typeof audience !== 'string' || audience.length === 0) throw new Error('An audience (the staging OAuth client id) is required.');
  const out = assertPrivatePath(options.out ?? DEFAULT_OUT);
  const port = options.port ?? DEFAULT_ORIGIN_PORT;
  const origin = `http://localhost:${port}`;
  await mkdir(dirname(out), { recursive: true });

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method === 'GET' && (request.url === '/' || request.url?.startsWith('/?'))) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end(signInPage(audience, origin));
          return;
        }
        if (request.method === 'POST' && request.url === '/credential') {
          const token = await readBody(request);
          const summary = inspectIdToken(token, audience, options.nowMs?.() ?? Date.now());
          await writeFile(out, `${token.trim()}\n`, { mode: 0o600 });
          await chmod(out, 0o600);
          options.onCaptured?.({ ...summary, out });
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          response.end(JSON.stringify({ ok: true, message: `Captured a token for ${summary.audience}, valid for about ${summary.minutesRemaining} minutes. You can close this tab.` }));
          return;
        }
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: false, message: 'Not found.' }));
      } catch (error) {
        const status = error instanceof CredentialCaptureError ? error.status : 500;
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : 'Capture failed.' }));
      }
    })();
  });

  await new Promise((ready) => server.listen(port, '127.0.0.1', ready));
  const bound = server.address();
  const boundPort = bound && typeof bound === 'object' ? bound.port : port;
  return {
    origin: `http://localhost:${boundPort}`,
    out,
    close: () => new Promise((closed) => server.close(() => closed()))
  };
}

function parseArguments(argv) {
  const options = { audience: undefined, out: DEFAULT_OUT, port: DEFAULT_ORIGIN_PORT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${argument} needs a value.`);
      return argv[index];
    };
    if (argument === '--audience') options.audience = next();
    else if (argument === '--out') options.out = next();
    else if (argument === '--port') options.port = Number(next());
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (invokedDirectly) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help || !options.audience) {
    console.log('Usage: node scripts/staging/capture-credential.mjs --audience <staging oauth client id> [--out staging-local/credential-rehearsal.txt] [--port 8788]');
    process.exit(options.help ? 0 : 2);
  }
  const capture = await startCredentialCapture({
    ...options,
    onCaptured: (summary) => {
      // The token is never printed; the summary is what an operator needs.
      console.log(JSON.stringify({ captured: true, audience: summary.audience, expiresAt: summary.expiresAt, minutesRemaining: summary.minutesRemaining, hasEmail: summary.hasEmail, emailVerified: summary.emailVerified, out: summary.out }, null, 2));
    }
  });
  console.log(`Sign in at ${capture.origin}/ (loopback only). The token is written to ${capture.out} with mode 600.`);
}
