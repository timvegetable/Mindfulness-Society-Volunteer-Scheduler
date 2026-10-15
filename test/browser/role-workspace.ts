import '../../src/client/style.css';
import { Schema } from 'effect';
import { startClient } from '../../src/client/app';
import { payloadSchemas } from '../../src/shared/api/schemas';
import type { Candidate, Snapshot } from '../../src/shared/domain/models';

const role = new URLSearchParams(location.search).get('role') === 'contact' ? 'center-contact' : 'volunteer';
const zone = 'America/New_York';
let revision = 1;
let sequence = 0;
let freshness = { lastSuccessAt: '2026-10-13T12:00:00Z', problem: false };
let updated = false;
let readCount = 0;
const id = () => `synthetic-${++sequence}`;
const center = { id: 'synthetic-center', name: 'North Example Center', active: true };
const volunteer = { id: 'synthetic-volunteer', name: 'Alex Example', email: 'alex@example.test', lifecycleStatus: 'active' as const, interviewStatus: 'complete' as const, readinessRank: 1 };
const session = { id: 'synthetic-session', kind: 'center' as const, centerId: center.id, title: 'Example mindfulness session', date: '2099-10-19', start: '10:00', end: '11:00', timeZone: zone, requiredStaffCount: 1, status: 'locked' as const };
const dashboard: Pick<Snapshot, 'dataRevision' | 'schedulingInputRevision' | 'sessions' | 'assignments' | 'recurringAvailability' | 'availabilityExceptions'> & { volunteer: typeof volunteer } = {
  dataRevision: 1, schedulingInputRevision: 1, volunteer, sessions: [session],
  assignments: [{ id: 'synthetic-assignment', sessionId: session.id, volunteerId: volunteer.id, scheduleRevision: 1, status: 'assigned' }],
  recurringAvailability: [{ id: 'synthetic-recurring', volunteerId: volunteer.id, weekday: 1, start: '09:00', end: '17:00', timeZone: zone }],
  availabilityExceptions: [],
};
const proposals: Candidate[] = [{ id: 'synthetic-proposal', centerId: center.id, weekday: 1, start: '09:00', end: '10:00', timeZone: zone, requestedStaffCount: 1, status: 'candidate' }];
const revisions = () => ({ dataRevision: revision, schedulingInputRevision: revision });
const coverage = (candidate: Candidate) => ({ volunteers: updated ? [volunteer, { ...volunteer, id: 'second', name: 'Second Example', email: 'second@example.test' }] : [volunteer], requestedCount: candidate.requestedStaffCount, shortfall: Math.max(0, candidate.requestedStaffCount - (updated ? 2 : 1)) });
const failure = (code: string, message: string) => Response.json({ ok: false, error: { code, message } });

