import { decodeHTML } from 'entities';
import { normalizeWeeklyIntervals, minuteTime } from '../domain/intervals';
import type { ImportMapping, ImportParticipant, StagedParticipant, Volunteer, Weekday, WeeklyInterval } from '../domain/models';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const collections = new Set(['participants', 'respondents', 'attendees', 'people', 'users', 'entries', 'results']);
const availabilityKeys = ['availability', 'availabilities', 'slots', 'times', 'responses', 'intervals', 'answers'];
const first = (value: RecordValue, keys: string[]) => keys.map(key => value[key]).find(item => item !== undefined && item !== null);
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

function weekday(value: unknown): Weekday | undefined {
  if (typeof value === 'number' || /^\d$/.test(text(value))) {
    const day = Number(value);
    return Number.isInteger(day) && day >= 1 && day <= 7 ? day as Weekday : undefined;
  }
  const string = text(value).toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(string)) {
    const date = new Date(`${string}T00:00:00Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === string) return (date.getUTCDay() || 7) as Weekday;
  }
  const index = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(string.slice(0, 3));
  return index >= 0 ? (index + 1) as Weekday : undefined;
}

function clock(value: unknown): string | undefined {
  if (typeof value === 'number' || /^\d+$/.test(text(value))) {
    const minutes = Number(value);
    return Number.isInteger(minutes) && minutes >= 0 && minutes < 1440 ? minuteTime(minutes) : undefined;
  }
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(text(value));
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (match[3]) {
    if (hour < 1 || hour > 12) return undefined;
    hour = hour % 12 + (match[3].toLowerCase() === 'pm' ? 12 : 0);
  }
  return hour < 24 && minute < 60 ? `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}` : undefined;
}

function intervals(value: unknown, timeZone: string, inheritedDay?: Weekday, depth = 0): WeeklyInterval[] {
  if (depth > 40) return [];
  let day = inheritedDay;
  let start: unknown;
  let end: unknown;
  let zone = timeZone;
  if (Array.isArray(value)) {
    if (weekday(value[0]) && clock(value[1]) && clock(value[2])) {
      day = weekday(value[0]); start = value[1]; end = value[2]; zone = text(value[3]) || timeZone;
    } else if (inheritedDay && clock(value[0]) && clock(value[1])) {
      start = value[0]; end = value[1]; zone = text(value[2]) || timeZone;
    } else return value.flatMap(item => intervals(item, timeZone, inheritedDay, depth + 1));
  } else if (record(value)) {
    day = weekday(first(value, ['weekday', 'day', 'date'])) ?? inheritedDay;
    start = first(value, ['start', 'startTime', 'start_time', 'from']);
    end = first(value, ['end', 'endTime', 'end_time', 'to']);
    zone = text(first(value, ['timeZone', 'timezone', 'time_zone'])) || timeZone;
    if (start === undefined || end === undefined) return Object.entries(value).flatMap(([key, item]) => intervals(item, zone, weekday(key) ?? day, depth + 1));
  } else return [];
  const parsedStart = clock(start);
  const parsedEnd = clock(end);
  if (!day || !parsedStart || !parsedEnd || parsedStart >= parsedEnd) return [];
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { return []; }
  return [{ weekday: day, start: parsedStart, end: parsedEnd, timeZone: zone }];
}

/** Extract nested spans too, so surrounding non-JSON JavaScript does not hide embedded JSON. */
function jsonValues(html: string): unknown[] {
  const source = decodeHTML(html);
  const stack: { start: number; opener: string }[] = [];
  const values: unknown[] = [];
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"' && stack.length > 0) { quoted = true; continue; }
    if (char === '{' || char === '[') stack.push({ start: i, opener: char });
    else if (char === '}' || char === ']') {
      const span = stack.pop();
      if (span && ((span.opener === '{' && char === '}') || (span.opener === '[' && char === ']'))) {
        try { values.push(JSON.parse(source.slice(span.start, i + 1))); } catch { /* Non-JSON script fragments are expected. */ }
      }
    }
  }
  return values;
}

type ParsedResults = { ok: true; participants: ImportParticipant[] } | { ok: false; error: string };

type MappingIdentity = { kind: 'participantId' | 'email' | 'name'; value: string };
type MappingIdentityFields = { sourceParticipantId?: string | null; sourceEmail?: string | null; sourceName?: string | null };

export function normalizeImportEmail(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

export function normalizeImportName(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
}

function mappingIdentity(value: MappingIdentityFields): MappingIdentity | undefined {
  if (value.sourceParticipantId) return { kind: 'participantId', value: value.sourceParticipantId };
  const email = normalizeImportEmail(value.sourceEmail);
  if (email) return { kind: 'email', value: email };
  const name = normalizeImportName(value.sourceName);
  return name ? { kind: 'name', value: name } : undefined;
}

/** Mapping rows use their strongest available identity; weaker fields are descriptive once a stronger key exists. */
export function sameMappingIdentity(left: MappingIdentityFields, right: MappingIdentityFields): boolean {
  const a = mappingIdentity(left);
  const b = mappingIdentity(right);
  return !!a && !!b && a.kind === b.kind && a.value === b.value;
}

/** Used to find the staged run affected by an upsert, using the same key precedence as mapping resolution. */
export function participantMatchesMappingIdentity(participant: ImportParticipant, fields: MappingIdentityFields): boolean {
  const identity = mappingIdentity(fields);
  if (!identity) return false;
  if (identity.kind === 'participantId') return participant.id === identity.value;
  if (identity.kind === 'email') return normalizeImportEmail(participant.email) === identity.value;
  return normalizeImportName(participant.name) === identity.value;
}

function frequencies(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function mappingForParticipant(
  participant: ImportParticipant,
  mappings: ImportMapping[],
  emailCounts: Map<string, number>,
  nameCounts: Map<string, number>,
): { found: false } | { found: true; mapping: ImportMapping | null } {
  const lookup = (identity: MappingIdentity): { found: false } | { found: true; mapping: ImportMapping | null } => {
    const matches = mappings.filter(mapping => {
      const key = mappingIdentity(mapping);
      return key?.kind === identity.kind && key.value === identity.value;
    });
    return matches.length ? { found: true, mapping: matches.length === 1 ? matches[0]! : null } : { found: false };
  };

  const participantId = lookup({ kind: 'participantId', value: participant.id });
  if (participantId.found) return participantId;
  const email = normalizeImportEmail(participant.email);
  if (email && emailCounts.get(email) === 1) {
    const byEmail = lookup({ kind: 'email', value: email });
    if (byEmail.found) return byEmail;
  }
  const name = normalizeImportName(participant.name);
  if (name && nameCounts.get(name) === 1) {
    const byName = lookup({ kind: 'name', value: name });
    if (byName.found) return byName;
  }
  return { found: false };
}

/** Read the site's data assignments as text; never execute third-party scripts. */
function nativeResults(html: string, timeZone: string): ParsedResults | undefined {
  if (!/var\s+respondents\s*=\s*new Array\s*\(/.test(html)) return undefined;
  const slots = new Map<string, { weekday: Weekday; start: number }>();
  const cellPattern = /<td\b[^>]*\bid=["'](\d{13})["'][^>]*>[\s\S]*?<td\b[^>]*\bclass=["']?gridText\b[^>]*>([^<]+)<\/td>/gi;
  for (const match of html.matchAll(cellPattern)) {
    // WhenIsGood encodes grid wall dates in UTC-shaped timestamps, not instants.
    // Use the displayed grid clock, rather than applying another timezone shift.
    const date = new Date(Number(match[1]));
    const start = clock(decodeHTML(match[2]!).trim());
    if (!start || Number.isNaN(date.getTime())) continue;
    const [hour, minute] = start.split(':').map(Number);
    slots.set(match[1]!, { weekday: (date.getUTCDay() || 7) as Weekday, start: hour! * 60 + minute! });
  }
  const starts = [...new Set([...slots.values()].map(slot => slot.start))].sort((a, b) => a - b);
  const step = Math.min(...starts.slice(1).map((value, index) => value - starts[index]!));
  if (!Number.isFinite(step) || step <= 0 || step > 240) return { ok: false, error: 'The results page does not provide a recognizable slot duration.' };
  const participants: ImportParticipant[] = [];
  const respondentPattern = /var\s+(\w+)\s*=\s*new Object\s*\(\s*\)\s*;([\s\S]*?)respondents\s*\[[^\]]+\]\s*=\s*\1\s*;/g;
  for (const match of html.matchAll(respondentPattern)) {
    const fields = new Map<string, string>();
    const assignments = new RegExp(`\\b${match[1]}\\.(id|name|email|myCanDosAll|myCanDos)\\s*=\\s*("(?:\\\\.|[^"\\\\])*")`, 'g');
    try {
      for (const field of match[2]!.matchAll(assignments)) fields.set(field[1]!, decodeHTML(JSON.parse(field[2]!)));
    } catch { return { ok: false, error: 'A participant record could not be parsed.' }; }
    const id = fields.get('id'); const name = fields.get('name');
    const selected = fields.get('myCanDosAll') ?? fields.get('myCanDos');
    if (!id || !name || selected === undefined) return { ok: false, error: 'A participant record could not be parsed.' };
    const availability: WeeklyInterval[] = [];
    for (const timestamp of selected ? selected.split(',') : []) {
      const slot = slots.get(timestamp.trim());
      if (!slot || slot.start + step >= 1440) return { ok: false, error: 'A participant has nonempty availability that could not be parsed.' };
      availability.push({ weekday: slot.weekday, start: minuteTime(slot.start), end: minuteTime(slot.start + step), timeZone });
    }
    participants.push({ id, name, email: fields.get('email')?.toLowerCase() ?? null, intervals: normalizeWeeklyIntervals(availability) });
  }
  return participants.length ? { ok: true, participants } : { ok: false, error: 'No recognizable participant availability was found in the results page.' };
}

