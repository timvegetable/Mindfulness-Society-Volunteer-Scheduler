import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run locally with a downloaded Desktop OAuth client. Never sends email.
const root = fileURLToPath(new URL('../', import.meta.url));
const [credentialsPath, sender] = process.argv.slice(2);
if (!credentialsPath || !sender || !/^[^\s<>@,;]+@gmail\.com$/i.test(sender)) {
  console.error('Usage: node scripts/authorize-gmail.mjs /path/to/downloaded-client.json sender@gmail.com');
  process.exit(1);
}

async function authorize() {
  let downloaded;
  try { downloaded = JSON.parse(await readFile(credentialsPath, 'utf8')); }
  catch { throw new Error('Could not read the downloaded OAuth client JSON. Check the local file path and format.'); }
  const credentials = downloaded?.installed;
  if (!credentials?.client_id || !credentials?.client_secret) throw new Error('Expected a downloaded Desktop app OAuth client JSON.');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let redirect;
  let claimed = false;
  let resolveCode, rejectCode;
  const codeReceived = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = createServer((request, response) => {
    const url = new URL(request.url, redirect);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (request.method !== 'GET' || url.pathname !== '/' || url.searchParams.get('state') !== state || claimed) {
      response.writeHead(400); response.end('Invalid authorization callback.'); return;
    }
    claimed = true;
    if (url.searchParams.has('error') || !url.searchParams.get('code')) {
      response.end('Authorization declined. Return to the terminal.');
      rejectCode(new Error('Authorization declined.')); return;
    }
    response.end('Authorization received. Return to the terminal to check completion.');
    resolveCode(url.searchParams.get('code'));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  redirect = `http://127.0.0.1:${server.address().port}/`;
  const timeout = setTimeout(() => rejectCode(new Error('Authorization timed out after ten minutes. Run again.')), 10 * 60 * 1000);
  try {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: credentials.client_id, redirect_uri: redirect,
      response_type: 'code', scope: 'https://www.googleapis.com/auth/gmail.send',
      access_type: 'offline', prompt: 'consent', login_hint: sender, state,
      code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    console.log('Opening Google in your browser. Authorize the Gmail sender account.');
    console.log(`If the browser does not open, visit:\n${url}`);
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(opener, [url.toString()], { stdio: 'ignore' });
    child.on('error', () => {});
    const code = await codeReceived;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({ client_id: credentials.client_id, client_secret: credentials.client_secret,
        code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' }),
    });
    if (!response.ok) throw new Error(`Google token exchange failed (HTTP ${response.status}); no credentials saved.`);
    let tokens;
    try { tokens = await response.json(); }
    catch { throw new Error('Google returned an invalid token response; no credentials saved.'); }
    if (typeof tokens?.refresh_token !== 'string' || !tokens.refresh_token || typeof tokens.scope !== 'string'
      || !tokens.scope.split(' ').includes('https://www.googleapis.com/auth/gmail.send')) {
      throw new Error('Google did not grant offline send access; no credentials saved.');
    }
    const secretsPath = `${root}gmail-secrets.production.local.json`;
    const secrets = { GMAIL_CLIENT_ID: credentials.client_id, GMAIL_CLIENT_SECRET: credentials.client_secret,
      GMAIL_REFRESH_TOKEN: tokens.refresh_token };
    await writeFile(secretsPath, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
    await chmod(secretsPath, 0o600);
    const configPath = `${root}wrangler.production.local.json`;
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.vars.EMAIL_PROVIDER = 'gmail';
    config.vars.EMAIL_FROM = sender;
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await chmod(configPath, 0o600);
    console.log('Saved Gmail credentials locally with owner-only permissions and configured the sender.');
    console.log('No email sent, Worker deployed, or Cloudflare secrets uploaded.');
  } finally {
    clearTimeout(timeout);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

try { await authorize(); }
catch (error) { console.error(error instanceof Error ? error.message : 'Gmail setup failed.'); process.exitCode = 1; }
