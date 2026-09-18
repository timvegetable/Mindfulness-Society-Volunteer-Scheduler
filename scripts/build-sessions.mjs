#!/usr/bin/env node
// Builds load-ready Centers and Sessions rows from the reviewed exports:
//   scrubbed_exports/centers.csv  - committed center occurrences (kind=center, status=locked)
//   scrubbed_exports/univ100.csv  - confirmed classes      (kind=univ100, status=confirmed)
// Administrator decisions recorded here:
//   * requiredStaffCount = 1 for every session (surplus eligible volunteers become
//     ordered backups, which the app caps at two).
//   * Rows whose Dates column says "ongoing" have no end date, so occurrences are
//     materialized through 2026-12-31 (the "through December" boundary in the task).
//   * Center ids are slugs of the center name; adding a center later adds a new slug.
//   * A class row with no explicit date is excluded and reported, never guessed.
// Output carries real center/instructor names: NEVER commit migration-output/.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CENTERS_INPUT = `${ROOT}/scrubbed_exports/centers.csv`;
const UNIV100_INPUT = `${ROOT}/scrubbed_exports/univ100.csv`;
const OUT_DIR = `${ROOT}/migration-output`;
const SEASON_YEAR = 2026;
const SEASON_END = { year: 2026, month: 12, day: 31 };
const TIME_ZONE = 'America/New_York';
const REQUIRED_STAFF_COUNT = 1;
const DEFAULT_SESSION_MINUTES = 45;
const MIGRATED_AT = process.env.MIGRATED_AT ?? '2026-09-18T00:00:00.000Z';
const WEEKDAYS = { sun: 7, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const collapse = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
const isUnresolved = (value) => /^(?:no slot agreed|tbd|—|-|)\s*$/iu.test(collapse(value));

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

const slug = (value) => collapse(value).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
const isoDate = (date) => `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
const dayOfWeek = (date) => {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return day === 0 ? 7 : day;
};
const weekdayName = (weekday) => Object.keys(WEEKDAYS).find((key) => WEEKDAYS[key] === weekday);

function parseTimeTokens(value) {
  const withoutNotes = value.replace(/\([^)]*\)/gu, ' ');
  const notes = [...value.matchAll(/\(([^)]*)\)/gu)].map((match) => collapse(match[1])).filter(Boolean);
  const tokens = [...withoutNotes.matchAll(/(\d{1,2}):(\d{2})\s*(AM|PM)?/giu)].map((match) => ({
    hour: Number(match[1]), minute: Number(match[2]), meridiem: match[3]?.toUpperCase()
  }));
  if (tokens.length === 0) return { start: undefined, end: undefined, notes };
  const inherited = tokens.at(-1).meridiem ?? tokens[0].meridiem;
  const to24 = (token) => {
    const meridiem = token.meridiem ?? inherited;
    let hour = token.hour;
    if (meridiem === 'PM' && hour < 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(token.minute).padStart(2, '0')}`;
  };
  return { start: to24(tokens[0]), end: tokens.length > 1 ? to24(tokens[1]) : undefined, notes };
}

function addMinutes(time, minutes) {
  const [hour, minute] = time.split(':').map(Number);
  const total = hour * 60 + minute + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function parseMonthDay(value) {
  const match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})$/u.exec(collapse(value));
  const month = match ? MONTHS[match[1].slice(0, 3).toLowerCase()] : undefined;
  return match && month ? { year: SEASON_YEAR, month, day: Number(match[2]) } : undefined;
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

const unaccounted = [];
const notes = [];
const winterBreak = [];
const centers = new Map();
const sessions = [];
const rowReports = [];

function session(centerId, kind, title, date, start, end, id) {
  return {
    id,
    kind,
    ...(centerId ? { centerId } : {}),
    title,
    date,
    start,
    end,
    timeZone: TIME_ZONE,
    requiredStaffCount: REQUIRED_STAFF_COUNT,
    status: kind === 'center' ? 'locked' : 'confirmed',
    revision: 0,
    createdAt: MIGRATED_AT,
    updatedAt: MIGRATED_AT
  };
}

