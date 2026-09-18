#!/usr/bin/env node
// Builds Users rows (the authorization source) from scrubbed_exports/users.csv.
//
// Authorization is by email, but the record link uses the surrogate volunteer id,
// so a volunteer's Users row survives any change to the address they sign in with.
// The `role`/`roles` column accepts comma-separated or | separated values and the
// shorthand `admin` for `administrator`. Resolved volunteer ids come from
// migration-output/volunteer-ids.csv and centers from migration-output/centers.json.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INPUT = `${ROOT}/scrubbed_exports/users.csv`;
const OUT_DIR = `${ROOT}/migration-output`;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const ROLES = new Set(['volunteer', 'administrator', 'center-contact']);
const ALIASES = { admin: 'administrator', administrators: 'administrator', 'center contact': 'center-contact', 'center_contact': 'center-contact' };

const collapse = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();

function parseCsv(textValue) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const text = textValue.replace(/^\uFEFF/u, '');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.length === 0) quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = []; cell = '';
    } else cell += ch;
  }
  if (quoted) throw new Error('unterminated CSV quote');
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  const headers = rows[0].map((value) => value.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

const list = (value) => collapse(value).split(/[,|]/u).map((item) => item.trim()).filter(Boolean);

const idRows = parseCsv(await readFile(`${OUT_DIR}/volunteer-ids.csv`, 'utf8'));
const volunteersByEmail = new Map(idRows.map((row) => [collapse(row.email).toLowerCase(), { id: collapse(row.id), name: collapse(row.name) }]));
const centers = JSON.parse(await readFile(`${OUT_DIR}/centers.json`, 'utf8'));
const centerIds = new Set(centers.map((center) => center.id));

const issues = [];
const users = [];
const seen = new Set();
for (const [index, row] of parseCsv(await readFile(INPUT, 'utf8')).entries()) {
  const line = index + 2;
  const email = collapse(row.email).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    issues.push({ line, email, type: 'invalid-email' });
    continue;
  }
  if (seen.has(email)) {
    issues.push({ line, email, type: 'duplicate-user' });
    continue;
  }
  const roles = list(row.roles ?? row.role).map((role) => ALIASES[role.toLowerCase()] ?? role.toLowerCase());
  const unknown = roles.filter((role) => !ROLES.has(role));
  if (roles.length === 0 || unknown.length > 0) {
    issues.push({ line, email, type: 'invalid-roles', roles, reason: unknown.length > 0 ? `unknown role(s): ${unknown.join(', ')}` : 'no roles given' });
    continue;
  }
  const requestedCenterIds = list(row.centerIds ?? row.centers);
  const missingCenters = requestedCenterIds.filter((centerId) => !centerIds.has(centerId));
  if (missingCenters.length > 0) {
    issues.push({ line, email, type: 'invalid-centers', centers: missingCenters, reason: 'centerIds must reference an active center id from centers.json' });
    continue;
  }
  let volunteerId = collapse(row.volunteerId);
  const volunteerEmail = collapse(row.volunteerEmail).toLowerCase();
  if (!volunteerId && volunteerEmail) volunteerId = volunteersByEmail.get(volunteerEmail)?.id ?? '';
  if (!volunteerId && roles.includes('volunteer')) volunteerId = volunteersByEmail.get(email)?.id ?? '';
  if (volunteerId && !idRows.some((candidate) => collapse(candidate.id) === volunteerId)) {
    issues.push({ line, email, type: 'unknown-volunteer-id', volunteerId, reason: 'volunteerId does not match any migrated volunteer' });
    continue;
  }
  if (roles.includes('volunteer') && !volunteerId) {
    issues.push({ line, email, type: 'unlinked-volunteer', reason: 'a volunteer user needs volunteerId (or must match a migrated volunteer email) or its dashboard will be rejected' });
    continue;
  }
  seen.add(email);
  const user = { id: email, email, roles: [...new Set(roles)], active: collapse(row.active).toLowerCase() !== 'false', revision: 0 };
  if (volunteerId) user.volunteerId = volunteerId;
  if (requestedCenterIds.length > 0) user.centerIds = requestedCenterIds;
  users.push(user);
}

const report = {
  tool: 'build-users',
  inputRows: users.length + issues.length,
  userCount: users.length,
  users: users.map((user) => ({ email: user.email, roles: user.roles, volunteerId: user.volunteerId ?? null, centerIds: user.centerIds ?? [] })),
  issues
};
await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/users.json`, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 });
await writeFile(`${OUT_DIR}/users-report.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

console.log(`users=${users.length} issues=${issues.length}`);
for (const user of users) console.log(`  ${user.email} roles=${user.roles.join('+')} volunteerId=${user.volunteerId ?? '-'} centers=${(user.centerIds ?? []).join(',') || '-'}`);
for (const issue of issues) console.log(`issue: ${JSON.stringify(issue)}`);
if (issues.length > 0) process.exitCode = 1;
