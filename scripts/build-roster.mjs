#!/usr/bin/env node
// Builds canonical Volunteer rows from the Google-Form roster export.
// Policy (administrator-confirmed): stable ID = lowercase email; default rank = 1
// (primary); interviewStatus = complete for the whole roster "for now" so the
// season's scheduling preview can run — revise per volunteer as interviews land.
// Lifecycle is active for all rows; administrators remove graduated people manually.
// Output contains real contact data: NEVER commit migration-output/ (gitignored).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INPUT = `${ROOT}/scrubbed_exports/roster.csv`;
const OUT_DIR = `${ROOT}/migration-output`;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function collapse(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function parseCsv(textValue) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const text = textValue.replace(/^﻿/, '');
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
      if (row.some((v) => v.trim())) rows.push(row);
      row = []; cell = '';
    } else cell += ch;
  }
  if (quoted) throw new Error('unterminated CSV quote');
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((v) => v.trim())) rows.push(row);
  }
  const headers = rows[0].map((v) => v.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((h, idx) => [h, values[idx] ?? ''])));
}

const raw = await readFile(INPUT, 'utf8');
const rows = parseCsv(raw);
const now = new Date().toISOString();
const volunteers = [];
const issues = [];
const seenEmails = new Set();
const seenNames = new Map();

rows.forEach((row, index) => {
  const line = index + 2;
  const email = collapse(row['Email Address']).toLowerCase();
  const name = collapse(`${collapse(row['First Name:'])} ${collapse(row['Last Name:'])}`.trim());
  if (!email && !name) return; // trailing blank form rows
  if (!EMAIL_PATTERN.test(email)) {
    issues.push({ line, type: 'invalid-email', email, name });
    return;
  }
  if (seenEmails.has(email)) {
    issues.push({ line, type: 'duplicate-email', email, name });
    return;
  }
  seenEmails.add(email);
  if (name) {
    const key = name.toLowerCase();
    if (seenNames.has(key)) {
      issues.push({ line, type: 'duplicate-display-name', name, emails: [seenNames.get(key), email], resolution: 'kept-as-separate-records-stable-id-is-email' });
    } else seenNames.set(key, email);
  }
  volunteers.push({
    id: email,
    name,
    email,
    lifecycleStatus: 'active',
    interviewStatus: 'complete',
    readinessRank: 1,
    recurringAvailability: [],
    revision: 0,
    source: 'roster.csv',
    createdAt: now,
    updatedAt: now
  });
});

volunteers.sort((a, b) => (a.id < b.id ? -1 : 1));

// Reviewed corrections live in an optional override file so fixes to the form
// export are explicit and reviewable rather than edited into this script.
const overrides = [];
const OVERRIDES_PATH = `${ROOT}/scrubbed_exports/roster-overrides.csv`;
try {
  for (const [index, row] of parseCsv(await readFile(OVERRIDES_PATH, 'utf8')).entries()) {
    const line = index + 2;
    const email = collapse(row.email).toLowerCase();
    const volunteer = volunteers.find((candidate) => candidate.id === email);
    if (!volunteer) {
      issues.push({ line, type: 'unusable-override', email, reason: 'no roster row has this email' });
      continue;
    }
    const name = collapse(row.name);
    const correctedEmail = collapse(row.correctedEmail).toLowerCase();
    if (!name && !correctedEmail) {
      issues.push({ line, type: 'unusable-override', email, reason: 'override has no name or correctedEmail' });
      continue;
    }
    if (correctedEmail && volunteers.some((candidate) => candidate !== volunteer && candidate.id === correctedEmail)) {
      issues.push({ line, type: 'unusable-override', email, reason: `correctedEmail ${correctedEmail} is already used by another roster row` });
      continue;
    }
    const record = { email, name: name || undefined, correctedEmail: correctedEmail || undefined, note: collapse(row.note) || undefined };
    if (name) volunteer.name = name;
    if (correctedEmail) {
      record.idFrom = volunteer.id;
      volunteer.id = correctedEmail;
      volunteer.email = correctedEmail;
    }
    record.idTo = volunteer.id;
    overrides.push(record);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
volunteers.sort((a, b) => (a.id < b.id ? -1 : 1));

const KNOWN_TLDS = new Set(['edu', 'com', 'org', 'net', 'gov', 'io']);
const suspiciousDomains = volunteers
  .filter((volunteer) => !KNOWN_TLDS.has(volunteer.email.split('.').at(-1)))
  .map((volunteer) => ({ email: volunteer.email, name: volunteer.name, reason: 'address domain ends in an unusual top-level domain; the volunteer cannot sign in or be matched on it, so confirm the address' }));

const report = {
  tool: 'build-roster',
  inputRows: rows.length,
  volunteerCount: volunteers.length,
  policy: {
    stableId: 'lowercase-email',
    lifecycleStatus: 'active (administrators remove graduated volunteers manually each semester)',
    interviewStatus: 'complete (temporary: administrators treat the roster as interview-complete for this season)',
    readinessRank: 1
  },
  blockingIssues: issues.filter((i) => i.type !== 'duplicate-display-name' && i.type !== 'unusable-override'),
  warnings: issues.filter((i) => i.type === 'duplicate-display-name'),
  overrides,
  suspiciousDomains,
  schedulableNow: volunteers.length,
  schedulableReason: 'active + interviewStatus=complete + numeric rank; each volunteer still needs imported availability before any session can be staffed'
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/volunteers.json`, `${JSON.stringify(volunteers, null, 2)}\n`, { mode: 0o600 });
await writeFile(`${OUT_DIR}/roster-report.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`volunteers=${volunteers.length} blocking=${report.blockingIssues.length} warnings=${report.warnings.length}`);
for (const w of report.warnings) console.log(`warning: ${w.type} ${w.name} (${w.emails.join(' vs ')})`);
for (const o of overrides) {
  const changes = [
    o.name ? `name -> "${o.name}"` : undefined,
    o.correctedEmail ? `email ${o.idFrom} -> ${o.idTo}` : undefined
  ].filter(Boolean).join(', ');
  console.log(`override: ${o.email} ${changes}${o.note ? ` (${o.note})` : ''}`);
}
for (const s of suspiciousDomains) console.log(`check-email: ${s.email} — ${s.reason}`);
if (report.blockingIssues.length > 0) {
  for (const b of report.blockingIssues) console.log(`blocking: ${JSON.stringify(b)}`);
  process.exitCode = 1;
}
