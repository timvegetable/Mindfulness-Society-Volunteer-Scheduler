import type { ParsedAvailabilitySlot, ParsedParticipant, ParsedWhenIsGood } from './types.js';

export class WhenIsGoodParseError extends Error {
  readonly diagnostic: string;

  constructor(message: string, diagnostic = message) {
    super(message);
    this.name = 'WhenIsGoodParseError';
    this.diagnostic = diagnostic;
  }
}

export type EmbeddedParserOptions = {
  resultId?: string;
  defaultTimeZone?: string;
};

type UnknownRecord = Record<string, unknown>;

const participantKeys = ['participants', 'respondents', 'attendees', 'people', 'users', 'entries', 'results'];
const availabilityKeys = ['availability', 'availabilities', 'slots', 'times', 'responses', 'intervals', 'answers'];

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstText(record: UnknownRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = text(record[key]);
    if (value) return value;
  }
  return undefined;
}

function parseClock(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const total = Math.round(value);
    if (total >= 0 && total <= 24 * 60) {
      const hour = Math.floor(total / 60);
      const minute = total % 60;
      return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    }
  }
  const raw = text(value);
  if (!raw) return undefined;
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(raw);
  if (!match) {
    const isoTime = /(?:T|\s)(\d{2}):(\d{2})/.exec(raw);
    if (isoTime) return `${isoTime[1]}:${isoTime[2]}`;
    return undefined;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  const meridiem = match[3]?.toLowerCase();
  if (minute > 59 || hour > 23 || (meridiem && (hour < 1 || hour > 12))) return undefined;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

function dateOnly(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return match?.[1];
}

function weekday(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7) return value;
  const raw = text(value)?.toLowerCase();
  if (!raw) return undefined;
  const names: Record<string, number> = { monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 7, sun: 7 };
  const named = names[raw];
  if (named) return named;
  const numeric = Number(raw);
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 7 ? numeric : undefined;
}