export function parseWhenIsGood(html: string, timeZone: string): ParsedResults {
  const native = nativeResults(html, timeZone);
  if (native) return native;
  const participants: ImportParticipant[] = [];
  const seen = new Set<string>();
  let malformedAvailability = false;
  // An explicit empty collection means no availability. Unparseable nonempty
  // source data must not become an empty replacement during promotion.
  function explicitlyEmpty(value: unknown, depth = 0): boolean {
    if (depth > 40) return false;
    if (Array.isArray(value)) return value.every(item => explicitlyEmpty(item, depth + 1));
    if (record(value)) return Object.values(value).every(item => explicitlyEmpty(item, depth + 1));
    return false;
  }
  function collect(value: unknown, depth = 0): void {
    if (depth > 40) return;
    if (Array.isArray(value)) { value.forEach(item => collect(item, depth + 1)); return; }
    if (!record(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (collections.has(key) && (Array.isArray(child) || record(child))) {
        const entries = Array.isArray(child) ? child.map(item => [undefined, item] as const) : Object.entries(child);
        for (const [keyId, entry] of entries) {
          if (!record(entry)) continue;
          const name = text(first(entry, ['name', 'displayName', 'fullName', 'participantName', 'label']));
          const rawEmail = text(first(entry, ['email', 'emailAddress', 'mail']));
          const availability = first(entry, availabilityKeys);
          if ((!name && !rawEmail) || availability === undefined) continue;
          const id = text(first(entry, ['id', 'participantId', 'userId', 'key', 'uid'])) || keyId;
          const parsed = normalizeWeeklyIntervals(intervals(availability, timeZone));
          if (parsed.length === 0 && !explicitlyEmpty(availability)) {
            malformedAvailability = true;
            continue;
          }
          const email = rawEmail ? rawEmail.toLowerCase() : null;
          const signature = JSON.stringify([id, name, email, parsed]);
          if (seen.has(signature)) continue;
          seen.add(signature);
          participants.push({ id: id || `participant-${participants.length + 1}`, name: name || rawEmail, email, intervals: parsed });
        }
      }
      collect(child, depth + 1);
    }
  }
  jsonValues(html).forEach(value => collect(value));
  if (malformedAvailability) return { ok: false, error: 'A participant has nonempty availability that could not be parsed.' };
  return participants.length > 0 ? { ok: true, participants } : { ok: false, error: 'No recognizable participant availability was found in the results page.' };
}

export function stageParticipants(participants: ImportParticipant[], volunteers: Volunteer[], mappings: ImportMapping[]): { stagedAvailability: StagedParticipant[]; unmatched: ImportParticipant[]; matchedCount: number } {
  const volunteerIds = new Set(volunteers.map(volunteer => volunteer.id));
  const sourceMappings = mappings.filter(mapping => mapping.source === 'whenIsGood');
  const emailCounts = frequencies(participants.map(participant => normalizeImportEmail(participant.email)));
  const nameCounts = frequencies(participants.map(participant => normalizeImportName(participant.name)));
  const stagedAvailability = participants.map(participant => {
    const mappingResult = mappingForParticipant(participant, sourceMappings, emailCounts, nameCounts);
    const email = normalizeImportEmail(participant.email);
    const name = normalizeImportName(participant.name);
    const emailMatches = email && emailCounts.get(email) === 1
      ? volunteers.filter(volunteer => normalizeImportEmail(volunteer.email) === email) : [];
    const nameMatches = name && nameCounts.get(name) === 1
      ? volunteers.filter(volunteer => normalizeImportName(volunteer.name) === name) : [];
    const volunteerId = mappingResult.found ? (mappingResult.mapping && volunteerIds.has(mappingResult.mapping.volunteerId) ? mappingResult.mapping.volunteerId : null)
      : emailMatches.length === 1 ? emailMatches[0]!.id
      : emailMatches.length === 0 && nameMatches.length === 1 ? nameMatches[0]!.id : null;
    return { ...participant, volunteerId };
  });
  const unmatched = participants.filter((_, index) => stagedAvailability[index]!.volunteerId === null);
  return { stagedAvailability, unmatched, matchedCount: participants.length - unmatched.length };
}
