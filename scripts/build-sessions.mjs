#!/usr/bin/env node
// Expands scrubbed_exports/sessions.csv (recurring center descriptions) into
// occurrence-level Sessions rows and reports every field that cannot be derived
// from the CSV. The export has no required-staffing counts, no committed
// statuses, no UNIV100 classes, and two open-ended seasons, so nothing here is
// load-ready until an administrator answers the questions in sessions-report.json.
// NEVER commit migration-output/ (gitignored): rows carry real center names.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INPUT = `${ROOT}/scrubbed_exports/sessions.csv`;
const OUT_DIR = `${ROOT}/migration-output`;
const SEASON_YEAR = 2026;
const WEEKDAYS = { sun: 7, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function collapse(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

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

const isUnresolved = (value) => /^(?:no slot agreed|tbd|—|-|)\s*$/iu.test(collapse(value));

function slug(value) {
  return collapse(value).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
}

function dayOfWeek(date) {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

function isoDate(date) {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function parseTimeTokens(value) {
  const withoutNotes = value.replace(/\([^)]*\)/gu, ' ');
  const notes = [...value.matchAll(/\(([^)]*)\)/gu)].map((match) => collapse(match[1])).filter(Boolean);
  const tokens = [...withoutNotes.matchAll(/(\d{1,2}):(\d{2})\s*(AM|PM)?/giu)].map((match) => ({
    hour: Number(match[1]),
    minute: Number(match[2]),
    meridiem: match[3] ? match[3].toUpperCase() : undefined
  }));
  if (tokens.length === 0) return { start: undefined, end: undefined, notes };
  const last = tokens[tokens.length - 1];
  const inherited = last.meridiem ?? tokens[0].meridiem;
  const to24 = (token) => {
    const meridiem = token.meridiem ?? inherited;
    let hour = token.hour;
    if (meridiem === 'PM' && hour < 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(token.minute).padStart(2, '0')}`;
  };
  return { start: to24(tokens[0]), end: tokens.length > 1 ? to24(tokens[1]) : undefined, notes };
}

function parseMonthDay(value) {
  const match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})$/u.exec(collapse(value));
  if (!match) return undefined;
  const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
  if (!month) return undefined;
  return { year: SEASON_YEAR, month, day: Number(match[2]) };
}

function expandWeekly(start, end, weekday) {
  const dates = [];
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day));
  const last = Date.UTC(end.year, end.month - 1, end.day);
  while (cursor.getTime() <= last) {
    const date = { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate() };
    if (dayOfWeek(date) === weekday) dates.push(date);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

const raw = await readFile(INPUT, 'utf8');
const rows = parseCsv(raw);
const centers = new Map();
const drafts = [];
const rowReports = [];

for (const [index, row] of rows.entries()) {
  const line = index + 2;
  const centerName = collapse(row.Center);
  const area = collapse(row.Area);
  const schedule = collapse(row['Day & Time (ET)']);
  const frequency = collapse(row.Freq);
  const dates = collapse(row.Dates);
  const centerId = slug(centerName);

  if (!centerName) continue;
  if (isUnresolved(schedule) || isUnresolved(dates)) {
    rowReports.push({ line, centerName, centerId, disposition: 'excluded-unresolved', schedule, dates, unknownFields: ['schedule', 'dates'] });
    continue;
  }

  centers.set(centerId, { id: centerId, name: centerName, area, active: true });

  const weekdayMatch = /^(?:(\d)(?:st|nd|rd|th)\s+)?(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/iu.exec(schedule);
  const weekday = weekdayMatch ? WEEKDAYS[weekdayMatch[2].slice(0, 3).toLowerCase()] : undefined;
  const ordinal = weekdayMatch?.[1] ? Number(weekdayMatch[1]) : undefined;
  const { start, end, notes } = parseTimeTokens(schedule);
  const unknownFields = [];
  if (weekday === undefined) unknownFields.push('weekday');
  if (start === undefined) unknownFields.push('start');
  if (end === undefined) unknownFields.push('end (CSV gives a start time only; a length or end time is required)');
  unknownFields.push('requiredStaffCount (0-2)');
  unknownFields.push('status (locked vs proposed)');
  unknownFields.push(`timeZone (CSV says ET; assumed ${'America/New_York'} pending confirmation)`);

  let occurrences = [];
  const rangeMatch = /^(.+?)\s*[–-]\s*(.+)$/u.exec(dates);
  if (frequency.toLowerCase() === 'weekly' && rangeMatch) {
    const rangeStart = parseMonthDay(rangeMatch[1]);
    const rangeEnd = parseMonthDay(rangeMatch[2]);
    if (rangeStart && rangeEnd && weekday !== undefined) {
      occurrences = expandWeekly(rangeStart, rangeEnd, weekday).map(isoDate);
      if (ordinal !== undefined) {
        const filtered = occurrences.filter((date) => {
          const [year, month, day] = date.split('-').map(Number);
          return Math.ceil(day / 7) === ordinal;
        });
        if (filtered.length !== occurrences.length) {
          unknownFields.push(`ordinal-week rule ("${ordinal}th ${weekdayMatch[2]}") applied to a weekly range — confirm whether all ${occurrences.length} dates are in scope or only ${filtered.length}`);
          occurrences = filtered;
        }
      }
    } else if (!rangeEnd) {
      unknownFields.push('season end date (CSV says "ongoing"; the spec loads occurrences through December, so an explicit end is required)');
    } else {
      unknownFields.push('date range could not be parsed');
    }
  } else if (dates.includes(',')) {
    occurrences = dates.split(',').map(parseMonthDay).filter(Boolean).map(isoDate);
    if (weekday !== undefined) {
      const mismatched = occurrences.filter((date) => {
        const [year, month, day] = date.split('-').map(Number);
        return dayOfWeek({ year, month, day }) !== weekday;
      });
      if (mismatched.length > 0) unknownFields.push(`explicit dates do not fall on the stated weekday: ${mismatched.join(', ')}`);
    }
  } else {
    unknownFields.push('occurrence dates could not be parsed');
  }

  for (const date of occurrences) {
    drafts.push({
      id: `session-${centerId}-${date}-${start ?? 'unknown'}`,
      kind: 'center',
      centerId,
      title: `Center session: ${centerName}`,
      date,
      start,
      end,
      timeZone: 'America/New_York',
      requiredStaffCount: null,
      status: 'locked',
      sourceCandidateId: '',
      revision: 0,
      createdAt: '',
      updatedAt: ''
    });
  }

  rowReports.push({
    line,
    centerId,
    centerName,
    frequency,
    weekday: weekdayMatch?.[2],
    schedule,
    dateSource: dates,
    occurrenceCount: occurrences.length,
    firstOccurrence: occurrences[0],
    lastOccurrence: occurrences.at(-1),
    derivedStart: start,
    derivedEnd: end,
    notes,
    disposition: 'draft-blocked-on-administrator-fields',
    unknownFields
  });
}

const report = {
  tool: 'build-sessions',
  inputRows: rows.length,
  seasonYear: SEASON_YEAR,
  centers: [...centers.values()],
  draftOccurrenceCount: drafts.length,
  loadReadyOccurrenceCount: 0,
  loadReadyReason: 'requiredStaffCount, status, and timeZone are absent from the source export; UNIV100 rows do not exist in it',
  rows: rowReports,
  remainingQuestions: [
    'Required staff count (0, 1, or 2) for each center row.',
    'Explicit season end for every row whose Dates column says "ongoing".',
    'End time for any row that gives only a start time.',
    'Confirmation that all times are America/New_York.',
    'Confirmed UNIV100 classes with date, start, end, and required staff count (or an explicit "none this term").'
  ]
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/centers.json`, `${JSON.stringify([...centers.values()], null, 2)}\n`, { mode: 0o600 });
await writeFile(`${OUT_DIR}/sessions-draft.json`, `${JSON.stringify(drafts, null, 2)}\n`, { mode: 0o600 });
await writeFile(`${OUT_DIR}/sessions-report.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`rows=${rows.length} centers=${centers.size} occurrences=${drafts.length} loadReady=${report.loadReadyOccurrenceCount}`);
for (const row of rowReports) {
  console.log(`${row.disposition} ${row.centerName}: ${row.occurrenceCount ?? 0} occurrence(s)${row.firstOccurrence ? ` ${row.firstOccurrence}..${row.lastOccurrence}` : ''}`);
  for (const field of row.unknownFields) console.log(`    missing: ${field}`);
}
