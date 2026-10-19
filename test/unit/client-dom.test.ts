// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { startClient } from '../../src/client/app';
import type { Role, Session, Volunteer } from '../../src/shared/domain/models';
import type { ResultOf } from '../../src/shared/api/schemas';
const volunteer: Volunteer = { id: 'v1', name: 'Alice', email: 'alice@example.test', lifecycleStatus: 'active', interviewStatus: 'complete', readinessRank: 1 };
const secondVolunteer: Volunteer = { id: 'v2', name: 'Bob', email: 'bob@example.test', lifecycleStatus: 'active', interviewStatus: 'complete', readinessRank: 2 };
const thirdVolunteer: Volunteer = { id: 'v3', name: 'Cara', email: 'cara@example.test', lifecycleStatus: 'active', interviewStatus: 'complete', readinessRank: 3 };
const center = { id: 'c1', name: 'Opal Senior Center', active: true };
const sessionCenter = { id: center.id, name: center.name };
const session: Session = { id: 's1', kind: 'center', centerId: 'c1', title: 'opal-senior-center', date: '2099-10-06', start: '09:00', end: '10:00', timeZone: 'America/New_York', requiredStaffCount: 1, status: 'locked' };
const univSession: Session = { ...session, id: 'univ100', kind: 'univ100', centerId: null, title: 'UNIV100: Professor Ada Example (Department: Biology, Room 110, Section 0123)' };
const legacySession = { ...session, id: 'legacy', centerId: null, title: 'Center session: Historical name' };
const assignment: ResultOf<'volunteer.dashboard'>['assignments'][number] = { id: 'a1', sessionId: 's1', volunteerId: 'v1', scheduleRevision: 1, status: 'assigned' };
const univAssignment = { ...assignment, id: 'a2', sessionId: univSession.id };
const base = { dataRevision: 7, schedulingInputRevision: 2 };
let callback: (response: { credential: string }) => void;
let requests: { operation: string; expectedRevision?: number }[];
let roles: Role[];
let confirmAnswer: boolean;
let confirmMessage = '';
let previewRevision: number;
let configId: string;
let initialized: number;
let dashboardRead: Promise<void> | undefined;
let volunteerDashboardOverride: Partial<Pick<ResultOf<'volunteer.dashboard'>, 'assignments' | 'assignmentSessions' | 'sessions' | 'centers'>> | undefined;
let insightsGrid: { weekday: number; start: string; end: string; count: number; volunteers: typeof volunteer[] }[];
let syncPending: ResultOf<'admin.sync.read'>['pending'];
let syncVolunteers: ResultOf<'admin.sync.read'>['volunteers'];
let adminSchedule: ResultOf<'admin.schedule.read'> | undefined;
let previewOutput: ResultOf<'admin.schedule.preview'>['output'] | undefined;
const pendingParticipant = (id: string, name: string): ResultOf<'admin.sync.read'>['pending'][number] => ({
  id, name, email: `${id}@example.test`, intervals: [], reason: 'new', resolvable: true, present: true,
  firstSeenAt: '2026-10-13T12:00:00Z', lastSeenAt: '2026-10-13T12:00:00Z',
});
const click = (label: string) => {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label);
  expect(node, `Missing button ${label}`).toBeDefined(); node!.click();
};
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
async function mount() {
  await startClient({ id: () => 'test-intent', confirm: message => { confirmMessage = message; return confirmAnswer; }, prompt: () => '', fetch: async (input, init) => {
    if (input === '/client-config') return new Response(JSON.stringify({ oauthClientId: configId, timeZone: 'America/New_York' }));
    const body = JSON.parse(String(init?.body)) as { operation: string; expectedRevision?: number }; requests.push(body);
    let data: unknown;
    if (body.operation === 'session.me') data = { ...base, user: { id: 'u1', email: volunteer.email, roles, volunteerId: 'v1', centerIds: ['c1'], active: true }, centers: roles.includes('administrator') || roles.includes('center-contact') ? [center] : [] };
    else if (body.operation === 'volunteer.dashboard') { await dashboardRead; data = { ...base, volunteer, assignments: [assignment], recurringAvailability: [], availabilityExceptions: [], sessions: [session, univSession], assignmentSessions: [session], centers: [sessionCenter], calendarEnabled: false, ...volunteerDashboardOverride }; }
    else if (body.operation === 'admin.schedule.read' || body.operation === 'admin.schedule.rerun') data = adminSchedule ?? { ...base, run: null, assignments: [assignment], backups: [], shortfalls: [], sessions: [legacySession, univSession, session, { ...session, id: 's2', title: 'An older readable label', requiredStaffCount: 2 }], volunteers: [volunteer], centers: [sessionCenter], stale: false };
    else if (body.operation === 'admin.schedule.preview') data = { ...base, dataRevision: previewRevision,
      sessions: adminSchedule?.sessions ?? [legacySession, univSession, session, { ...session, id: 's2', title: 'An older readable label', requiredStaffCount: 2 }],
      output: previewOutput ?? { assignments: [{ sessionId: 's1', volunteerId: 'v1' }], backups: [], shortfalls: [] } };
    else if (body.operation === 'center.candidate.read') data = { ...base, centers: [center], candidates: [] };
    else if (body.operation === 'admin.sync.read' || body.operation === 'admin.sync.now') data = { ...base,
      status: { lastAttemptAt: '2026-10-13T12:00:00Z', lastSuccessAt: '2026-10-13T12:00:00Z', effectiveChangeAt: null, outcome: 'unchanged', diagnostic: null, participantCount: 1, matchedCount: 1, pendingCount: 0 },
      ...(body.operation === 'admin.sync.read' ? { pending: syncPending, imports: [], volunteers: syncVolunteers } : {}) };
    else if (body.operation === 'admin.insights.read') data = { ...base, leftoverVolunteers: [volunteer], grid: insightsGrid };
    else throw new Error(`Unexpected mutation ${body.operation}`);
    return new Response(JSON.stringify({ ok: true, data }));
  } });
}
beforeEach(() => {
  document.body.replaceChildren(); const app = document.createElement('div'); app.id = 'app'; document.body.append(app);
  requests = []; roles = ['volunteer']; confirmAnswer = false; confirmMessage = ''; previewRevision = 7; configId = 'fake.apps.googleusercontent.com'; initialized = 0; dashboardRead = undefined; volunteerDashboardOverride = undefined;
  syncPending = []; syncVolunteers = [{ id: volunteer.id, name: volunteer.name, email: volunteer.email }]; adminSchedule = undefined; previewOutput = undefined;
  insightsGrid = [{ weekday: 1, start: '09:00', end: '10:00', count: 1, volunteers: [volunteer] }];
  window.google = { accounts: { id: { initialize(options) { initialized++; callback = options.callback; }, renderButton(node) { node.textContent = 'Google sign-in'; }, disableAutoSelect() {} } } };
});
async function signIn() { await mount(); callback({ credential: 'fake-credential' }); await settle(); }
describe('client DOM behaviors', () => {
  it('keeps edits entered while Reload view is waiting for saved data', async () => {
    await signIn();
    let release!: () => void;
    dashboardRead = new Promise<void>(resolve => { release = resolve; });
    click('Reload view'); await settle();
    const date = document.querySelector<HTMLInputElement>('input[type=date]')!;
    date.value = '2099-10-20'; date.dispatchEvent(new Event('input', { bubbles: true }));
    release(); await settle();
    expect(document.querySelector<HTMLInputElement>('input[type=date]')?.value).toBe('2099-10-20');
    expect(document.querySelector('[role=alert]')?.textContent).toContain('newer edits were kept');
  });
  it('shows a rejected sign-in explanation and lets the user try again', async () => {
    await startClient({ fetch: async input => new Response(JSON.stringify(input === '/client-config'
      ? { oauthClientId: configId }
      : { ok: false, error: { code: 'UNAUTHORIZED', message: 'This account is not active.' } })) });
    callback({ credential: 'synthetic-credential' }); await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('This account is not active.');
    expect(document.body.textContent).toContain('Welcome back');
    expect(document.querySelector('nav')?.textContent).toBe('');
    await signIn();
    expect(document.querySelector('nav')?.textContent).toContain('My availability');
  });
  it('shows a clear unconfigured state without initializing Google for placeholders', async () => {
    configId = 'replace-with-public-google-client-id'; await mount();
    expect(document.body.textContent).toContain('Google sign-in is not configured yet'); expect(initialized).toBe(0);
  });
  it.each<{ authorizedRoles: Role[]; views: [string, string][] }>([
    { authorizedRoles: ['volunteer'], views: [['My availability', 'Your assignments']] },
    { authorizedRoles: ['administrator'], views: [['Schedule', 'Session schedule'], ['Availability sync', 'Availability sync'], ['Insights', 'Volunteers with time to give'], ['Center proposals', 'New proposal']] },
    { authorizedRoles: ['center-contact'], views: [['Center proposals', 'New proposal']] },
    { authorizedRoles: ['volunteer', 'administrator'], views: [['My availability', 'Your assignments'], ['Schedule', 'Session schedule'], ['Availability sync', 'Availability sync'], ['Insights', 'Volunteers with time to give'], ['Center proposals', 'New proposal']] },
    { authorizedRoles: ['volunteer', 'center-contact'], views: [['My availability', 'Your assignments'], ['Center proposals', 'New proposal']] },
    { authorizedRoles: ['administrator', 'center-contact'], views: [['Schedule', 'Session schedule'], ['Availability sync', 'Availability sync'], ['Insights', 'Volunteers with time to give'], ['Center proposals', 'New proposal']] },
    { authorizedRoles: ['center-contact', 'administrator', 'volunteer'], views: [['My availability', 'Your assignments'], ['Schedule', 'Session schedule'], ['Availability sync', 'Availability sync'], ['Insights', 'Volunteers with time to give'], ['Center proposals', 'New proposal']] },
  ])('navigates and reloads exactly the authorized views for $authorizedRoles', async ({ authorizedRoles, views }) => {
    roles = authorizedRoles; await signIn();
    expect([...document.querySelectorAll('nav button')].map(node => node.textContent)).toEqual([...views.map(([label]) => label), 'Reload view']);
    const currentLabels = () => [...document.querySelectorAll('nav [aria-current="page"]')].map(node => node.textContent);
    expect(currentLabels()).toEqual([views[0]![0]]);
    for (const [label, heading] of views) {
      click(label); await settle();
      expect(currentLabels()).toEqual([label]);
      expect(document.querySelector('.content h2')?.textContent).toBe(heading);
      click('Reload view'); await settle();
      expect(currentLabels()).toEqual([label]);
      expect(document.querySelector('.content h2')?.textContent).toBe(heading);
    }
    click('Sign out'); await settle();
    expect(document.querySelector('nav')?.textContent).toBe('');
    expect(currentLabels()).toEqual([]);
    expect(document.querySelector('.content h2')?.textContent).toBe('Welcome back');
    roles = ['volunteer']; callback({ credential: 'another-credential' }); await settle();
    expect([...document.querySelectorAll('nav button')].map(node => node.textContent)).toEqual(['My availability', 'Reload view']);
    expect(currentLabels()).toEqual(['My availability']);
  });
  it('does not send a cancellation when confirmation is dismissed', async () => {
    await signIn(); click('Cancel assignment'); await settle();
    expect(confirmMessage).toContain('Opal Senior Center');
    expect(confirmMessage).not.toContain('opal-senior-center');
    expect(requests.some(item => item.operation === 'volunteer.assignment.cancel')).toBe(false);
  });
  it('uses referenced center names in volunteer assignments and upcoming sessions', async () => {
    roles = ['volunteer']; await signIn();
    expect(document.querySelector('.assignments-panel tbody')?.textContent).toContain('Opal Senior Center');
    expect(document.querySelector('.assignments-panel tbody')?.textContent).not.toContain('opal-senior-center');
    const upcoming = [...document.querySelectorAll('h2')].find(node => node.textContent === 'Upcoming sessions');
    expect(upcoming?.parentElement?.querySelector('tbody')?.textContent).toContain('Opal Senior Center');
    expect(upcoming?.parentElement?.querySelector('tbody')?.textContent).toContain('UNIV100-0123: Professor Ada Example');
    expect(document.body.textContent).not.toContain('opal-senior-center');
  });
  it('shows started assignments from their assignment details while Upcoming stays future-only', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const startedCenter: Session = { ...session, id: 'started-center', title: 'opal-senior-center', date: today, start: '07:00', end: '08:00' };
    const startedUniv: Session = { ...univSession, id: 'started-univ', date: today, start: '07:00', end: '08:00' };
    const futureSession: Session = { ...session, id: 'future-center', date: '2099-10-06' };
    volunteerDashboardOverride = {
      assignments: [{ ...assignment, sessionId: startedCenter.id }, { ...univAssignment, sessionId: startedUniv.id }],
      assignmentSessions: [startedCenter, startedUniv], sessions: [futureSession], centers: [sessionCenter],
    };
    await signIn();

    const assignmentRows = [...document.querySelectorAll<HTMLTableRowElement>('.assignments-panel tbody tr')];
    expect(assignmentRows).toHaveLength(2);
    expect(assignmentRows[0]?.textContent).toContain('Opal Senior Center');
    expect(assignmentRows[1]?.textContent).toContain('UNIV100-0123: Professor Ada Example');
    expect(assignmentRows.map(row => row.cells[0]?.textContent)).not.toContain('Session');

    const upcoming = [...document.querySelectorAll('h2')].find(node => node.textContent === 'Upcoming sessions');
    const upcomingRows = upcoming?.parentElement?.querySelectorAll('tbody tr');
    expect(upcomingRows).toHaveLength(1);
    expect(upcoming?.parentElement?.querySelector('tbody')?.textContent).toContain('2099-10-06');
    expect(upcoming?.parentElement?.querySelector('tbody')?.textContent).not.toContain('UNIV100-0123: Professor Ada Example');
  });
  it('publishes with the reviewed preview revision after explicit confirmation', async () => {
    roles = ['administrator']; confirmAnswer = true; await signIn();
    expect(document.querySelector('[role=alert]')?.textContent).toBe('');
    expect(document.querySelector('tbody tr:last-child td:last-child')?.textContent).toBe('2');
    expect(document.querySelector('tbody')?.textContent).toContain('Opal Senior Center');
    expect(document.querySelector('tbody')?.textContent).toContain('Historical name');
    expect(document.querySelector('tbody')?.textContent).toContain('UNIV100-0123: Professor Ada Example');
    expect(document.querySelector('tbody')?.textContent).not.toContain('Center session:');
    expect(document.querySelector('tbody')?.textContent).not.toContain('opal-senior-center');
    expect(document.querySelector('tbody')?.textContent).not.toContain('An older readable label');
    click('Preview schedule'); await settle();
    expect(document.querySelector('tbody tr:last-child td:last-child')?.textContent).toBe('2');
    expect(document.querySelector('tbody')?.textContent).toContain('Opal Senior Center');
    expect(document.querySelector('tbody')?.textContent).toContain('Historical name');
    expect(document.querySelector('tbody')?.textContent).toContain('UNIV100-0123: Professor Ada Example');
    expect(document.querySelector('tbody')?.textContent).not.toContain('Center session:');
    expect(document.querySelector('tbody')?.textContent).not.toContain('opal-senior-center');
    expect(document.querySelector('tbody')?.textContent).not.toContain('An older readable label');
    expect(document.querySelectorAll('table')).toHaveLength(1);
    expect(document.querySelector('h2')?.textContent).toBe('Schedule preview');
    click('Back to published schedule'); await settle();
    expect(document.querySelectorAll('table')).toHaveLength(1);
    expect(document.querySelector('h2')?.textContent).toBe('Session schedule');
    click('Preview schedule'); await settle(); click('Publish schedule'); await settle();
    expect(requests.find(item => item.operation === 'admin.schedule.rerun')?.expectedRevision).toBe(7);
  });
  it('groups published rows from published staffing and rebuilds preview groups from preview staffing', async () => {
    roles = ['administrator'];
    const sessions: ResultOf<'admin.schedule.read'>['sessions'] = ['2026-10-02', '2026-10-09', '2026-10-16'].map((date, index) => ({ ...session, id: `weekly-${index}`, date }));
    const publishedBackups = sessions.flatMap(item => [
      { id: `backup-a-${item.id}`, sessionId: item.id, volunteerId: 'v2', scheduleRevision: 1, position: 1, status: 'available' as const },
      { id: `backup-b-${item.id}`, sessionId: item.id, volunteerId: 'v3', scheduleRevision: 1, position: 2, status: 'available' as const },
    ]);
    adminSchedule = { ...base, run: null, sessions, assignments: sessions.map(item => ({ id: `assignment-${item.id}`, sessionId: item.id, volunteerId: 'v1', scheduleRevision: 1, status: 'assigned' as const })), backups: publishedBackups, shortfalls: [], volunteers: [volunteer, secondVolunteer, thirdVolunteer], centers: [sessionCenter], stale: false };
    previewOutput = { assignments: sessions.map((item, index) => ({ sessionId: item.id, volunteerId: index === 1 ? 'v2' : 'v1' })), backups: publishedBackups.map(({ sessionId, volunteerId, position }) => ({ sessionId, volunteerId, position })), shortfalls: [] };
    await signIn();

    const scheduleRows = () => [...document.querySelectorAll('.schedule-panel tbody tr')];
    expect(scheduleRows()).toHaveLength(1);
    expect(scheduleRows()[0]?.textContent).toContain('Friday');
    expect(scheduleRows()[0]?.querySelector('details summary')?.textContent).toContain('3 dates');

    click('Preview schedule'); await settle();
    expect(scheduleRows()).toHaveLength(3);
    expect(document.querySelector('.schedule-panel tbody')?.textContent).toContain('2026-10-09');
    click('Back to published schedule'); await settle();
    expect(scheduleRows()).toHaveLength(1);
    expect(scheduleRows()[0]?.querySelector('details summary')?.textContent).toContain('3 dates');

    previewOutput = {
      assignments: sessions.map(item => ({ sessionId: item.id, volunteerId: 'v1' })),
      backups: sessions.flatMap((item, index) => (index === 1 ? ['v3', 'v2'] : ['v2', 'v3']).map((volunteerId, position) => ({ sessionId: item.id, volunteerId, position: position + 1 }))),
      shortfalls: [],
    };
    click('Preview schedule'); await settle();
    expect(scheduleRows()).toHaveLength(3);
    click('Back to published schedule'); await settle();
    expect(scheduleRows()).toHaveLength(1);
  });
  it('blocks publication if preview and displayed session revisions differ', async () => {
    roles = ['administrator']; previewRevision = 8; confirmAnswer = true; await signIn(); click('Preview schedule'); await settle();
    const publish = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Publish schedule'); expect(publish?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Reload this view'); expect(requests.some(item => item.operation === 'admin.schedule.rerun')).toBe(false);
  });
  it('offers only authorized centers and no administrative confirm controls to a contact', async () => {
    roles = ['center-contact']; await signIn();
    const options = [...document.querySelectorAll('option')].map(item => item.textContent);
    expect(options).toContain('Opal Senior Center'); expect(options).not.toContain('Unauthorized Center'); expect(document.body.textContent).not.toContain('Publish schedule');
  });
  it('shows numeric heatmap counts and participant details on selection', async () => {
    roles = ['administrator']; await signIn(); click('Insights'); await settle(); click('9:00 AM–10:00 AM · 1'); await settle();
    expect(document.querySelector('.cell-details')?.textContent).toContain('1 volunteers available'); expect(document.querySelector('.cell-details li')?.textContent).toBe('Alice');
  });
  it('sorts overlap rows and keeps them aligned with heatmap selection and refreshed data', async () => {
    roles = ['administrator'];
    insightsGrid = [
      { weekday: 5, start: '11:00', end: '12:00', count: 0, volunteers: [] },
      { weekday: 2, start: '08:30', end: '09:00', count: 2, volunteers: [volunteer, thirdVolunteer] },
      { weekday: 1, start: '10:00', end: '11:00', count: 1, volunteers: [volunteer] },
      { weekday: 1, start: '09:00', end: '10:00', count: 2, volunteers: [volunteer, secondVolunteer] },
    ];
    await signIn(); click('Insights'); await settle();

    const overlapTable = () => [...document.querySelectorAll('table')].find(node => node.querySelector('thead')?.textContent?.includes('Weekday'))!;
    const tableRows = () => [...overlapTable().querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent ?? ''));
    expect(overlapTable().closest('.table-scroll')).not.toBeNull();
    expect(overlapTable().classList.contains('overlap-table')).toBe(true);
    expect(tableRows()).toEqual([
      ['Monday', '9:00 AM–10:00 AM', '2', 'Alice, Bob'],
      ['Monday', '10:00 AM–11:00 AM', '1', 'Alice'],
      ['Tuesday', '8:30 AM–9:00 AM', '2', 'Alice, Cara'],
      ['Friday', '11:00 AM–12:00 PM', '0', '—'],
    ]);

    const sort = [...document.querySelectorAll('label.field')].find(label => label.textContent?.includes('Sort overlap intervals by'))?.querySelector('select')!;
    sort.value = 'count'; sort.dispatchEvent(new Event('change', { bubbles: true }));
    expect(tableRows().map(row => [row[0], row[1], row[2]])).toEqual([
      ['Monday', '9:00 AM–10:00 AM', '2'],
      ['Tuesday', '8:30 AM–9:00 AM', '2'],
      ['Monday', '10:00 AM–11:00 AM', '1'],
      ['Friday', '11:00 AM–12:00 PM', '0'],
    ]);
    const selectedRow = tableRows().find(row => row[0] === 'Monday' && row[1] === '9:00 AM–10:00 AM')!;
    click(`${selectedRow[1]} · ${selectedRow[2]}`); await settle();
    expect(document.querySelector('.cell-details h3')?.textContent).toBe(`${selectedRow[0]} · ${selectedRow[1]}`);
    expect(document.querySelector('.cell-details')?.textContent).toContain(`${selectedRow[2]} volunteers available`);
    expect([...document.querySelectorAll('.cell-details li')].map(item => item.textContent)).toEqual(selectedRow[3]!.split(', '));

    insightsGrid = [{ weekday: 3, start: '13:00', end: '14:30', count: 1, volunteers: [thirdVolunteer] }];
    click('Reload view'); await settle();
    const refreshedRow = tableRows()[0]!;
    expect(refreshedRow).toEqual(['Wednesday', '1:00 PM–2:30 PM', '1', 'Cara']);
    expect([...document.querySelectorAll('.heatmap-cell')].map(item => item.getAttribute('aria-label'))).toEqual([`${refreshedRow[0]} ${refreshedRow[1]!.replace('–', ' to ')}, ${refreshedRow[2]} available volunteers`]);
    click(`${refreshedRow[1]} · ${refreshedRow[2]}`); await settle();
    expect([...document.querySelectorAll('.cell-details li')].map(item => item.textContent)).toEqual(refreshedRow[3]!.split(', '));
  });
  it('explains when overlap data is empty or has no available volunteers', async () => {
    roles = ['administrator']; insightsGrid = []; await signIn(); click('Insights'); await settle();
    expect(document.body.textContent).toContain('No availability intervals to show.');
    expect(document.body.textContent).toContain('No overlap intervals are available.');

    insightsGrid = [{ weekday: 1, start: '09:00', end: '09:30', count: 0, volunteers: [] }];
    click('Reload view'); await settle();
    expect(document.body.textContent).toContain('No volunteers are available during the listed intervals.');
    click('9:00 AM–9:30 AM · 0'); await settle();
    expect(document.querySelector('.cell-details')?.textContent).toContain('No volunteers are available in this interval.');
  });
  it('synchronizes matched participants without requiring preview, mapping or promotion', async () => {
    roles = ['administrator']; await signIn(); click('Availability sync'); await settle();
    expect(document.body.textContent).toContain('All current participants are matched. No links are needed.');
    click('Sync now'); await settle();
    expect(document.body.textContent).toContain('Availability is up to date.');
    expect(requests.some(item => item.operation === 'admin.sync.now')).toBe(true);
    expect(requests.some(item => item.operation.includes('promote') || item.operation.includes('whenIsGood.preview'))).toBe(false);
  });

  it('keeps roster link choices alphabetized with deterministic ties in every pending participant picker', async () => {
    roles = ['administrator'];
    syncVolunteers = [
      { id: 'v-z', name: 'alex Morgan', email: 'z@example.test' },
      { id: 'v-tie-z', name: 'Alex Morgan', email: 'a@example.test' },
      { id: 'v-tie-a', name: 'ALEx Morgan', email: 'a@example.test' },
      { id: 'v-last', name: 'zoe Example', email: 'zoe@example.test' },
      { id: 'v-first', name: 'Ada Example', email: 'ada@example.test' },
    ];
    syncPending = [pendingParticipant('p-one', 'New participant one'), pendingParticipant('p-two', 'New participant two')];
    await signIn(); click('Availability sync'); await settle();

    const pickers = [...document.querySelectorAll<HTMLSelectElement>('select[data-participant-id]')];
    expect(pickers).toHaveLength(2);
    for (const picker of pickers) {
      expect([...picker.options].map(option => option.value)).toEqual(['', 'v-first', 'v-tie-a', 'v-tie-z', 'v-z', 'v-last']);
      expect([...picker.options].map(option => option.textContent)).toEqual([
        'Choose a volunteer', 'Ada Example (ada@example.test)', 'ALEx Morgan (a@example.test)',
        'Alex Morgan (a@example.test)', 'alex Morgan (z@example.test)', 'zoe Example (zoe@example.test)',
      ]);
    }
    pickers[0]!.value = 'v-z';
    pickers[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(pickers[0]!.value).toBe('v-z');
  });

  it('signs out and removes role views', async () => {
    await signIn(); click('Sign out'); await settle(); expect(document.querySelector('nav')?.textContent).toBe(''); expect(document.body.textContent).toContain('Welcome back');
  });
});
