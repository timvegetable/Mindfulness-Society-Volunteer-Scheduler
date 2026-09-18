#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { ConfigError, readJsonFile, validateConfig } from './lib/config.mjs';

const KINDS = new Set(['roster', 'rankings', 'whenisgood', 'sessions', 'schedule-preview']);
const REVIEW_ITEMS = {
  roster: [
    'Review current roster, new joiner, inactive, and graduated counts against the source roster.',
    'Resolve every unmatched or duplicate identity before any administrator import promotion.',
    'Confirm graduated volunteers remain historical records but are excluded from scheduling.'
  ],
  rankings: [
    'Review interview completion and every missing or invalid ranking against the faculty source document.',
    'Confirm Primary and recurring Primary normalize to 1, Secondary to 2, and Tertiary to 3.',
    'Keep incomplete or unranked volunteers out of scheduling until an administrator finalizes them.'
  ],
  whenisgood: [
    'Review participant totals and representative availability intervals against the live WhenIsGood results.',
    'Resolve every unmatched or ambiguous participant through the administrator-managed source mapping.',
    'Promote only a complete staged import; a failed parse must preserve the last successful availability.'
  ],
  sessions: [
    'Review center sessions through December and confirmed UNIV100 classes, including required staffing counts.',
    'Confirm locked session dates, times, centers, and staffing counts are unchanged by migration.',
    'Keep proposed classes outside committed scheduling until eligible coverage is reviewed.'
  ],
  'schedule-preview': [
    'Review assignments and uniquely ordered backups for rank, full-session coverage, and overlap safety.',
    'Review every shortfall and confirm proposed-class exclusions before publishing a schedule revision.',
    'Complete administrator and volunteer browser verification against production configuration without private-data exposure.'
  ]
};

function parseArgs(argv) {
  const result = {};
  const allowed = new Set(['kind', 'input', 'config', 'report']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--') || !allowed.has(arg.slice(2))) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    result[arg.slice(2)] = value;
    index += 1;
  }
  for (const key of ['kind', 'input', 'config', 'report']) {
    if (!result[key]) throw new Error(`--${key} is required`);
  }
  if (!KINDS.has(result.kind)) throw new Error('--kind must be roster, rankings, whenisgood, sessions, or schedule-preview');
  return result;
}

function scrubHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function rowsFor(kind, payload) {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  if (kind === 'whenisgood') return Array.isArray(payload.participants) ? payload.participants : Array.isArray(payload.rows) ? payload.rows : [];
  if (kind === 'schedule-preview') {
    if (Array.isArray(payload.sessions)) return payload.sessions;
    if (Array.isArray(payload.assignments)) return payload.assignments;
  }
  return Array.isArray(payload.rows) ? payload.rows : [];
}

function parseCsv(textValue) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < textValue.length; index += 1) {
    const character = textValue[index];
    if (quoted) {
      if (character === '"' && textValue[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && textValue[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error('unterminated CSV quote');
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0].map((value) => value.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ''])));
}

async function readInput(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error('input path could not be read');
  }
  if (extname(path).toLowerCase() === '.csv') return parseCsv(raw);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('input must be JSON or CSV; raw source parsing is performed by the Apps Script boundary');
  }
}

function normalizedRank(value) {
  if (typeof value === 'number' && [1, 2, 3].includes(value)) return value;
  const valueText = text(value).toLowerCase().replace(/\s+/gu, ' ');
  if (valueText === '1' || valueText === 'primary' || valueText === 'recurring primary') return 1;
  if (valueText === '2' || valueText === 'secondary') return 2;
  if (valueText === '3' || valueText === 'tertiary') return 3;
  return null;
}

function validClock(value) {
  return /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(text(value));
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(text(value));
}

function identityPresent(row) {
  if (!isRecord(row)) return false;
  return Boolean(text(row.id) || text(row.volunteerId) || text(row.email) || text(row.name) || text(row.fullName) || text(row.sourceParticipantId));
}

function countKnown(values, allowed) {
  const result = Object.fromEntries([...allowed].map((key) => [key, 0]));
  result.other = 0;
  for (const value of values) {
    const key = text(value).toLowerCase();
    const canonical = [...allowed].find((entry) => entry.toLowerCase() === key);
    result[canonical ?? 'other'] += 1;
  }
  return result;
}

function sourceRosterIdentity(row) {
  const name = text(row.name || row.fullName) || [text(row['First Name']), text(row['Last Name'])].filter(Boolean).join(' ');
  const email = text(row.email || row.Email);
  return { name, email };
}