function weekdayForDate(value: string): number | undefined {
  const parts = value.split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return undefined;
  const date = new Date(Date.UTC(parts[0] ?? 0, (parts[1] ?? 1) - 1, parts[2] ?? 1));
  if (Number.isNaN(date.getTime())) return undefined;
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

function intervalFromRecord(value: unknown, inheritedDate?: string, inheritedWeekday?: number, inheritedTimeZone?: string): ParsedAvailabilitySlot | undefined {
  if (Array.isArray(value)) {
    const [first, second, third, fourth] = value;
    const firstDate = dateOnly(first);
    const firstWeekday = firstDate ? weekdayForDate(firstDate) : weekday(first);
    const start = parseClock(firstDate || firstWeekday ? second : first);
    const end = parseClock(firstDate || firstWeekday ? third : second);
    if (!start || !end || start >= end) return undefined;
    return { date: firstDate ?? inheritedDate, weekday: firstWeekday ?? inheritedWeekday, start, end, timeZone: parseClock(fourth) ? inheritedTimeZone : text(fourth) ?? inheritedTimeZone };
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const date = dateOnly(record.date ?? record.day ?? record.on ?? inheritedDate);
  const day = weekday(record.weekday ?? record.dayOfWeek ?? record.dayName ?? inheritedWeekday) ?? (date ? weekdayForDate(date) : undefined);
  const start = parseClock(record.start ?? record.startTime ?? record.from ?? record.begin ?? record.timeStart);
  const end = parseClock(record.end ?? record.endTime ?? record.to ?? record.finish ?? record.timeEnd);
  if (!start || !end || start >= end) return undefined;
  return {
    date,
    weekday: day,
    start,
    end,
    timeZone: text(record.timeZone ?? record.timezone ?? record.tz) ?? inheritedTimeZone
  };
}

function slotsFromValue(value: unknown, inheritedTimeZone?: string, inheritedDate?: string, inheritedWeekday?: number): ParsedAvailabilitySlot[] {
  if (Array.isArray(value)) {
    const direct = value.map((entry) => intervalFromRecord(entry, inheritedDate, inheritedWeekday, inheritedTimeZone)).filter((entry): entry is ParsedAvailabilitySlot => entry !== undefined);
    if (direct.length > 0) return direct;
    return value.flatMap((entry) => slotsFromValue(entry, inheritedTimeZone, inheritedDate, inheritedWeekday));
  }
  const record = asRecord(value);
  if (!record) return [];
  const direct = intervalFromRecord(record, inheritedDate, inheritedWeekday, inheritedTimeZone);
  if (direct) return [direct];
  const result: ParsedAvailabilitySlot[] = [];
  for (const [key, child] of Object.entries(record)) {
    const keyDate = dateOnly(key);
    const keyWeekday = keyDate ? weekdayForDate(keyDate) : weekday(key);
    result.push(...slotsFromValue(child, inheritedTimeZone, keyDate ?? inheritedDate, keyWeekday ?? inheritedWeekday));
  }
  return result;
}

function availabilityValue(record: UnknownRecord): unknown {
  for (const key of availabilityKeys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function participantFromRecord(value: unknown, index: number, timeZone?: string): ParsedParticipant | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const name = firstText(record, ['name', 'displayName', 'fullName', 'participantName', 'label']);
  if (!name) return undefined;
  const email = firstText(record, ['email', 'emailAddress', 'mail']);
  const sourceParticipantId = firstText(record, ['id', 'participantId', 'userId', 'key', 'uid']) ?? `participant-${index + 1}`;
  const availability = slotsFromValue(availabilityValue(record) ?? record, text(record.timeZone ?? record.timezone ?? record.tz) ?? timeZone);
  return { sourceParticipantId, name, email, availability };
}

function findParticipantCollection(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    const records = value.map((entry) => asRecord(entry));
    if (records.some((entry) => entry && firstText(entry, ['name', 'displayName', 'fullName', 'participantName']))) return value;
    for (const entry of value) {
      const found = findParticipantCollection(entry);
      if (found) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of participantKeys) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') {
      const entries = Object.entries(candidate).map(([keyName, child]) => {
        const childRecord = asRecord(child);
        return childRecord ? { ...childRecord, id: childRecord.id ?? keyName } : child;
      });
      if (entries.length > 0) return entries;
    }
  }
  for (const child of Object.values(record)) {
    const found = findParticipantCollection(child);
    if (found) return found;
  }
  return undefined;
}

function decodeHtml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function balancedCandidates(textValue: string): string[] {
  const result: string[] = [];
  for (let start = 0; start < textValue.length; start += 1) {
    const opener = textValue[start];
    if (opener !== '{' && opener !== '[') continue;
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let quote: string | undefined;
    let escaped = false;
    for (let index = start; index < textValue.length; index += 1) {
      const character = textValue[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = undefined;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === opener) depth += 1;
      else if (character === closer) {
        depth -= 1;
        if (depth === 0) {
          result.push(textValue.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return result;
}

function parseCandidate(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    const unquoted = candidate.replace(/([{,])\s*([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"');
    return JSON.parse(unquoted);
  }
}

function embeddedCandidates(html: string): string[] {
  const source = decodeHtml(html);
  const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1] ?? '');
  const sections = scripts.length > 0 ? scripts : [source];
  const result: string[] = [];
  for (const section of sections) {
    for (const candidate of balancedCandidates(section)) result.push(candidate);
  }
  return result;
}

export function parseEmbeddedWhenIsGoodData(html: string, options: EmbeddedParserOptions = {}): ParsedWhenIsGood {
  if (!html.trim()) throw new WhenIsGoodParseError('WhenIsGood response is empty');
  const candidates = embeddedCandidates(html);
  let participants: ParsedParticipant[] | undefined;
  let payloadRecord: UnknownRecord | undefined;
  for (const candidate of candidates) {
    try {
      const parsed = parseCandidate(candidate);
      const collection = findParticipantCollection(parsed);
      if (!collection) continue;
      const parsedParticipants = collection.map((entry, index) => participantFromRecord(entry, index, options.defaultTimeZone)).filter((entry): entry is ParsedParticipant => entry !== undefined);
      if (parsedParticipants.length === 0) continue;
      participants = parsedParticipants;
      payloadRecord = asRecord(parsed);
      break;
    } catch {
      continue;
    }
  }
  if (!participants) throw new WhenIsGoodParseError('Supported WhenIsGood embedded participant data was not found', 'No participant collection could be decoded');
  const topLevelTimeZone = payloadRecord ? firstText(payloadRecord, ['timeZone', 'timezone', 'tz']) : undefined;
  return { source: 'whenisgood', resultId: options.resultId, timeZone: topLevelTimeZone ?? options.defaultTimeZone, participants };
}

export const parseWhenIsGoodPayload = parseEmbeddedWhenIsGoodData;
