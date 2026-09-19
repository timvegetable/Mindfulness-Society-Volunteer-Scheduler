import { ApiClientError } from './api';

/**
 * Presentation-only formatters. A fixed locale and explicit time zones keep the
 * rendered strings identical on every browser, and every function is total: an
 * unrecognized value is passed through instead of throwing, so a malformed
 * server value surfaces as text rather than an empty screen.
 */
const LOCALE = 'en-US';
const UTC = 'UTC';

const DATE_FORMAT = new Intl.DateTimeFormat(LOCALE, { timeZone: UTC, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const CLOCK_FORMAT = new Intl.DateTimeFormat(LOCALE, { timeZone: UTC, hour: 'numeric', minute: '2-digit', hour12: true });
const instantFormats = new Map<string, Intl.DateTimeFormat>();

/** Some ICU builds separate a time from its meridiem with a narrow no-break space. */
function render(formatter: Intl.DateTimeFormat, instant: Date): string {
  return formatter.format(instant).replace(/[\u00a0\u202f]/g, ' ');
}

function parseCanonicalDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(Date.UTC(Number(match[1]), month - 1, day));
  return instant.getUTCMonth() === month - 1 && instant.getUTCDate() === day ? instant : undefined;
}

function parseCanonicalClock(value: string): Date | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return new Date(Date.UTC(2000, 0, 1, hours, minutes));
}

/** Renders a canonical `YYYY-MM-DD` workbook date. */
export function formatDate(value: string): string {
  const instant = parseCanonicalDate(value);
  return instant ? render(DATE_FORMAT, instant) : value;
}

/** Renders a canonical `HH:mm` workbook clock. */
export function formatClock(value: string): string {
  const instant = parseCanonicalClock(value);
  return instant ? render(CLOCK_FORMAT, instant) : value;
}

/** Renders a clock range, for example `9:32 AM – 10:02 AM`. */
export function formatRange(start: string, end: string): string {
  return `${formatClock(start)}–${formatClock(end)}`;
}

/** Renders an ISO 8601 instant in the given zone (UTC by default). */
export function formatInstant(value: string, timeZone: string = UTC): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return value;
  let formatter = instantFormats.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE, { timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    instantFormats.set(timeZone, formatter);
  }
  return render(formatter, instant);
}

const KIND_LABELS: Record<string, string> = {
  univ100: 'UNIV100 class',
  center: 'Center session'
};

export interface SessionLabelSource {
  displayName?: string;
  title?: string;
  center?: string;
  kind?: string;
}

/**
 * Prefers the name the server resolved from the Centers tab, so a class shows
 * the center's name rather than a bare identifier. Returns undefined when the
 * server supplied nothing to name the session with.
 */
export function sessionLabel(session: SessionLabelSource): string | undefined {
  const displayName = session.displayName?.trim();
  if (displayName) return displayName;
  const title = session.title?.trim();
  if (title) return title;
  const center = session.center?.trim();
  if (center) return center;
  const kind = session.kind?.trim();
  if (!kind) return undefined;
  return KIND_LABELS[kind] ?? kind;
}

export interface CancellableAssignment {
  status?: string;
}

/** A cancelled occurrence is history, not something a volunteer still owes. */
export function futureAssignments<T extends CancellableAssignment>(assignments: readonly T[]): T[] {
  return assignments.filter((assignment) => {
    const status = assignment.status?.toLowerCase();
    return status !== 'cancelled' && status !== 'canceled';
  });
}

const CANDIDATE_STATE_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  cancelled: 'Cancelled'
};

/** Maps a stored candidate state to its readable label, leaving unknown text alone. */
export function candidateStateLabel(state: string | undefined): string | undefined {
  if (state === undefined) return undefined;
  return CANDIDATE_STATE_LABELS[state.toLowerCase()] ?? state;
}

/**
 * Only numeric coordination details are lifted out of an error, so feedback can
 * say what was short and which revision was current without ever echoing the
 * nested coverage payload that names volunteers.
 */
const FAILURE_DETAIL_LABELS: Record<string, string> = {
  requiredStaffCount: 'required',
  matchingVolunteerCount: 'matching',
  shortfall: 'shortfall',
  expectedRevision: 'expected revision',
  currentRevision: 'current revision'
};

function failureDetails(error: unknown): string | undefined {
  if (!(error instanceof ApiClientError)) return undefined;
  const details = error.details;
  if (typeof details !== 'object' || details === null) return undefined;
  const parts: string[] = [];
  for (const [key, label] of Object.entries(FAILURE_DETAIL_LABELS)) {
    const value = (details as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${label} ${value}`);
  }
  return parts.length > 0 ? `(${parts.join(', ')})` : undefined;
}

/** Action feedback text: the server's message plus its non-identifying details. */
export function actionFailureMessage(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : 'The action could not be completed.';
  const details = failureDetails(error);
  return details ? `${message} ${details}` : message;
}
