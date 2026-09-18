#!/usr/bin/env node
// Builds canonical Volunteer rows from the Google-Form roster export.
//
// Administrator-confirmed policy:
//   * Volunteer.id is a surrogate stable id (`vol-<8 hex>`) derived from the
//     identity, matching the derivation the app itself uses for new joiners
//     (src/server/imports/roster.ts `stableId`). Email is an ordinary attribute,
//     so fixing an address never orphans assignments, availability, or the
//     sign-in link.
//   * Default rank is 1 (primary) and interviewStatus is complete for the whole
//     roster "for now" so the season's scheduling preview can run.
//   * Lifecycle is active for all rows; administrators remove graduated people
//     manually each semester.
// Reviewed corrections live in scrubbed_exports/roster-overrides.csv, and accounts
// that never came through the form live in scrubbed_exports/extra-volunteers.csv.
// Output contains real contact data: NEVER commit migration-output/ (gitignored).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INPUT = `${ROOT}/scrubbed_exports/roster.csv`;
const OVERRIDES_PATH = `${ROOT}/scrubbed_exports/roster-overrides.csv`;
const EXTRA_PATH = `${ROOT}/scrubbed_exports/extra-volunteers.csv`;
const OUT_DIR = `${ROOT}/migration-output`;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const LIFECYCLE = new Set(['active', 'newly-joined', 'inactive', 'graduated']);
const INTERVIEW = new Set(['incomplete', 'complete']);

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

