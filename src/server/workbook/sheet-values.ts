import { Temporal } from '@js-temporal/polyfill';

/**
 * Workbook cell boundary. Google Sheets hands back `Date` instances for cells a
 * person formatted as date, time, or date-time, and those instances carry the
 * spreadsheet's zone rather than the value the coordinator typed. Every codec
 * therefore decodes through these helpers so a domain object only ever sees the
 * canonical `YYYY-MM-DD`, `HH:mm`, and ISO 8601 forms the shared schemas accept.
 *
 * The helpers are total: an unrecognized value is returned unchanged, which lets
 * schema validation reject it loudly instead of hiding a malformed row behind a
 * plausible-looking default.
 */

/** Zone used when a decode happens outside a configured runtime (tests, tooling). */
export const DEFAULT_SHEET_TIME_ZONE = 'America/New_York';

export type SheetValueContext = { timeZone?: string; numericDateTimeSerials?: boolean };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const SHEETS_EPOCH = Temporal.PlainDate.from('1899-12-30');
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function instantOf(value: Date, context?: SheetValueContext): Temporal.ZonedDateTime {
  const zone = context?.timeZone?.trim() || DEFAULT_SHEET_TIME_ZONE;
  return Temporal.Instant.fromEpochMilliseconds(value.getTime()).toZonedDateTimeISO(zone);
}
function isUsableDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function clockFromFraction(value: number): string {
  const minutes = Math.round((value - Math.floor(value)) * 24 * 60) % (24 * 60);
  const hour = Math.floor(minutes / 60).toString().padStart(2, '0');
  const minute = (minutes % 60).toString().padStart(2, '0');
  return `${hour}:${minute}`;
}

/**
 * The Sheets Values API returns date/time cells as serial numbers when asked
 * for UNFORMATTED_VALUE. Their integer part is a civil day from 1899-12-30 and
 * their fraction is a wall-clock time in the spreadsheet's zone. Keep that
 * distinction explicit: date-only and time-only cells are not UTC timestamps.
 */
function plainDateTimeFromSerial(value: number): Temporal.PlainDateTime | undefined {
  if (!Number.isFinite(value)) return undefined;
  try {
    const days = Math.floor(value);
    let milliseconds = Math.round((value - days) * MILLISECONDS_PER_DAY);
    let adjustedDays = days;
    if (milliseconds >= MILLISECONDS_PER_DAY) {
      adjustedDays += 1;
      milliseconds = 0;
    }
    return SHEETS_EPOCH.add({ days: adjustedDays }).toPlainDateTime().add({ milliseconds });
  } catch {
    // Out-of-calendar serials stay raw so the row schema rejects them, as it
    // does other malformed values, instead of leaking a Temporal exception.
    return undefined;
  }
}

function instantFromSerial(value: number, context?: SheetValueContext): string | undefined {
  const plainDateTime = plainDateTimeFromSerial(value);
  if (!plainDateTime) return undefined;
  const zone = context?.timeZone?.trim() || DEFAULT_SHEET_TIME_ZONE;
  const instant = plainDateTime.toZonedDateTime(zone, { disambiguation: 'compatible' }).toInstant();
  return new Date(instant.epochMilliseconds).toISOString();
}

export function cellText(value: unknown): string {
  return String(value ?? '');
}

export function optionalCellText(value: unknown): string | undefined {
  const result = cellText(value).trim();
  return result.length > 0 ? result : undefined;
}

export function cellNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function cellBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

/** Decodes a date cell to `YYYY-MM-DD` in the configured zone. */
export function cellDate(value: unknown, context?: SheetValueContext): string {
  if (isUsableDate(value)) return instantOf(value, context).toPlainDate().toString();
  if (context?.numericDateTimeSerials && typeof value === 'number') {
    const dateTime = plainDateTimeFromSerial(value);
    if (dateTime) return dateTime.toPlainDate().toString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (DATE_PATTERN.test(trimmed)) return trimmed;
  }
  return cellText(value);
}

/** Decodes a clock cell to `HH:mm` in the configured zone; accepts time-of-day fractions. */
export function cellClock(value: unknown, context?: SheetValueContext): string {
  if (isUsableDate(value)) return instantOf(value, context).toPlainTime().toString({ smallestUnit: 'minute' });
  if (typeof value === 'number' && Number.isFinite(value)) return clockFromFraction(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (CLOCK_PATTERN.test(trimmed)) return trimmed;
  }
  return cellText(value);
}

/** Decodes a date-time cell to an ISO 8601 instant. */
export function cellInstant(value: unknown, context?: SheetValueContext): string {
  if (isUsableDate(value)) return value.toISOString();
  if (context?.numericDateTimeSerials && typeof value === 'number') return instantFromSerial(value, context) ?? cellText(value);
  return cellText(value);
}

/** Decodes an optional date-time cell: a blank cell means "absent", not `""`. */
export function optionalCellInstant(value: unknown, context?: SheetValueContext): string | undefined {
  const result = cellInstant(value, context).trim();
  return result.length > 0 ? result : undefined;
}