// A UI simulator: no Worker, database, Google, email, or external fetch calls.
const fixtureFetch: typeof fetch = async (input, init) => {
  if (input === '/client-config') return Response.json({ oauthClientId: 'synthetic.apps.googleusercontent.com', timeZone: zone });
  const latency = Math.min(1000, Math.max(0, Number(new URLSearchParams(location.search).get('latency')) || 0));
  if (latency) await new Promise(resolve => setTimeout(resolve, latency));
  if (input !== '/api') throw new Error('The role UI workspace blocks external requests');
  const request = JSON.parse(String(init?.body));
  const operation = String(request.operation);
  const allowed = role === 'volunteer'
    ? ['volunteer.dashboard', 'volunteer.availability.recurring.update', 'volunteer.availability.exception.create', 'volunteer.assignment.cancel']
    : ['center.candidate.read', 'center.candidate.update'];
  if (operation !== 'session.me' && !allowed.includes(operation)) return failure('FORBIDDEN', 'This operation is not available to this synthetic role.');
  const mutation = !['session.me', 'volunteer.dashboard', 'center.candidate.read'].includes(operation);
  if (!mutation) document.querySelector('#read-count')!.textContent = String(++readCount);
  if (mutation && request.expectedRevision !== revision) return failure('STALE_REVISION', 'Reload before saving changes.');
  let data: object;
  switch (operation) {
    case 'session.me':
      data = { user: { id: 'synthetic-user', email: role === 'volunteer' ? volunteer.email : 'contact@example.test', roles: [role], volunteerId: role === 'volunteer' ? volunteer.id : null, centerIds: role === 'center-contact' ? [center.id] : [], active: true }, centers: [center] }; break;
    case 'volunteer.dashboard': data = { ...dashboard, freshness }; break;
    case 'volunteer.availability.recurring.update': {
      const payload = Schema.decodeUnknownSync(payloadSchemas[operation])(request.payload);
      dashboard.recurringAvailability = payload.intervals.map(interval => ({ ...interval, id: id(), volunteerId: volunteer.id }));
      data = { intervals: dashboard.recurringAvailability }; break;
    }
    case 'volunteer.availability.exception.create': {
      const payload = Schema.decodeUnknownSync(payloadSchemas[operation])(request.payload);
      const exception = { ...payload, id: id(), volunteerId: volunteer.id };
      dashboard.availabilityExceptions.push(exception); data = { exception }; break;
    }
    case 'volunteer.assignment.cancel': {
      const payload = Schema.decodeUnknownSync(payloadSchemas[operation])(request.payload);
      const assignment = dashboard.assignments.find(row => row.id === payload.assignmentId);
      if (!assignment || assignment.status !== 'assigned') return failure('NOT_FOUND', 'Assignment not found.');
      assignment.status = 'cancelled';
      const exception = { id: id(), volunteerId: volunteer.id, date: session.date, kind: 'unavailable' as const, start: session.start, end: session.end, timeZone: zone, reason: payload.reason };
      dashboard.availabilityExceptions.push(exception);
      data = { assignment, exception, promotedAssignment: null, shortfall: { sessionId: session.id, required: 1, assigned: 0, missing: 1 } }; break;
    }
    case 'center.candidate.read': data = { centers: [center], candidates: proposals.map(candidate => ({ candidate, coverage: coverage(candidate) })) }; break;
    case 'center.candidate.update': {
      const payload = Schema.decodeUnknownSync(payloadSchemas[operation])(request.payload);
      if (payload.centerId && payload.centerId !== center.id) return failure('FORBIDDEN', 'This center is outside your synthetic role.');
      let candidate = payload.candidateId ? proposals.find(row => row.id === payload.candidateId) : undefined;
      if (payload.candidateId && !candidate) return failure('NOT_FOUND', 'Proposal not found.');
      if (candidate) {
        if (candidate.status !== 'candidate') return failure('CONFLICT', 'Only unconfirmed proposals can be edited.');
        const { candidateId: _candidateId, ...changes } = payload;
        Object.assign(candidate, changes);
      } else {
        candidate = { id: id(), centerId: center.id, weekday: payload.weekday ?? 1, start: payload.start ?? '09:00', end: payload.end ?? '10:00', timeZone: zone, requestedStaffCount: payload.requestedStaffCount ?? 1, status: 'candidate' };
        proposals.push(candidate);
      }
      data = { candidate, coverage: coverage(candidate) }; break;
    }
    default: return failure('INVALID_REQUEST', 'Unsupported UI simulator operation.');
  }
  if (mutation) revision++;
  return Response.json({ ok: true, data: { ...data, ...revisions() } });
};

const toolbar = document.querySelector<HTMLElement>('#role-check')!;
toolbar.style.cssText = 'padding:1rem;background:#fff;border-bottom:2px solid #245b47;overflow-wrap:anywhere';
toolbar.innerHTML = `<strong>UI testing — fictional data, no sign-in or real saves</strong>
  <p>Changes stay in memory. Switching roles or resetting clears them. Coverage here is simulated; use integration tests to check scheduling rules.</p>
  <label for="test-role">Test role</label> <select id="test-role"><option value="volunteer">Volunteer</option><option value="contact">Center contact</option></select>
  <button id="reset-data" type="button">Reset test data</button>
  <span>API reads: <output id="read-count">0</output></span>
  <button id="source-update" type="button">Simulate source update</button>
  <button id="sync-failure" type="button">Simulate sync failure</button>`;
const rolePicker = document.querySelector<HTMLSelectElement>('#test-role')!;
rolePicker.value = role === 'volunteer' ? 'volunteer' : 'contact';
rolePicker.addEventListener('change', () => { location.search = `?role=${rolePicker.value}`; });
document.querySelector('#reset-data')!.addEventListener('click', () => location.reload());
document.querySelector('#source-update')!.addEventListener('click', () => {
  updated = true; revision++;
  dashboard.recurringAvailability[0]!.end = '18:00';
  freshness = { lastSuccessAt: '2026-10-13T12:05:00Z', problem: false };
});
document.querySelector('#sync-failure')!.addEventListener('click', () => { freshness = { ...freshness, problem: true }; });
window.google = { accounts: { id: {
  initialize({ callback }) { queueMicrotask(() => callback({ credential: 'synthetic-only' })); },
  renderButton() {}, disableAutoSelect() {},
} } };
await startClient({ fetch: fixtureFetch });