async function readOptionalCsv(path) {
  try {
    return parseCsv(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Mirrors src/server/imports/roster.ts `stableId` so both paths derive one id. */
function stableId(input) {
  let hash = 2166136261;
  for (const character of input) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `vol-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

const now = new Date().toISOString();
const issues = [];
const overrides = [];
const merges = [];
const extras = [];
const volunteers = [];
const seenEmails = new Set();
const seenNames = new Map();

function record(row) {
  const email = collapse(row.email).toLowerCase();
  const name = collapse(row.name);
  if (!EMAIL_PATTERN.test(email)) {
    issues.push({ email, name, type: 'invalid-email' });
    return undefined;
  }
  if (seenEmails.has(email)) {
    issues.push({ email, name, type: 'duplicate-email' });
    return undefined;
  }
  seenEmails.add(email);
  const key = name.toLowerCase();
  if (name && seenNames.has(key)) {
    issues.push({ type: 'duplicate-display-name', name, emails: [seenNames.get(key), email], resolution: 'kept as separate records; use duplicateOf in roster-overrides.csv to merge' });
  } else if (name) seenNames.set(key, email);
  return {
    id: '',
    name,
    email,
    lifecycleStatus: 'active',
    interviewStatus: 'complete',
    readinessRank: 1,
    recurringAvailability: [],
    revision: 0,
    source: collapse(row.source) || 'roster.csv',
    createdAt: now,
    updatedAt: now
  };
}

// ------------------------------------------------------------- form export
for (const row of parseCsv(await readFile(INPUT, 'utf8'))) {
  const volunteer = record({
    email: collapse(row['Email Address']),
    name: `${collapse(row['First Name:'])} ${collapse(row['Last Name:'])}`,
    source: 'roster.csv'
  });
  if (volunteer) volunteers.push(volunteer);
}

// ------------------------------------------- reviewed corrections and merges
for (const [index, row] of (await readOptionalCsv(OVERRIDES_PATH)).entries()) {
  const line = index + 2;
  const email = collapse(row.email).toLowerCase();
  const volunteer = volunteers.find((candidate) => candidate.email === email);
  if (!volunteer) {
    issues.push({ line, email, type: 'unusable-override', reason: 'no roster row has this email' });
    continue;
  }
  const duplicateOf = collapse(row.duplicateOf).toLowerCase();
  if (duplicateOf) {
    const survivor = volunteers.find((candidate) => candidate.email === duplicateOf);
    if (!survivor) {
      issues.push({ line, email, type: 'unusable-merge', reason: `duplicateOf ${duplicateOf} does not match a roster row` });
      continue;
    }
    volunteers.splice(volunteers.indexOf(volunteer), 1);
    seenEmails.delete(email);
    merges.push({ dropped: email, kept: duplicateOf, droppedName: volunteer.name, note: collapse(row.note) });
    continue;
  }
  const name = collapse(row.name);
  const correctedEmail = collapse(row.correctedEmail).toLowerCase();
  if (!name && !correctedEmail) {
    issues.push({ line, email, type: 'unusable-override', reason: 'override needs a name, correctedEmail, or duplicateOf' });
    continue;
  }
  if (correctedEmail && seenEmails.has(correctedEmail)) {
    issues.push({ line, email, type: 'unusable-override', reason: `correctedEmail ${correctedEmail} is already used by another row` });
    continue;
  }
  const change = { email, name: name || undefined, correctedEmail: correctedEmail || undefined, note: collapse(row.note) || undefined };
  if (name) volunteer.name = name;
  if (correctedEmail) {
    change.emailFrom = volunteer.email;
    seenEmails.delete(volunteer.email);
    seenEmails.add(correctedEmail);
    volunteer.email = correctedEmail;
  }
  overrides.push(change);
}

// ------------------------------- accounts that never came through the form
for (const [index, row] of (await readOptionalCsv(EXTRA_PATH)).entries()) {
  const line = index + 2;
  const lifecycleStatus = collapse(row.lifecycleStatus) || 'newly-joined';
  const interviewStatus = collapse(row.interviewStatus) || 'incomplete';
  if (!LIFECYCLE.has(lifecycleStatus) || !INTERVIEW.has(interviewStatus)) {
    issues.push({ line, email: collapse(row.email), type: 'unusable-extra', reason: `lifecycleStatus/interviewStatus must be one of ${[...LIFECYCLE].join('/')} and ${[...INTERVIEW].join('/')}` });
    continue;
  }
  const volunteer = record({ email: collapse(row.email), name: collapse(row.name), source: 'extra-volunteers.csv' });
  if (!volunteer) continue;
  volunteer.lifecycleStatus = lifecycleStatus;
  volunteer.interviewStatus = interviewStatus;
  volunteer.readinessRank = interviewStatus === 'complete' && collapse(row.readinessRank) ? Number(row.readinessRank) : null;
  if (volunteer.lifecycleStatus === 'active' && volunteer.interviewStatus === 'complete' && !volunteer.readinessRank) {
    issues.push({ line, email: volunteer.email, type: 'unusable-extra', reason: 'a complete interview needs a readinessRank of 1, 2, or 3' });
    continue;
  }
  volunteers.push(volunteer);
  extras.push({ email: volunteer.email, name: volunteer.name, lifecycleStatus, interviewStatus, readinessRank: volunteer.readinessRank, note: collapse(row.note) || undefined });
}

// Surrogate ids are generated last so they reflect the reviewed names.
for (const volunteer of volunteers) volunteer.id = stableId(`${volunteer.email}:${volunteer.name}`);
const duplicateIds = volunteers.map((volunteer) => volunteer.id).filter((id, index, all) => all.indexOf(id) !== index);
if (duplicateIds.length > 0) issues.push({ type: 'duplicate-stable-id', ids: [...new Set(duplicateIds)] });
volunteers.sort((left, right) => (left.id < right.id ? -1 : 1));

const KNOWN_TLDS = new Set(['edu', 'com', 'org', 'net', 'gov', 'io']);
const suspiciousDomains = volunteers
  .filter((volunteer) => !KNOWN_TLDS.has(volunteer.email.split('.').at(-1)))
  .map((volunteer) => ({ email: volunteer.email, name: volunteer.name, reason: 'address domain ends in an unusual top-level domain; the volunteer cannot sign in or be matched on it, so confirm the address' }));

const report = {
  tool: 'build-roster',
  volunteerCount: volunteers.length,
  policy: {
    stableId: 'vol-<8 hex> from lowercase email + name (same derivation as the app new-joiner path); email is an editable attribute',
    lifecycleStatus: 'active (administrators remove graduated volunteers manually each semester)',
    interviewStatus: 'complete (temporary: the roster is treated as interview-complete for this season)',
    readinessRank: 1
  },
  merges,
  overrides,
  extras,
  suspiciousDomains,
  blockingIssues: issues.filter((issue) => issue.type !== 'duplicate-display-name'),
  warnings: issues.filter((issue) => issue.type === 'duplicate-display-name' && !issue.emails.some((email) => merges.some((merge) => merge.dropped === email))),
  schedulableNow: volunteers.filter((volunteer) => volunteer.lifecycleStatus === 'active' && volunteer.interviewStatus === 'complete' && volunteer.readinessRank !== null).length,
  schedulableReason: 'active + interviewStatus=complete + numeric rank; each volunteer still needs imported availability before any session can be staffed'
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/volunteers.json`, `${JSON.stringify(volunteers, null, 2)}\n`, { mode: 0o600 });
await writeFile(`${OUT_DIR}/roster-report.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await writeFile(`${OUT_DIR}/volunteer-ids.csv`, `id,email,name\n${volunteers.map((volunteer) => `${volunteer.id},${volunteer.email},"${volunteer.name}"`).join('\n')}\n`, { mode: 0o600 });
await writeFile(`${OUT_DIR}/users-template.csv`, `email,roles,volunteerId,centerIds\n${volunteers.map((volunteer) => `${volunteer.email},volunteer,${volunteer.id},`).join('\n')}\n`, { mode: 0o600 });

console.log(`volunteers=${volunteers.length} blocking=${report.blockingIssues.length} warnings=${report.warnings.length} merges=${merges.length} extras=${extras.length}`);
for (const warning of report.warnings) console.log(`warning: ${warning.type} ${warning.name} (${warning.emails.join(' vs ')})`);
for (const merge of merges) console.log(`merge: dropped ${merge.dropped} in favour of ${merge.kept}${merge.note ? ` (${merge.note})` : ''}`);
for (const override of overrides) {
  const changes = [override.name ? `name -> "${override.name}"` : undefined, override.correctedEmail ? `email ${override.emailFrom} -> ${override.correctedEmail}` : undefined].filter(Boolean).join(', ');
  console.log(`override: ${override.email} ${changes}${override.note ? ` (${override.note})` : ''}`);
}
for (const extra of extras) console.log(`extra: ${extra.email} ${extra.lifecycleStatus}/${extra.interviewStatus} rank=${extra.readinessRank ?? 'none'}`);
for (const suspicious of suspiciousDomains) console.log(`check-email: ${suspicious.email} — ${suspicious.reason}`);
if (report.blockingIssues.length > 0) {
  for (const blocking of report.blockingIssues) console.log(`blocking: ${JSON.stringify(blocking)}`);
  process.exitCode = 1;
}
