// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { startClient } from '../../src/client/app';
import type { Role } from '../../src/shared/domain/models';
const volunteer = { id: 'v1', name: 'Alice', email: 'alice@example.test', lifecycleStatus: 'active', interviewStatus: 'complete', readinessRank: 1 };
const center = { id: 'c1', name: 'Authorized Center', active: true };
const session = { id: 's1', kind: 'center', centerId: 'c1', title: 'Morning session', date: '2026-10-06', start: '09:00', end: '10:00', timeZone: 'America/New_York', requiredStaffCount: 1, status: 'locked' };
const assignment = { id: 'a1', sessionId: 's1', volunteerId: 'v1', scheduleRevision: 1, status: 'assigned' };
const base = { dataRevision: 7, schedulingInputRevision: 2 };
let callback: (response: { credential: string }) => void;
let requests: { operation: string; expectedRevision?: number }[];
let roles: Role[];
let confirmAnswer: boolean;
let previewRevision: number;
let configId: string;
let initialized: number;
const click = (label: string) => {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label);
  expect(node, `Missing button ${label}`).toBeDefined(); node!.click();
};
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
async function mount() {
  await startClient({ id: () => 'test-intent', confirm: () => confirmAnswer, prompt: () => '', fetch: async (input, init) => {
    if (input === '/client-config') return new Response(JSON.stringify({ oauthClientId: configId, timeZone: 'America/New_York' }));
    const body = JSON.parse(String(init?.body)) as { operation: string; expectedRevision?: number }; requests.push(body);
    let data: unknown;
    if (body.operation === 'session.me') data = { ...base, user: { id: 'u1', email: volunteer.email, roles, volunteerId: 'v1', centerIds: ['c1'], active: true }, centers: [center] };
    else if (body.operation === 'volunteer.dashboard') data = { ...base, volunteer, assignments: [assignment], recurringAvailability: [], availabilityExceptions: [], sessions: [session] };
    else if (body.operation === 'admin.schedule.read' || body.operation === 'admin.schedule.rerun') data = { ...base, run: null, assignments: [assignment], backups: [], shortfalls: [], sessions: [session, { ...session, id: 's2', title: 'Center session: Another center', requiredStaffCount: 2 }], volunteers: [volunteer], stale: false };
    else if (body.operation === 'admin.schedule.preview') data = { ...base, dataRevision: previewRevision, output: { assignments: [{ sessionId: 's1', volunteerId: 'v1' }], backups: [], shortfalls: [] } };
    else if (body.operation === 'center.candidate.read') data = { ...base, centers: [center], candidates: [] };
    else if (body.operation === 'admin.import.whenIsGood.preview' || body.operation === 'admin.import.whenIsGood.promote') data = {
      ...base, import: { id: 'import1', source: 'whenIsGood', contentHash: 'synthetic', status: body.operation.endsWith('promote') ? 'completed' : 'staged',
        participantCount: 1, matchedCount: 1, unmatched: [], stagedAvailability: [{ id: 'p1', name: volunteer.name, email: null, volunteerId: volunteer.id, intervals: [] }],
        ...(body.operation.endsWith('promote') ? { promotedAt: '2026-10-05T12:00:00Z' } : {}) },
    };
    else if (body.operation === 'admin.insights.read') data = { ...base, leftoverVolunteers: [volunteer], grid: [{ weekday: 1, start: '09:00', end: '10:00', count: 1, volunteers: [volunteer] }] };
    else throw new Error(`Unexpected mutation ${body.operation}`);
    return new Response(JSON.stringify({ ok: true, data }));
  } });
}
beforeEach(() => {
  document.body.replaceChildren(); const app = document.createElement('div'); app.id = 'app'; document.body.append(app);
  requests = []; roles = ['volunteer']; confirmAnswer = false; previewRevision = 7; configId = 'fake.apps.googleusercontent.com'; initialized = 0;
  window.google = { accounts: { id: { initialize(options) { initialized++; callback = options.callback; }, renderButton(node) { node.textContent = 'Google sign-in'; }, disableAutoSelect() {} } } };
});
async function signIn() { await mount(); callback({ credential: 'fake-credential' }); await settle(); }
describe('client DOM behaviors', () => {
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
  it('shows every authorized role tab and hides administrator views for a volunteer', async () => {
    await signIn(); expect(document.querySelector('nav')?.textContent).toContain('My availability'); expect(document.querySelector('nav')?.textContent).not.toContain('Insights');
    roles = ['volunteer', 'administrator', 'center-contact']; await signIn();
    expect(document.querySelector('nav')?.textContent).toContain('Schedule'); expect(document.querySelector('nav')?.textContent).toContain('Center proposals'); expect(document.querySelector('nav')?.textContent).toContain('Insights');
  });
  it('does not send a cancellation when confirmation is dismissed', async () => {
    await signIn(); click('Cancel assignment'); await settle();
    expect(requests.some(item => item.operation === 'volunteer.assignment.cancel')).toBe(false);
  });
  it('publishes with the reviewed preview revision after explicit confirmation', async () => {
    roles = ['administrator']; confirmAnswer = true; await signIn();
    expect(document.querySelector('tbody tr:last-child td:last-child')?.textContent).toBe('2');
    expect(document.querySelector('tbody')?.textContent).not.toContain('Center session:');
    click('Preview schedule'); await settle();
    expect(document.querySelector('tbody tr:last-child td:last-child')?.textContent).toBe('2');
    expect(document.querySelectorAll('table')).toHaveLength(1);
    expect(document.querySelector('h2')?.textContent).toBe('Schedule preview');
    click('Return to published schedule'); await settle();
    expect(document.querySelectorAll('table')).toHaveLength(1);
    expect(document.querySelector('h2')?.textContent).toBe('Session schedule');
    click('Preview schedule'); await settle(); click('Publish reviewed schedule'); await settle();
    expect(requests.find(item => item.operation === 'admin.schedule.rerun')?.expectedRevision).toBe(7);
  });
  it('blocks publication if preview and displayed session revisions differ', async () => {
    roles = ['administrator']; previewRevision = 8; confirmAnswer = true; await signIn(); click('Preview schedule'); await settle();
    const publish = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Publish reviewed schedule'); expect(publish?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Reload this view'); expect(requests.some(item => item.operation === 'admin.schedule.rerun')).toBe(false);
  });
  it('offers only authorized centers and no administrative confirm controls to a contact', async () => {
    roles = ['center-contact']; await signIn();
    const options = [...document.querySelectorAll('option')].map(item => item.textContent);
    expect(options).toContain('Authorized Center'); expect(options).not.toContain('Unauthorized Center'); expect(document.body.textContent).not.toContain('Publish reviewed schedule');
  });
  it('shows numeric heatmap counts and participant details on selection', async () => {
    roles = ['administrator']; await signIn(); click('Insights'); await settle(); click('9:00 AM–10:00 AM · 1'); await settle();
    expect(document.querySelector('.cell-details')?.textContent).toContain('1 volunteers available'); expect(document.querySelector('.cell-details li')?.textContent).toBe('Alice');
  });
  it('imports matched participants together without requiring mapping saves', async () => {
    roles = ['administrator']; confirmAnswer = true; await signIn(); click('Import availability'); await settle();
    const code = document.querySelector<HTMLInputElement>('input'); code!.value = 'synthetic-results';
    const previewForm = code!.closest('form')!; previewForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
    expect(document.body.textContent).toContain('All participants are matched. No mapping changes are needed.');
    expect(document.querySelector('details')?.open).toBe(false);
    click('Import matched availability'); await settle();
    expect(requests.some(item => item.operation === 'admin.import.whenIsGood.promote')).toBe(true);
    expect(requests.some(item => item.operation === 'admin.import.mapping.upsert')).toBe(false);
  });
  it('signs out and removes role views', async () => {
    await signIn(); click('Sign out'); await settle(); expect(document.querySelector('nav')?.textContent).toBe(''); expect(document.body.textContent).toContain('Welcome back');
  });
});