function rosterReport(rows) {
  const sourceExport = rows.some((row) => isRecord(row) && ('First Name' in row || 'Last Name' in row) && 'Email' in row);
  if (sourceExport) {
    const invalidRowNumbers = [];
    const validRows = [];
    const seen = new Set();
    let duplicateCount = 0;
    let alternateEmailCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const identity = isRecord(row) ? sourceRosterIdentity(row) : { name: '', email: '' };
      if (!identity.name && !identity.email) {
        invalidRowNumbers.push(index + 2);
        continue;
      }
      const emailParts = identity.email.split(/\s+or\s+/iu).map((value) => text(value)).filter(Boolean);
      if (emailParts.length > 1) alternateEmailCount += 1;
      const key = (emailParts[0] ?? identity.name).toLowerCase();
      if (seen.has(key)) duplicateCount += 1;
      seen.add(key);
      validRows.push(row);
    }
    const missingCanonicalFieldCounts = {
      id: validRows.length,
      lifecycleStatus: validRows.filter((row) => !text(row.lifecycleStatus || row.status)).length,
      interviewStatus: validRows.filter((row) => !text(row.interviewStatus)).length,
      readinessRank: validRows.filter((row) => !text(row.readinessRank || row.rank || row.ranking)).length
    };
    return {
      sourceSchema: 'google-form-roster-export',
      inputRowCount: rows.length,
      validRowCount: validRows.length,
      invalidRowCount: invalidRowNumbers.length,
      invalidRowNumbers,
      identityCandidateCount: validRows.length,
      duplicateIdentityCount: duplicateCount,
      alternateEmailRowCount: alternateEmailCount,
      missingCanonicalFieldCounts,
      lifecycleCounts: countKnown([], new Set(['active', 'newly joined', 'inactive', 'graduated'])),
      reconciliation: { matched: 0, unmatched: validRows.length, ambiguous: duplicateCount },
      preview: { action: 'staged-review-only', productionRowsChanged: 0 }
    };
  }
  const validRows = [];
  const invalidRowNumbers = [];
  const seen = new Set();
  let duplicateCount = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const identity = isRecord(row) ? text(row.id) || text(row.email).toLowerCase() || text(row.name).toLowerCase() : '';
    const status = isRecord(row) ? text(row.lifecycleStatus || row.status).toLowerCase() : '';
    if (!identityPresent(row) || (status && !['active', 'newly joined', 'newly-joined', 'inactive', 'graduated'].includes(status))) {
      invalidRowNumbers.push(index + 2);
      continue;
    }
    if (seen.has(identity)) duplicateCount += 1;
    seen.add(identity);
    validRows.push(row);
  }
  return {
    inputRowCount: rows.length,
    validRowCount: validRows.length,
    invalidRowCount: invalidRowNumbers.length,
    invalidRowNumbers,
    duplicateIdentityCount: duplicateCount,
    lifecycleCounts: countKnown(validRows.map((row) => row.lifecycleStatus || row.status), new Set(['active', 'newly joined', 'inactive', 'graduated'])),
    reconciliation: { matched: validRows.length - duplicateCount, unmatched: invalidRowNumbers.length, ambiguous: duplicateCount },
    preview: { action: 'staged-review-only', productionRowsChanged: 0 }
  };
}


function rankingsReport(rows) {
  const validRows = [];
  const invalidRowNumbers = [];
  let completedCount = 0;
  let missingRankCount = 0;
  const rankCounts = { '1': 0, '2': 0, '3': 0, missing: 0 };
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rank = isRecord(row) ? normalizedRank(row.readinessRank ?? row.rank ?? row.ranking) : null;
    const interview = isRecord(row) ? text(row.interviewStatus || row.status).toLowerCase() : '';
    if (!identityPresent(row)) {
      invalidRowNumbers.push(index + 2);
      continue;
    }
    validRows.push(row);
    if (['complete', 'completed', 'ready', 'final'].includes(interview)) completedCount += 1;
    if (rank === null) {
      missingRankCount += 1;
      rankCounts.missing += 1;
    } else {
      rankCounts[String(rank)] += 1;
    }
  }
  return {
    inputRowCount: rows.length,
    validRowCount: validRows.length,
    invalidRowCount: invalidRowNumbers.length,
    invalidRowNumbers,
    interviewCompletedCount: completedCount,
    missingOrInvalidRankCount: missingRankCount,
    normalizedRankCounts: rankCounts,
    reconciliation: { matched: validRows.length, unmatched: invalidRowNumbers.length, ambiguous: 0 },
    preview: { action: 'normalized-values-review-only', productionRowsChanged: 0 }
  };
}

