import '../../src/client/style.css';
import { Schema } from 'effect';
import { payloadSchemas } from '../../src/shared/api/schemas';
import { startClient } from '../../src/client/app';
import type { ResultOf } from '../../src/shared/api/schemas';

const revisions = { dataRevision: 1, schedulingInputRevision: 1 };
const center = { id: 'synthetic-center', name: 'Synthetic Center', active: true };
const volunteers = Array.from({ length: 40 }, (_, i) => ({
  id: `synthetic-v${i}`, name: `Synthetic Volunteer ${String(i + 1).padStart(2, '0')}`,
  email: `volunteer${i}@example.test`, lifecycleStatus: 'active' as const,
  interviewStatus: 'complete' as const, readinessRank: i,
}));
const sessions = volunteers.map((_, i) => ({
  id: `synthetic-s${i}`, kind: 'center' as const, centerId: center.id,
  title: `Synthetic session ${i + 1}`, date: '2026-10-06', start: '09:00', end: '10:00',
  timeZone: 'America/New_York', requiredStaffCount: 2, status: 'locked' as const,
}));
const schedule: ResultOf<'admin.schedule.read'> = {
  ...revisions, run: null, sessions, volunteers, assignments: [], backups: [], shortfalls: [], stale: false,
};
const insights: ResultOf<'admin.insights.read'> = {
  ...revisions, leftoverVolunteers: volunteers,
  grid: Array.from({ length: 40 }, (_, i) => {
    const members = volunteers.slice(0, i % 4);
    const hour = 9 + Math.floor(i / 5);
    return { weekday: i % 5 + 1 as 1 | 2 | 3 | 4 | 5, start: `${String(hour).padStart(2, '0')}:00`, end: `${String(hour + 1).padStart(2, '0')}:00`, count: members.length, volunteers: members };
  }).reverse(),
};
const candidates: ResultOf<'center.candidate.read'> = {
  ...revisions, centers: [center], candidates: volunteers.map((_, i) => ({
    candidate: { id: `synthetic-c${i}`, centerId: center.id, weekday: 1, start: '09:00', end: '10:00', timeZone: 'America/New_York', requestedStaffCount: 2, status: 'candidate' },
    coverage: { volunteers: volunteers.slice(0, 2), requestedCount: 2, shortfall: 0 },
  })),
};
let synchronization: ResultOf<'admin.sync.read'> = {
  ...revisions, status: { lastAttemptAt: '2026-10-13T12:00:00Z', lastSuccessAt: '2026-10-13T12:00:00Z', effectiveChangeAt: '2026-10-13T12:00:00Z',
    outcome: 'changed', diagnostic: null, participantCount: 40, matchedCount: 0, pendingCount: 40 },
  pending: volunteers.map(v => ({ id: `p-${v.id}`, name: v.name, email: v.email, intervals: [{ weekday: 1, start: '09:00', end: '10:00', timeZone: 'America/New_York' }],
    reason: 'new', resolvable: true, present: true, firstSeenAt: '2026-10-13T12:00:00Z', lastSeenAt: '2026-10-13T12:00:00Z' })), imports: [], volunteers, mappings: [],
};

if (new URLSearchParams(location.search).has('collision')) {
  const first = synchronization.pending[0]!; const second = synchronization.pending[1]!;
  synchronization = { ...synchronization, status: { ...synchronization.status, pendingCount: 39 }, pending: [
    { ...first, id: 'collision', name: '', email: null, intervals: [], reason: 'ambiguous', resolvable: false,
      conflictingSubmissions: [
        { id: 'collision', name: first.name, email: first.email, intervals: first.intervals },
        { id: 'collision', name: second.name, email: second.email, intervals: [{ weekday: 3, start: '13:00', end: '14:00', timeZone: 'America/New_York' }] },
      ] }, ...synchronization.pending.slice(2),
  ] };
}

const identity: ResultOf<'session.me'> = { ...revisions, user: { id: 'synthetic-admin', email: 'admin@example.test', active: true, roles: ['administrator'], volunteerId: null, centerIds: [center.id] }, centers: [center] };