// ---------------------------------------------------------------- centers
for (const [index, row] of parseCsv(await readFile(CENTERS_INPUT, 'utf8')).entries()) {
  const line = index + 2;
  const centerName = collapse(row.Center);
  const schedule = collapse(row['Day & Time (ET)']);
  const frequency = collapse(row.Freq);
  const datesText = collapse(row.Dates);
  if (!centerName) continue;
  if (isUnresolved(schedule) || isUnresolved(datesText)) {
    unaccounted.push({ source: 'centers.csv', line, centerName, reason: 'no agreed slot or dates', schedule, dates: datesText });
    continue;
  }
  const centerId = slug(centerName);
  if (centers.has(centerId)) unaccounted.push({ source: 'centers.csv', line, centerName, reason: `center slug ${centerId} collides with an earlier row` });
  centers.set(centerId, { id: centerId, name: centerName, active: true, revision: 0, createdAt: MIGRATED_AT, updatedAt: MIGRATED_AT });

  const weekdayMatch = /^(?:(\d)(?:st|nd|rd|th)\s+)?(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/iu.exec(schedule);
  if (!weekdayMatch) {
    unaccounted.push({ source: 'centers.csv', line, centerName, reason: 'weekday could not be parsed', schedule });
    continue;
  }
  const weekday = WEEKDAYS[weekdayMatch[2].slice(0, 3).toLowerCase()];
  const ordinal = weekdayMatch[1] ? Number(weekdayMatch[1]) : undefined;
  const parsedTime = parseTimeTokens(schedule);
  const { start, notes: timeNotes } = parsedTime;
  // A couple of rows give only a start time; every other row in the export runs
  // 45 minutes, and the administrator confirmed the one such row ends at 13:45.
  const end = parsedTime.end ?? (start ? addMinutes(start, DEFAULT_SESSION_MINUTES) : undefined);
  if (start && !parsedTime.end) notes.push(`${centerName}: the export gives only a start time; end set to ${end} using the export's ${DEFAULT_SESSION_MINUTES}-minute length (administrator-confirmed for this row).`);

  const rangeMatch = /^(.+?)\s*[–-]\s*(.+)$/u.exec(datesText);
  let occurrenceDates = [];
  let horizon = 'as written in the export';
  if (rangeMatch) {
    const rangeStart = parseMonthDay(rangeMatch[1]);
    let rangeEnd = parseMonthDay(rangeMatch[2]);
    if (!rangeEnd && /ongoing/iu.test(rangeMatch[2])) {
      rangeEnd = SEASON_END;
      horizon = `open-ended in the export; occurrences materialized through ${isoDate(SEASON_END)} (administrator decision)`;
      notes.push(`${centerName}: "${datesText}" has no end date; materialized through ${isoDate(SEASON_END)} — later occurrences must be added when the season is extended.`);
    }
    if (!rangeStart || !rangeEnd || !start || !end) {
      unaccounted.push({ source: 'centers.csv', line, centerName, reason: 'date range, start time, or end time could not be parsed', schedule, dates: datesText });
      continue;
    }
    occurrenceDates = expandWeekly(rangeStart, rangeEnd, weekday);
  } else if (datesText.includes(',')) {
    occurrenceDates = datesText.split(',').map(parseMonthDay).filter(Boolean);
    if (ordinal !== undefined) {
      const offRule = occurrenceDates.filter((date) => Math.ceil(date.day / 7) !== ordinal || dayOfWeek(date) !== weekday);
      if (offRule.length > 0) unaccounted.push({ source: 'centers.csv', line, centerName, reason: `explicit dates are not ${ordinal}th ${weekdayName(weekday)}: ${offRule.map(isoDate).join(', ')}` });
      occurrenceDates = occurrenceDates.filter((date) => !offRule.includes(date));
    }
  }
  if (!start || !end) {
    unaccounted.push({ source: 'centers.csv', line, centerName, reason: 'start or end time could not be parsed', schedule });
    continue;
  }

  for (const date of occurrenceDates) {
    sessions.push(session(centerId, 'center', `Center session: ${centerName}`, isoDate(date), start, end, `session-${centerId}-${isoDate(date)}`));
    if (date.month === 12 && date.day >= 24) winterBreak.push(`${centerName} ${isoDate(date)}`);
  }
  rowReports.push({
    source: 'centers.csv', line, centerId, centerName, frequency, schedule, dates: datesText,
    derivedWeekday: weekdayName(weekday), derivedStart: start, derivedEnd: end, timeNotes,
    occurrenceCount: occurrenceDates.length, firstOccurrence: occurrenceDates[0] && isoDate(occurrenceDates[0]),
    lastOccurrence: occurrenceDates.at(-1) && isoDate(occurrenceDates.at(-1)), horizon
  });
}

// ---------------------------------------------------------------- UNIV100
for (const [index, row] of parseCsv(await readFile(UNIV100_INPUT, 'utf8')).entries()) {
  const line = index + 2;
  const instructor = collapse(row.Instructor);
  const datesText = collapse(row['Date(s) offered']);
  const timeText = collapse(row.Time);
  const location = collapse(row.Location);
  const format = collapse(row.Format);
  if (!instructor) continue;

  const dateMatch = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})$/iu.exec(datesText);
  const { start, end, notes: timeNotes } = parseTimeTokens(timeText);
  if (!dateMatch || !start || !end) {
    unaccounted.push({
      source: 'univ100.csv', line, instructor,
      reason: !dateMatch ? 'class has no explicit calendar date; excluded rather than guessed (administrator may add it later)' : 'time range could not be parsed',
      dates: datesText, time: timeText, location, format
    });
    continue;
  }
  const date = { year: SEASON_YEAR, month: MONTHS[dateMatch[2].slice(0, 3).toLowerCase()], day: Number(dateMatch[3]) };
  const statedWeekday = WEEKDAYS[dateMatch[1].slice(0, 3).toLowerCase()];
  if (statedWeekday !== undefined && dayOfWeek(date) !== statedWeekday) {
    unaccounted.push({ source: 'univ100.csv', line, instructor, reason: `${isoDate(date)} is not a ${weekdayName(statedWeekday)}`, dates: datesText });
    continue;
  }
  const title = `UNIV100: ${instructor}${location && !/^not given$/iu.test(location) ? ` (${location})` : ''}`;
  sessions.push(session(undefined, 'univ100', title, isoDate(date), start, end, `session-univ100-${slug(instructor)}-${isoDate(date)}`));
  rowReports.push({
    source: 'univ100.csv', line, instructor, title, format, location, dates: datesText,
    derivedWeekday: weekdayName(dayOfWeek(date)), derivedStart: start, derivedEnd: end, timeNotes,
    occurrenceCount: 1, firstOccurrence: isoDate(date), lastOccurrence: isoDate(date), horizon: 'single occurrence'
  });
}

