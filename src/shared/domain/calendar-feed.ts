import { encodeBase64Url } from '../base64url';
import { instantMilliseconds, sessionsStartingAfter } from './availability';
import { formatSessionTitle } from './session-label';
import { currentAssignments } from './scheduler';
import type { Session, Snapshot } from './models';

const encoder = new TextEncoder();
const calendarName = 'UMD Mindfulness Society assignments';

interface CalendarEvent {
  uid: string;
  sequence: number;
  summary: string;
  start: string;
  end: string;
  status: 'CONFIRMED' | 'CANCELLED';
}

function utcTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function utcValue(session: Session, time: string): string {
  return new Date(instantMilliseconds(session.date, time, session.timeZone)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function stableUid(volunteerId: string, sessionId: string): Promise<string> {
  const bytes = encoder.encode(`${volunteerId}\u0000${sessionId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `${encodeBase64Url(new Uint8Array(digest))}@mindfulness-scheduler`;
}

function escapeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function foldLine(line: string): string {
  const physical: string[] = [];
  let current = '';
  let bytes = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (bytes + size > 75) {
      physical.push(current);
      current = ' ';
      bytes = 1;
    }
    current += character;
    bytes += size;
  }
  physical.push(current);
  return physical.join('\r\n');
}

async function publishedEvents(snapshot: Snapshot, volunteerId: string, now: Date): Promise<CalendarEvent[]> {
  const futureSessionIds = new Set(sessionsStartingAfter(snapshot.sessions, now.getTime()).map((session) => session.id));
  const assignments = currentAssignments(snapshot).filter((row) => row.volunteerId === volunteerId && row.status === 'assigned');
  const active: CalendarEvent[] = [];
  const activeSessions = new Set<string>();
  for (const assignment of assignments) {
    if (activeSessions.has(assignment.sessionId)) continue;
    const session = snapshot.sessions.find((row) => row.id === assignment.sessionId);
    if (!session || session.status === 'cancelled' || !futureSessionIds.has(session.id)) continue;
    activeSessions.add(assignment.sessionId);
    active.push({
      uid: await stableUid(volunteerId, session.id),
      sequence: Math.max(snapshot.dataRevision, assignment.scheduleRevision),
      summary: formatSessionTitle(session, snapshot.centers),
      start: utcValue(session, session.start),
      end: utcValue(session, session.end),
      status: 'CONFIRMED',
    });
  }
  const completedRevisions = new Set(snapshot.schedulingRuns.filter((run) => run.status === 'completed').map((run) => run.outputRevision));
  const cancelled: CalendarEvent[] = [];
  const cancelledSessions = new Set<string>();
  for (const assignment of snapshot.assignments) {
    if (assignment.volunteerId !== volunteerId || !completedRevisions.has(assignment.scheduleRevision)
      || activeSessions.has(assignment.sessionId) || cancelledSessions.has(assignment.sessionId)) continue;
    const session = snapshot.sessions.find((row) => row.id === assignment.sessionId);
    if (!session || !futureSessionIds.has(session.id)) continue;
    cancelledSessions.add(assignment.sessionId);
    cancelled.push({
      uid: await stableUid(volunteerId, session.id),
      sequence: Math.max(snapshot.dataRevision, assignment.scheduleRevision),
      summary: formatSessionTitle(session, snapshot.centers),
      start: utcValue(session, session.start),
      end: utcValue(session, session.end),
      status: 'CANCELLED',
    });
  }
  return [...active, ...cancelled];
}

function serializeEvent(event: CalendarEvent, dtstamp: string): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${event.uid}`, `DTSTAMP:${dtstamp}`, `SEQUENCE:${event.sequence}`, `STATUS:${event.status}`];
  lines.push(`SUMMARY:${escapeText(event.summary)}`, `DTSTART:${event.start}`, `DTEND:${event.end}`);
  lines.push('END:VEVENT');
  return lines;
}

/** Builds the read-only personal feed from the latest completed published schedule. */
export async function serializeCalendarFeed(snapshot: Snapshot, volunteerId: string, now: Date): Promise<string> {
  const dtstamp = utcTimestamp(now);
  const events = await publishedEvents(snapshot, volunteerId, now);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//UMD Mindfulness Society//Volunteer Assignments//EN',
    'CALSCALE:GREGORIAN', `X-WR-CALNAME:${escapeText(calendarName)}`, 'X-WR-TIMEZONE:America/New_York',
    ...events.flatMap((event) => serializeEvent(event, dtstamp)), 'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