function whenIsGoodReport(rows, payload) {
  const invalidRowNumbers = [];
  let intervalCount = 0;
  let participantsWithAvailability = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const slots = isRecord(row) ? (Array.isArray(row.availability) ? row.availability : Array.isArray(row.slots) ? row.slots : []) : [];
    if (!identityPresent(row)) invalidRowNumbers.push(index + 1);
    if (slots.length > 0) participantsWithAvailability += 1;
    intervalCount += slots.length;
  }
  const participantIds = rows.map((row) => isRecord(row) ? text(row.sourceParticipantId || row.id || row.email || row.name) : '').filter(Boolean);
  const uniqueParticipantIds = new Set(participantIds);
  const duplicateParticipantCount = participantIds.length - uniqueParticipantIds.size;
  return {
    inputRowCount: rows.length,
    participantCount: rows.length,
    participantsWithAvailability,
    availabilityIntervalCount: intervalCount,
    invalidRowCount: invalidRowNumbers.length,
    invalidRowNumbers,
    duplicateParticipantCount,
    contentHashPrefix: scrubHash(JSON.stringify(payload)),
    sourceTimeZoneConfigured: isRecord(payload) && Boolean(text(payload.timeZone)),
    reconciliation: {
      matched: 0,
      unmatched: rows.length - invalidRowNumbers.length,
      ambiguous: duplicateParticipantCount
    },
    preview: { action: 'staged-availability-review-only', productionRowsChanged: 0 }
  };
}

function sessionsReport(rows) {
  const sourceExport = rows.some((row) => isRecord(row) && ('Center' in row || 'Day & Time (ET)' in row || 'Freq' in row));
  if (sourceExport) {
    const candidateRowNumbers = [];
    const unresolvedRowNumbers = [];
    const missingRequiredStaffCountRowNumbers = [];
    const missingStatusRowNumbers = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const center = isRecord(row) ? text(row.Center || row.centerId || row.center) : '';
      const dayTime = isRecord(row) ? text(row['Day & Time (ET)'] || row.start) : '';
      const dates = isRecord(row) ? text(row.Dates || row.date) : '';
      const candidate = Boolean(center && dayTime && dates && !/^(?:no slot agreed|tbd|—|-)\s*$/iu.test(dayTime) && !/^(?:tbd|—|-)\s*$/iu.test(dates));
      if (!candidate) {
        unresolvedRowNumbers.push(index + 2);
        continue;
      }
      candidateRowNumbers.push(index + 2);
      missingRequiredStaffCountRowNumbers.push(index + 2);
      missingStatusRowNumbers.push(index + 2);
    }
    const staffing = { '0': 0, '1': 0, '2': 0, invalid: candidateRowNumbers.length };
    const kinds = { center: candidateRowNumbers.length, univ100: 0, other: unresolvedRowNumbers.length };
    const statuses = { locked: 0, confirmed: 0, proposed: 0, other: rows.length };
    return {
      sourceSchema: 'center-session-export',
      inputRowCount: rows.length,
      validRowCount: candidateRowNumbers.length,
      invalidRowCount: unresolvedRowNumbers.length,
      invalidRowNumbers: unresolvedRowNumbers,
      candidateRowNumbers,
      unresolvedRowNumbers,
      missingRequiredStaffCountRowNumbers,
      missingStatusRowNumbers,
      kindCounts: kinds,
      statusCounts: statuses,
      requiredStaffCounts: staffing,
      proposedExcludedCount: 0,
      reconciliation: { matched: 0, unmatched: rows.length, ambiguous: 0 },
      preview: { action: 'locked-session-review-only', productionRowsChanged: 0 }
    };
  }
  const invalidRowNumbers = [];
  const validRows = [];
  const staffing = { '0': 0, '1': 0, '2': 0, invalid: 0 };
  const kinds = { center: 0, univ100: 0, other: 0 };
  const statuses = { locked: 0, confirmed: 0, proposed: 0, other: 0 };
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!isRecord(row) || !validDate(row.date) || !validClock(row.start) || !validClock(row.end) || row.end <= row.start) {
      invalidRowNumbers.push(index + 2);
      continue;
    }
    const kindText = text(row.kind || row.type).toLowerCase();
    const kind = kindText === 'center' ? 'center' : kindText === 'univ100' || kindText === 'univ 100' ? 'univ100' : 'other';
    const statusText = text(row.status).toLowerCase();
    const status = ['locked', 'confirmed', 'proposed'].includes(statusText) ? statusText : 'other';
    const required = Number(row.requiredStaffCount ?? row.staffingCount);
    if (!Number.isInteger(required) || required < 0 || required > 2) {
      staffing.invalid += 1;
    } else {
      staffing[String(required)] += 1;
    }
    kinds[kind] += 1;
    statuses[status] += 1;
    validRows.push(row);
  }
  return {
    inputRowCount: rows.length,
    validRowCount: validRows.length,
    invalidRowCount: invalidRowNumbers.length,
    invalidRowNumbers,
    kindCounts: kinds,
    statusCounts: statuses,
    requiredStaffCounts: staffing,
    proposedExcludedCount: validRows.filter((row) => text(row.status).toLowerCase() === 'proposed').length,
    reconciliation: { matched: validRows.length, unmatched: invalidRowNumbers.length, ambiguous: 0 },
    preview: { action: 'locked-session-review-only', productionRowsChanged: 0 }
  };
}

