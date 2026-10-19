import type { Operation } from '../shared/api/operations';
import { decodePayload } from './api/validation';
import type { Snapshot, User } from '../shared/domain/models';
import { formatSessionTitle } from '../shared/domain/session-label';
import type { EmailMessage } from './services/EmailService';

let dateFormat: Intl.DateTimeFormat | undefined;
let timeFormat: Intl.DateTimeFormat | undefined;
const dateText = (date: string) => (dateFormat ??= new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })).format(new Date(`${date}T12:00:00Z`));
const timeText = (time: string) => (timeFormat ??= new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })).format(new Date(`2000-01-01T${time}:00Z`));
const timeRange = (start: string, end: string) => `${timeText(start)}–${timeText(end)} (Eastern Time)`;
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Describe a committed volunteer change using the same saved snapshot as the mutation. */
export function volunteerNotification(operation: Operation, payload: unknown, state: Snapshot, user: User, to: string[]): EmailMessage | undefined {
  if (operation !== 'volunteer.availability.recurring.update' && operation !== 'volunteer.availability.exception.create' && operation !== 'volunteer.assignment.cancel') return;
  const volunteer = state.volunteers.find(item => item.id === user.volunteerId);
  if (!volunteer) return;
  const name = volunteer.name.replace(/[\r\n]+/g, ' ').trim();
  let subject: string, details: string[], nextStep: string;
  if (operation === 'volunteer.availability.exception.create') {
    const exception = decodePayload(operation, payload);
    subject = `Availability updated: ${name}`;
    details = [
      `${name} updated their availability.`, '',
      `${exception.kind === 'available' ? 'Available' : 'Unavailable'}: ${dateText(exception.date)}`,
      `Time: ${timeRange(exception.start, exception.end)}`,
      ...(exception.reason ? [`Reason: ${exception.reason}`] : []),
    ];
    nextStep = 'The change is saved. Review the latest availability in the volunteer scheduler.';
  } else if (operation === 'volunteer.availability.recurring.update') {
    const { intervals } = decodePayload(operation, payload);
    subject = `Weekly availability updated: ${name}`;
    details = [
      `${name} updated their weekly availability.`, '',
      ...(intervals.length ? intervals.map(interval => `${days[interval.weekday - 1]}: ${timeRange(interval.start, interval.end)}`)
        : ['No weekly availability is currently saved.']),
    ];
    nextStep = 'The change is saved. Review the latest availability in the volunteer scheduler.';
  } else {
    const input = decodePayload(operation, payload);
    const assignment = state.assignments.find(item => item.id === input.assignmentId);
    const session = state.sessions.find(item => item.id === assignment?.sessionId);
    subject = `Assignment cancelled: ${name}`;
    details = [
      `${name} cancelled a session assignment.`, '',
      ...(session ? [`Session: ${formatSessionTitle(session, state.centers)}`, `Date: ${dateText(session.date)}`, `Time: ${timeRange(session.start, session.end)}`] : []),
      ...(input.reason ? [`Reason: ${input.reason}`] : []),
    ];
    nextStep = 'The cancellation is saved. Review the schedule for current staffing and backup coverage.';
  }
  return { to, subject, text: [...details, '', `Submitted by: ${user.email}`, '', nextStep, '', 'UMD Mindfulness Society'].join('\n') };
}