const readSessions = new URLSearchParams(location.search).has('read-session');
let sessionExchanges = 0, scheduleReads = 0;
let apiReadCount = 0;
const fixtureFetch: typeof fetch = async (input, init) => {
  if (input === '/client-config') return Response.json({ oauthClientId: 'synthetic.apps.googleusercontent.com', timeZone: 'America/New_York' });
  const latency = Math.min(1000, Math.max(0, Number(new URLSearchParams(location.search).get('latency')) || 0));
  if (latency) await new Promise(resolve => setTimeout(resolve, latency));
  if (input !== '/api' && input !== '/api/schedule') throw new Error('Synthetic workspace blocks external requests');
  const request = JSON.parse(String(init?.body));
  const operation = String(request.operation);
  if (operation.endsWith('.read')) document.querySelector('#sync-read-count')!.textContent = String(++apiReadCount);
  let data: unknown;
  switch (operation) {
    case 'admin.sync.read': data = { ...synchronization, ...revisions }; break;
    case 'admin.sync.now': {
      synchronization = { ...synchronization, job: { id: 'synthetic-job', state: 'queued', createdAt: '2026-10-16T12:00:00Z', updatedAt: '2026-10-16T12:00:00Z', diagnostic: null } };
      data = { ...revisions, status: synchronization.status, job: synchronization.job }; break;
    }
    case 'admin.import.mapping.upsert': {
      if (request.expectedRevision !== revisions.dataRevision) return Response.json({ ok: false, error: { code: 'STALE_REVISION', message: 'Reload before saving.' } });
      const payload = Schema.decodeUnknownSync(payloadSchemas[operation])(request.payload);
      const mapping = { id: `mapping-${payload.sourceParticipantId}`, source: 'whenIsGood', ...payload };
      const pending = synchronization.pending.filter(row => row.id !== payload.sourceParticipantId);
      synchronization = { ...synchronization, pending, mappings: [...synchronization.mappings, mapping],
        status: { ...synchronization.status, pendingCount: pending.length, matchedCount: 40 - pending.length } };
      revisions.dataRevision++;
      data = { ...revisions, mapping }; break;
    }
    case 'session.me': {
      sessionExchanges++; document.documentElement.dataset.sessionExchanges = String(sessionExchanges);
      data = readSessions ? { ...identity, scheduleRead: { credential: `read-${sessionExchanges}`, expiresAt: Date.now() + 900000 } } : identity; break;
    }
    case 'admin.schedule.read': {
      if (readSessions && (input !== '/api/schedule' || request.credential !== `read-${sessionExchanges}`)) throw new Error('Incorrect synthetic read protocol');
      document.documentElement.dataset.scheduleReads = String(++scheduleReads);
      data = schedule; break;
    }
    case 'admin.schedule.preview': data = { ...revisions, output: { assignments: [], backups: [], shortfalls: [] } }; break;
    case 'admin.insights.read': data = insights; break;
    case 'center.candidate.read': data = candidates; break;

    default: return Response.json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'This synthetic workspace supports reads and previews only.' } });
  }
  return Response.json({ ok: true, data });
};

const tools = document.querySelector<HTMLElement>('#browser-check')!;
tools.style.cssText = 'padding:1rem;background:#fff;border-bottom:2px solid #245b47;overflow-wrap:anywhere';
tools.innerHTML = `<strong>Synthetic browser workspace — no real data or services</strong><p>Saved-view reads: <span id="sync-read-count">0</span></p>
  <p>Set the expected viewport after resizing, then check each page. Review synchronization and pending participants.</p>
  <label>Expected width <input id="expected-width" type="number" min="1" style="width:7rem"></label>
  <label>Expected height <input id="expected-height" type="number" min="1" style="width:7rem"></label>
  <button id="check-layout" type="button">Check current view</button><pre id="layout-result" aria-live="polite" style="white-space:pre-wrap;max-height:12rem;overflow:auto"></pre>`;
const params = new URLSearchParams(location.search);
for (const dimension of ['width', 'height']) {
  const control = document.querySelector<HTMLInputElement>(`#expected-${dimension}`)!;
  control.value = params.get(dimension) ?? '';
}
document.querySelector('#check-layout')!.addEventListener('click', () => {
  const failures: string[] = [];
  const check = (condition: boolean, message: string) => { if (!condition) failures.push(message); };
  const expectedWidth = Number(document.querySelector<HTMLInputElement>('#expected-width')!.value);
  const expectedHeight = Number(document.querySelector<HTMLInputElement>('#expected-height')!.value);
  check(location.pathname === '/__browser-check', 'Wrong target URL');
  check(innerWidth === expectedWidth && innerHeight === expectedHeight, 'Actual viewport differs from expected dimensions');
  check(document.querySelector('.content')?.getAttribute('aria-busy') === 'false', 'Page has not finished rendering');
  check(document.documentElement.scrollWidth <= document.documentElement.clientWidth, 'Page expands horizontally');
  const regions = [...document.querySelectorAll<HTMLElement>('#app .table-scroll')];
  check(regions.length > 0, 'No table present');
  const tables = regions.map(region => {
    const header = region.querySelector<HTMLElement>('th')!;
    const rows = region.querySelectorAll('tbody tr').length;
    const original = region.scrollTop;
    region.scrollTop = 0;
    const before = header.getBoundingClientRect().top;
    region.scrollTop = region.scrollHeight;
    const sticky = Math.abs(header.getBoundingClientRect().top - before) < 2;
    const style = getComputedStyle(region);
    const expectedRows = document.querySelector('[aria-current="page"]')?.textContent === 'Availability sync' ? synchronization.pending.length : 40;
    check(rows === expectedRows, 'Synthetic row count does not match the current records');
    check(style.overflowY === 'auto' && style.maxHeight !== 'none', 'Bounded scroll CSS is missing or stale');
    check(region.clientHeight <= Math.min(28 * parseFloat(getComputedStyle(document.documentElement).fontSize), innerHeight * .55) + 1, 'Table exceeds height cap');
    check(region.scrollTop > 0 && sticky && getComputedStyle(header).position === 'sticky', 'Table does not scroll with a pinned header');
    check(region.tabIndex === 0 && !!region.getAttribute('aria-label'), 'Scroll region lacks keyboard access or name');
    const evidence = { rows, height: region.clientHeight, contentHeight: region.scrollHeight, width: region.clientWidth, contentWidth: region.scrollWidth, sticky };
    region.scrollTop = original;
    return evidence;
  });
  document.querySelector('#layout-result')!.textContent = JSON.stringify({ result: failures.length ? 'FAIL' : 'PASS', url: location.pathname, viewport: { width: innerWidth, height: innerHeight }, page: document.querySelector('[aria-current="page"]')?.textContent, tables, failures }, null, 2);
});

window.google = { accounts: { id: {
  initialize({ callback }) { queueMicrotask(() => callback({ credential: 'synthetic-only' })); },
  renderButton() {}, disableAutoSelect() {},
} } };
await startClient({ fetch: fixtureFetch, confirm: () => false, prompt: () => null });