function schedulePreviewReport(payload, rows) {
  const object = isRecord(payload) ? payload : {};
  const assignments = Array.isArray(object.assignments) ? object.assignments : [];
  const backups = Array.isArray(object.backups) ? object.backups : [];
  const shortfalls = Array.isArray(object.shortfalls) ? object.shortfalls : [];
  const sessions = Array.isArray(object.sessions) ? object.sessions : rows;
  const proposed = sessions.filter((row) => isRecord(row) && text(row.status).toLowerCase() === 'proposed').length;
  const assignedVolunteerKeys = assignments.map((row) => isRecord(row) ? text(row.volunteerId || row.id) : '').filter(Boolean);
  const duplicateAssignmentKeys = assignedVolunteerKeys.length - new Set(assignedVolunteerKeys).size;
  return {
    inputRowCount: rows.length,
    sessionCount: sessions.length,
    assignmentCount: assignments.length,
    backupCount: backups.length,
    shortfallCount: shortfalls.length,
    proposedClassExclusionCount: proposed,
    duplicateAssignmentKeyCount: duplicateAssignmentKeys,
    requiredStaffingExceededCount: assignments.filter((row) => isRecord(row) && Number(row.requiredStaffCount) > 2).length,
    reconciliation: { matched: sessions.length, unmatched: shortfalls.length, ambiguous: duplicateAssignmentKeys },
    preview: {
      action: 'administrator-schedule-review-only',
      productionRowsChanged: 0,
      publishedRevision: false
    }
  };
}

function reportFor(kind, payload) {
  const rows = rowsFor(kind, payload);
  if (!Array.isArray(rows)) throw new Error('input does not contain an array of rows');
  const details = kind === 'roster' ? rosterReport(rows) : kind === 'rankings' ? rankingsReport(rows) :
    kind === 'whenisgood' ? whenIsGoodReport(rows, payload) : kind === 'sessions' ? sessionsReport(rows) : schedulePreviewReport(payload, rows);
  return { rows, details };
}

async function saveReport(path, report) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function baseReport(kind) {
  return {
    tool: 'migrate',
    kind,
    status: 'blocked',
    mode: 'preview-only',
    productionMutation: 'none',
    writeEnabledRequiredForPromotion: true,
    administratorReview: REVIEW_ITEMS[kind],
    diagnostics: []
  };
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error('Usage: node scripts/migrate.mjs --kind KIND --input PATH --config PRIVATE_CONFIG_PATH --report REPORT_PATH');
  console.error(error.message);
  process.exit(2);
}

const report = baseReport(args.kind);
try {
  const config = await readJsonFile(args.config);
  const configResult = validateConfig(config);
  report.configurationValid = configResult.valid;
  report.writeDisabled = config.writeEnabled === false;
  if (!configResult.valid) {
    report.diagnostics.push('private configuration failed validation');
    report.configurationIssueCount = configResult.issues.length;
  } else if (config.writeEnabled !== false) {
    report.diagnostics.push('migration and preview commands require writeEnabled=false; no production write path exists in this tool');
  } else {
    const payload = await readInput(args.input);
    const result = reportFor(args.kind, payload);
    report.status = result.details.invalidRowCount > 0 || result.details.reconciliation.unmatched > 0 || result.details.reconciliation.ambiguous > 0 ? 'needs-review' : 'ready-for-review';
    report.summary = result.details;
    report.inputFormat = extname(args.input).toLowerCase() === '.csv' ? 'csv' : 'json';
    report.diagnostics.push('This command only creates a scrubbed report. An administrator must review it and perform any staged promotion through the protected Apps Script workflow.');
  }
} catch (error) {
  report.diagnostics.push(error instanceof ConfigError ? 'configuration could not be loaded' : error.message || 'input could not be processed');
}

await saveReport(args.report, report);
console.log(`Wrote scrubbed ${args.kind} migration report (${report.status}).`);
if (report.status === 'blocked') process.exitCode = 1;