sessions.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : left.start < right.start ? -1 : left.start > right.start ? 1 : left.id < right.id ? -1 : 1));
const centerSessions = sessions.filter((row) => row.kind === 'center');
const classSessions = sessions.filter((row) => row.kind === 'univ100');

const report = {
  tool: 'build-sessions',
  seasonYear: SEASON_YEAR,
  timeZone: TIME_ZONE,
  requiredStaffCount: REQUIRED_STAFF_COUNT,
  requestedStaffingRange: '1-2 volunteers per session; stored as requiredStaffCount=1 so surplus eligible volunteers become ordered backups (app cap is two)',
  counts: {
    centers: centers.size,
    centerOccurrences: centerSessions.length,
    univ100Classes: classSessions.length,
    totalSessions: sessions.length
  },
  coverageWindow: {
    centerFrom: centerSessions[0]?.date,
    centerTo: centerSessions.at(-1)?.date,
    classFrom: classSessions[0]?.date,
    classTo: classSessions.at(-1)?.date
  },
  rows: rowReports,
  notes,
  winterBreak,
  unaccounted,
  nextStep: 'Review counts, then initialize the workbook and load these rows (requires explicit authorization for a production Sheet write).'
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/centers.json`, `${JSON.stringify([...centers.values()], null, 2)}\n`, { mode: 0o600 });
await writeFile(`${OUT_DIR}/sessions.json`, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
await writeFile(`${OUT_DIR}/sessions-report.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`centers=${centers.size} centerOccurrences=${centerSessions.length} univ100=${classSessions.length} total=${sessions.length}`);
for (const row of rowReports) {
  console.log(`  ${row.source === 'centers.csv' ? row.centerId : `univ100:${row.instructor}`} ${row.occurrenceCount}x ${row.firstOccurrence}${row.lastOccurrence !== row.firstOccurrence ? `..${row.lastOccurrence}` : ''} ${row.derivedWeekday} ${row.derivedStart}-${row.derivedEnd}`);
}
for (const note of notes) console.log(`note: ${note}`);
if (winterBreak.length > 0) console.log(`note: ${winterBreak.length} occurrence(s) fall in the winter break (Dec 24–31) and should be dropped if the centers are closed: ${winterBreak.join(', ')}`);
for (const item of unaccounted) console.log(`unaccounted: [${item.source}:${item.line}] ${item.instructor ?? item.centerName} — ${item.reason}`);
