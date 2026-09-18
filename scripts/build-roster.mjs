#!/usr/bin/env node
// Builds canonical Volunteer rows from the Google-Form roster export.
// Policy (administrator-confirmed): stable ID = lowercase email; default rank = 1
// (primary); interviews pending so interviewStatus stays incomplete, which keeps
// every row out of scheduling until an administrator flips it to complete.
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
    interviewStatus: 'incomplete',
    readinessRank: 1,
    recurringAvailability: [],
    revision: 0,
    source: 'roster.csv',
    createdAt: now,
    updatedAt: now
  });
});

volunteers.sort((a, b) => (a.id < b.id ? -1 : 1));

const report = {
  tool: 'build-roster',
  inputRows: rows.length,
  volunteerCount: volunteers.length,
  policy: {
    stableId: 'lowercase-email',
    lifecycleStatus: 'active (administrators remove graduated volunteers manually each semester)',
    interviewStatus: 'incomplete (interviews pending; excludes all rows from scheduling)',
    readinessRank: 1
  },
  blockingIssues: issues.filter((i) => i.type !== 'duplicate-display-name'),
  warnings: issues.filter((i) => i.type === 'duplicate-display-name'),
  schedulableNow: 0,
  schedulableReason: 'interviewStatus=incomplete for all rows until administrators complete interviews'
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/volunteers.json`, `${JSON.stringify(volunteers, null, 2)}\n`, { mode: 0o600 });
await writeFile(`${OUT_DIR}/roster-report.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`volunteers=${volunteers.length} blocking=${report.blockingIssues.length} warnings=${report.warnings.length}`);
for (const w of report.warnings) console.log(`warning: ${w.type} ${w.name} (${w.emails.join(' vs ')})`);
if (report.blockingIssues.length > 0) {
  for (const b of report.blockingIssues) console.log(`blocking: ${JSON.stringify(b)}`);
  process.exitCode = 1;
}
