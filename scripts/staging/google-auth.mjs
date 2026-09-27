// Service-account access tokens for the staging scripts.
//
// The Worker has its own implementation; this one exists so the fixture loader
// and the verifier can run from the command line without adding a Google client
// library. It is the same JWT-bearer flow, built with `node:crypto`, and it never
// prints the key, the assertion or the token.
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function base64Url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Reads a service-account JSON key and returns only what the flow needs. */
export async function readServiceAccountKey(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`The service-account key could not be read at ${path}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The service-account key at ${path} is not valid JSON.`);
  }
  if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
    throw new Error(`The service-account key at ${path} has no client_email or private_key.`);
  }
  return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
}

/** Exchanges a signed assertion for an access token. */
export async function accessTokenFor(keyPath, scope = SHEETS_SCOPE, nowMs = () => Date.now()) {
  const { clientEmail, privateKey } = await readServiceAccountKey(keyPath);
  const issuedAt = Math.floor(nowMs() / 1000);
  const signingInput = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
    iss: clientEmail,
    scope,
    aud: TOKEN_ENDPOINT,
    iat: issuedAt,
    exp: issuedAt + 3600
  }))}`;
  let assertion;
  try {
    assertion = `${signingInput}.${base64Url(createSign('RSA-SHA256').update(signingInput).sign(privateKey))}`;
  } catch {
    throw new Error('The service-account private key could not sign the assertion.');
  }
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString()
  });
  if (!response.ok) {
    // The body is dropped: it can echo request material, and the status classifies it.
    throw new Error(`The Google token exchange failed with status ${response.status}.`);
  }
  const payload = await response.json().catch(() => undefined);
  if (!payload || typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new Error('Google returned no access token.');
  }
  return payload.access_token;
}

export { SHEETS_SCOPE, TOKEN_ENDPOINT };
