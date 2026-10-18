import { ApiClient, ApiError } from './api';
import type { Candidate, Session, Volunteer } from '../shared/domain/models';
import { formatSessionTitle } from '../shared/domain/session-label';
import { groupWeeklyScheduleRows, type GroupedScheduleRow, type ScheduleOccurrence } from '../shared/domain/schedule-presentation';
import type { ResultOf } from '../shared/api/schemas';

declare global {
  interface Window { google?: { accounts: { id: { initialize(options: { client_id: string; callback: (response: { credential: string }) => void }): void; renderButton(element: HTMLElement, options: Record<string, unknown>): void; disableAutoSelect(): void } } } }
}
let api: ApiClient;
let app: HTMLDivElement;
let clientFetch: typeof fetch;
let confirmAction: (message: string) => boolean;
let promptAction: (message: string) => string | null;
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const rosterOptionCollator = new Intl.Collator(undefined, { sensitivity: 'base' });
let zone = 'America/New_York';
let me: ResultOf<'session.me'> | undefined;
let activeTab = '';
let pageGeneration = 0;
let viewEdits = 0;
let status: HTMLElement;
let content: HTMLElement;
let nav: HTMLElement;
let signingIn = false;
const hasUnsavedWork = () => !!content.querySelector('form[data-dirty="true"]') || content.dataset.reviewing === 'true';
const syncTime = (value: string | null) => value ? new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Not yet checked';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function append(parent: HTMLElement, ...nodes: (HTMLElement | string)[]) { parent.append(...nodes); return parent; }
function button(label: string, action: () => void | Promise<void>, kind = '') {
  const node = el('button', label, kind); node.type = 'button'; node.addEventListener('click', () => { void execute(action, node); }); return node;
}
async function execute(action: () => void | Promise<void>, control?: HTMLButtonElement) {
  if (control) control.disabled = true;
  status.textContent = ''; status.className = 'status';
  try { await action(); }
  catch (error) {
    if (error instanceof ApiError && error.code === 'UNAUTHORIZED') signOut();
    status.className = 'status error';
    status.textContent = error instanceof ApiError && error.code === 'STALE_REVISION'
      ? 'The schedule or availability changed while you were working. Reload this view, review the latest information, and submit again.'
      : error instanceof ApiError ? error.message : 'Something went wrong. Please reload and try again.';
    status.focus();
  } finally { if (control) control.disabled = false; }
}
function notify(message: string) { status.className = 'status success'; status.textContent = message; }
function card(title: string, description?: string) {
  const node = el('section', '', 'card'); append(node, el('h2', title)); if (description) node.append(el('p', description, 'muted')); return node;
}
function empty(parent: HTMLElement, message: string) { parent.append(el('p', message, 'empty')); }
function field(label: string, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
  const wrapper = el('label', '', 'field'); append(wrapper, el('span', label), control); return wrapper;
}
function input(type: string, value = '', required = true) { const node = el('input'); node.type = type; node.value = value; node.required = required; return node; }
function select(options: [string, string][], value?: string) { const node = el('select'); options.forEach(([key, label]) => { const option = el('option', label); option.value = key; node.append(option); }); if (value !== undefined) node.value = value; return node; }
function markDirty(node: HTMLFormElement) { node.dataset.dirty = 'true'; viewEdits++; }
function form(parent: HTMLElement, label: string, action: () => Promise<void>) {
  const node = el('form', '', 'form'); const submit = el('button', label); submit.type = 'submit';
  for (const event of ['input', 'change']) node.addEventListener(event, () => markDirty(node));
  node.addEventListener('submit', event => { event.preventDefault(); if (node.reportValidity()) void execute(action, submit); });
  parent.append(node); return { node, submit };
}
function validRange(start: HTMLInputElement, end: HTMLInputElement) { end.setCustomValidity(start.value < end.value ? '' : 'End time must be later than start time.'); return end.reportValidity(); }
function table(headers: string[], rows: (HTMLElement | string)[][]) {
  const wrapper = el('div', '', 'table-scroll'); const node = el('table'); const head = el('thead'); const heading = el('tr');
  wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', `Table with ${headers.join(', ')} columns`);
  headers.forEach(title => { const cell = el('th', title); cell.scope = 'col'; heading.append(cell); }); head.append(heading); node.append(head);
  const body = el('tbody'); rows.forEach(row => { const line = el('tr'); row.forEach(value => { const cell = el('td'); cell.append(value); line.append(cell); }); body.append(line); }); node.append(body); wrapper.append(node); return wrapper;
}
const timeText = (time: string) => {
  const [hours, minutes] = time.split(':');
  const hour = Number(hours);
  return `${hour % 12 || 12}:${minutes} ${hour < 12 ? 'AM' : 'PM'}`;
};
const timeRange = (start: string, end: string) => `${timeText(start)}–${timeText(end)}`;
const sessionText = (session: Session, centers: ResultOf<'volunteer.dashboard'>['centers']) => `${formatSessionTitle(session, centers)} · ${session.date} · ${timeRange(session.start, session.end)}`;
const unfilledPlaces = (session: Session, assignedCount: number) => session.status === 'cancelled' ? 0 : Math.max(0, session.requiredStaffCount - assignedCount);
const names = (ids: readonly string[], volunteers: readonly Volunteer[]) => ids.map(id => volunteers.find(volunteer => volunteer.id === id)?.name ?? 'Volunteer').join(', ') || '—';
const sortedRosterOptions = (volunteers: ResultOf<'admin.sync.read'>['volunteers']) => [...volunteers]
  .sort((left, right) => rosterOptionCollator.compare(left.name, right.name)
    || rosterOptionCollator.compare(left.email, right.email)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  .map(volunteer => [volunteer.id, `${volunteer.name} (${volunteer.email})`] as [string, string]);

function shell() {
  app.replaceChildren();
  const header = el('header', '', 'header'); const brand = el('div', '', 'brand');
  const logo = el('img', '', 'brand-logo'); logo.src = '/umd-mindfulness-icon.svg'; logo.alt = ''; logo.width = 48; logo.height = 48;
  append(brand, logo, el('div', 'UMD Mindfulness Society', 'brand-name'));
  const identity = el('div', '', 'identity'); if (me) append(identity, el('span', me.user.email), button('Sign out', signOut, 'quiet'));
  append(header, brand, identity); app.append(header);
  const main = el('main');
  if (me) main.append(el('h1', 'Volunteer scheduling', 'sr-only'));
  else { const intro = el('div', '', 'intro'); intro.append(el('h1', 'Volunteer scheduling')); main.append(intro); }
  status = el('div', '', 'status'); status.role = 'alert'; status.tabIndex = -1; main.append(status);
  nav = el('nav', '', 'tabs'); nav.setAttribute('aria-label', 'Workspace'); main.append(nav); content = el('div', '', 'content'); main.append(content); app.append(main);
}
function signOut() { pageGeneration++; api.signOut(); me = undefined; activeTab = ''; window.google?.accounts.id.disableAutoSelect(); shell(); void signInView(); }
async function signInView() {
  const panel = card('Welcome back', 'Use your society-approved Google account to continue.'); content.append(panel);
  const target = el('div', '', 'google-signin'); panel.append(target);
  let clientId = '';
  try {
    const response = await clientFetch('/client-config'); if (!response.ok) throw new Error();
    const config = await response.json() as { oauthClientId?: unknown; timeZone?: unknown };
    if (typeof config.timeZone === 'string') zone = config.timeZone;
    if (typeof config.oauthClientId === 'string') clientId = config.oauthClientId;
  } catch { empty(panel, 'Sign-in configuration is unavailable. Please reload.'); return; }
  if (!clientId || clientId.includes('placeholder') || clientId.includes('operator') || clientId.startsWith('replace-with-')) { empty(panel, 'Google sign-in is not configured yet. Contact your coordinator.'); return; }
  let attempts = 0;
  const render = () => {
    if (!target.isConnected || me) return;
    if (!window.google) { if (++attempts < 100) window.setTimeout(render, 100); else empty(panel, 'Google sign-in could not load. Check your connection and reload.'); return; }
    window.google.accounts.id.initialize({ client_id: clientId, callback: response => {
      if (signingIn) return;
      signingIn = true;
      void execute(async () => {
        try { api.signIn(response.credential); me = await api.call('session.me', {}); shell(); configureTabs(); }
        finally { signingIn = false; }
      });
    } });
    window.google.accounts.id.renderButton(target, { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with' });
  };
  render();
}
function configureTabs() {
  const roles = me!.user.roles;
  const tabs: [string, string][] = [];
  if (roles.includes('volunteer')) tabs.push(['volunteer', 'My availability']);
  if (roles.includes('administrator')) tabs.push(['schedule', 'Schedule'], ['imports', 'Availability sync'], ['insights', 'Insights']);
  if (roles.includes('administrator') || roles.includes('center-contact')) tabs.push(['candidates', 'Center proposals']);
  tabs.forEach(([key, title]) => {
    const control = button(title, async () => {
      if (key === activeTab) return;
      if (!hasUnsavedWork() || confirmAction('Leave this view and discard your unsaved changes or preview?')) await showTab(key);
    }, 'tab');
    control.dataset.tab = key; nav.append(control);
  });
  nav.append(button('Reload view', () => { if (!hasUnsavedWork() || confirmAction('Reload this view and discard your unsaved changes or preview?')) return refreshView(activeTab); }, 'quiet reload'));
  void execute(async () => { await showTab(tabs[0]?.[0] ?? ''); });
}
// Capture at replacement time: a user can move focus or scroll while a read is in flight.
function replaceView(render: () => void, keepPosition: boolean) {
  const scrollY = window.scrollY; const scrollX = window.scrollX;
  const regions = new Map([...content.querySelectorAll<HTMLElement>('.table-scroll')].map(node => [node.getAttribute('aria-label'), { top: node.scrollTop, left: node.scrollLeft }]));
  const focused = document.activeElement instanceof HTMLElement && content.contains(document.activeElement) ? document.activeElement : undefined;
  const focusKey = focused?.dataset.focusKey;
  const controls = [...content.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]')];
  const focusIndex = focused ? controls.indexOf(focused) : -1;
  const focusLabel = focused?.getAttribute('aria-label');
  content.replaceChildren(); delete content.dataset.reviewing; render();
  if (!keepPosition) return;
  for (const region of content.querySelectorAll<HTMLElement>('.table-scroll')) {
    const saved = regions.get(region.getAttribute('aria-label'));
    if (saved) { region.scrollTop = saved.top; region.scrollLeft = saved.left; }
  }
  const candidates = [...content.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]')];
  const target = focusKey ? candidates.find(node => node.dataset.focusKey === focusKey)
    : focusLabel ? candidates.find(node => node.getAttribute('aria-label') === focusLabel)
    : candidates[focusIndex];
  if (target && target.tagName === focused?.tagName) target.focus({ preventScroll: true });
  window.scrollTo({ top: scrollY, left: scrollX, behavior: 'instant' });
}
async function showTab(tab: string, keepContent = false) {
  activeTab = tab; const generation = ++pageGeneration;
  const editsAtStart = viewEdits;
  const reviewingAtStart = content.dataset.reviewing;
  let painted = false;
  nav.querySelectorAll<HTMLButtonElement>('.tab').forEach(control => control.setAttribute('aria-current', control.dataset.tab === tab ? 'page' : 'false'));
  if (!keepContent) { content.replaceChildren(el('p', 'Loading…', 'empty')); }
  content.setAttribute('aria-busy', 'true');
  const paint = (render: () => void) => {
    if (generation !== pageGeneration) return;
    if (keepContent && (viewEdits !== editsAtStart || content.dataset.reviewing !== reviewingAtStart)) {
      notify('Your newer edits were kept. Reload view when you are ready to review saved data.');
      return;
    }
    replaceView(() => { content.className = 'content'; render(); }, keepContent);
    painted = true;
  };
  try {
    if (tab === 'volunteer') { const data = await api.call('volunteer.dashboard', {}); paint(() => volunteerView(data)); }
    else if (tab === 'schedule') { const data = await api.call('admin.schedule.read', {}); paint(() => scheduleView(data)); }
    else if (tab === 'candidates') { const data = await api.call('center.candidate.read', {}); paint(() => candidatesView(data)); }
    else if (tab === 'insights') { const data = await api.call('admin.insights.read', {}); paint(() => insightsView(data)); }
    else if (tab === 'imports') { const data = await api.call('admin.sync.read', {}); paint(() => importsView(data)); }
  } finally { if (generation === pageGeneration) content.setAttribute('aria-busy', 'false'); }
  return painted;
}
async function refreshView(tab: string, message = '', focusSelector?: string, preserveRosterLinks?: { consumedParticipantId?: string }) {
  const drafts = tab === 'imports' && preserveRosterLinks ? [...content.querySelectorAll<HTMLSelectElement>('form[data-dirty="true"] select[data-participant-id]')]
    .filter(control => control.dataset.participantId !== preserveRosterLinks!.consumedParticipantId)
    .map(control => ({ participantId: control.dataset.participantId!, volunteerId: control.value })) : [];
  const top = content.getBoundingClientRect().top;
  const generation = pageGeneration + 1;
  const painted = await showTab(tab, true);
  if (activeTab !== tab || pageGeneration !== generation) return;
  if (!painted) { window.scrollBy({ top: content.getBoundingClientRect().top - top, behavior: 'instant' }); return; }
  let restored = 0;
  for (const draft of drafts) {
    const control = [...content.querySelectorAll<HTMLSelectElement>('select[data-participant-id]')].find(node => node.dataset.participantId === draft.participantId);
    if (control && [...control.options].some(option => option.value === draft.volunteerId)) {
      control.value = draft.volunteerId; control.closest('form')!.dataset.dirty = 'true'; restored++;
    }
  }
  const preservation = restored ? ` ${restored} unsaved roster link${restored === 1 ? '' : 's'} preserved. Review the latest source details before linking.` : '';
  const invalid = drafts.length > restored ? ' Some link drafts need review because a participant is no longer linkable or a roster record changed.' : '';
  if (message || preservation || invalid) notify(message + preservation + invalid);
  if (focusSelector) {
    const target = content.querySelector<HTMLElement>(focusSelector);
    if (target) { if (!target.matches('button, input, select, textarea')) target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }
  window.scrollBy({ top: content.getBoundingClientRect().top - top, behavior: 'instant' });
}

function volunteerView(data: ResultOf<'volunteer.dashboard'>) {
  content.className = 'content volunteer-workspace';
  const assignments = card('Your assignments'); assignments.classList.add('assignments-panel'); content.append(assignments);
  const rows = data.assignments.filter(item => item.status === 'assigned').map(assignment => {
    const session = data.sessions.find(item => item.id === assignment.sessionId);
    const cancel = button('Cancel assignment', async () => {
      if (!confirmAction(`Cancel your assignment for ${session ? sessionText(session, data.centers) : 'this session'}? This will mark you unavailable for the session and notify the coordinator.`)) return;
      const reason = promptAction('Reason for cancellation (optional):') ?? '';
      await api.call('volunteer.assignment.cancel', { assignmentId: assignment.id, reason }, data.dataRevision); await refreshView('volunteer', 'Assignment cancelled.', '.assignments-panel h2');
    }, 'danger quiet');
    return [session ? assignmentSession(session, data.centers) : 'Session', cancel];
  });
  if (rows.length) assignments.append(table(['Session', 'Action'], rows)); else empty(assignments, 'No assignments.');
  const recurring = card('Weekly availability', 'Update in WhenIsGood. Availability is checked automatically every 30 minutes.'); recurring.append(el('p', `Last successful sync: ${syncTime(data.freshness?.lastSuccessAt ?? null)}.${data.freshness?.problem ? ' The latest check failed; your saved availability is preserved.' : ''}`, 'muted sync-freshness')); content.append(recurring);
  if (data.recurringAvailability.length) {
    const saved = table(['Day', 'Time'], data.recurringAvailability.map(interval => [days[interval.weekday - 1]!, timeRange(interval.start, interval.end)]));
    saved.querySelector('table')?.classList.add('weekly-availability-table'); recurring.append(saved);
  } else empty(recurring, 'No weekly availability saved.');
  const exceptions = card('Date exceptions'); content.append(exceptions);
  const date = input('date'); const kind = select([['unavailable', 'Unavailable'], ['available', 'Available']]); const start = input('time', '09:00'); const end = input('time', '12:00'); const reason = input('text', '', false);
  const exceptionForm = form(exceptions, 'Save exception', async () => {
    if (!validRange(start, end)) return;
    await api.call('volunteer.availability.exception.create', { date: date.value, kind: kind.value as 'available' | 'unavailable', start: start.value, end: end.value, timeZone: zone, reason: reason.value }, data.dataRevision);
    await refreshView('volunteer', 'Exception saved.', '.exception-form button[type=submit]');
  });
  exceptionForm.node.classList.add('exception-form');
  append(exceptionForm.node, field('Date', date), field('Availability', kind), field('From', start), field('Until', end), field('Reason (optional)', reason), exceptionForm.submit);
  [start, end].forEach(control => control.addEventListener('input', () => end.setCustomValidity('')));
  if (data.availabilityExceptions.length) exceptions.append(table(['Date', 'Availability', 'Time', 'Reason'], data.availabilityExceptions.map(item => [item.date, item.kind, timeRange(item.start, item.end), item.reason ?? '—'])));
  else empty(exceptions, 'No exceptions.');
  const upcoming = card('Upcoming sessions'); content.append(upcoming); const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const sessions = data.sessions.filter(session => session.date >= today && session.status !== 'cancelled').sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
  sessions.length ? upcoming.append(table(['Session', 'Date', 'Time', 'Status'], sessions.map(session => [formatSessionTitle(session, data.centers), session.date, timeRange(session.start, session.end), session.status]))) : empty(upcoming, 'No upcoming sessions.');
}

const shortScheduleDate = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
const fullScheduleDate = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

function assignmentSession(session: Session, centers: ResultOf<'admin.schedule.read'>['centers']) {
  const cell = el('div', '', 'schedule-session');
  append(cell, el('span', formatSessionTitle(session, centers), 'session-name'), el('span', `${session.date} · ${timeRange(session.start, session.end)}`, 'session-time'));
  return cell;
}

function scheduleSession(group: GroupedScheduleRow, centers: ResultOf<'admin.schedule.read'>['centers']) {
  const session = group.occurrences[0]!.session;
  const cell = el('div', '', 'schedule-session');
  append(cell, el('span', formatSessionTitle(session, centers), 'session-name'));
  if (group.weekly) {
    append(cell, el('span', `${days[group.weekday - 1]} · ${timeRange(session.start, session.end)}`, 'session-time'));
    const first = group.occurrences[0]!.session.date;
    const last = group.occurrences[group.occurrences.length - 1]!.session.date;
    const details = el('details', '', 'schedule-dates');
    details.append(el('summary', `View ${group.occurrences.length} dates · ${shortScheduleDate.format(new Date(`${first}T12:00:00Z`))} to ${shortScheduleDate.format(new Date(`${last}T12:00:00Z`))}`));
    const dateList = el('ol');
    for (const occurrence of group.occurrences) {
      const actualDate = el('time', fullScheduleDate.format(new Date(`${occurrence.session.date}T12:00:00Z`)));
      actualDate.dateTime = occurrence.session.date;
      const item = el('li'); item.append(actualDate); dateList.append(item);
    }
    details.append(dateList); cell.append(details);
  } else append(cell, el('span', `${session.date} · ${timeRange(session.start, session.end)}`, 'session-time'));
  return cell;
}
function scheduleShortfall(count: number) {
  return el('span', String(count), count > 0 ? 'shortfall has-shortfall' : 'shortfall');
}

type ScheduleAssignmentDisplay = { sessionId: string; volunteerId: string; status?: 'assigned' | 'cancelled' };
type ScheduleBackupDisplay = { sessionId: string; volunteerId: string; position: number; status?: 'available' | 'promoted' | 'skipped' };

function scheduleOccurrences(
  sessions: readonly Session[],
  assignments: readonly ScheduleAssignmentDisplay[],
  backups: readonly ScheduleBackupDisplay[],
): ScheduleOccurrence[] {
  return sessions.map(session => {
    const assignedVolunteerIds = assignments.filter(item => item.sessionId === session.id && (item.status === undefined || item.status === 'assigned')).map(item => item.volunteerId);
    const orderedBackupVolunteerIds = backups.filter(item => item.sessionId === session.id && (item.status === undefined || item.status === 'available'))
      .sort((left, right) => left.position - right.position).map(item => item.volunteerId);
    return { session, assignedVolunteerIds, orderedBackupVolunteerIds, unfilledCount: unfilledPlaces(session, assignedVolunteerIds.length) };
  });
}

function scheduleGroups(sessions: readonly Session[], assignments: readonly ScheduleAssignmentDisplay[], backups: readonly ScheduleBackupDisplay[]) {
  return groupWeeklyScheduleRows(scheduleOccurrences(sessions, assignments, backups));
}

function scheduleView(data: ResultOf<'admin.schedule.read'>) {
  const publishedDescription = data.run ? `Published · Version ${data.run.outputRevision}` : 'Not yet published';
  const schedule = card('Session schedule'); schedule.classList.add('schedule-panel'); content.append(schedule);
  const heading = el('div', '', 'schedule-heading'); heading.append(schedule.querySelector('h2')!);
  const description = el('p', publishedDescription, 'muted'); heading.append(description);
  const toolbar = el('div', '', 'schedule-toolbar'); toolbar.append(heading); schedule.append(toolbar);
  const staleNotice = el('p', 'Sessions or availability changed. Preview the updated schedule before publishing.', 'notice');
  if (data.stale) schedule.append(staleNotice);
  const scheduleArea = el('div'); let previewRevision: number | undefined;
  const publish = button('Publish schedule', async () => { if (previewRevision === undefined) return; if (!confirmAction('Publish this reviewed schedule? This creates a new published schedule.')) return; await api.call('admin.schedule.rerun', {}, previewRevision); await refreshView('schedule', 'The reviewed schedule has been published.', '.schedule-toolbar button'); }); publish.disabled = true; publish.hidden = true;
  const back = button('Back to published schedule', () => renderPublished(), 'quiet'); back.hidden = true;
  const previewButton = button('Preview schedule', async () => {
    const preview = await api.call('admin.schedule.preview', {});
    if (preview.dataRevision !== data.dataRevision) throw new ApiError('STALE_REVISION', 'Reload the schedule and review a new preview.');
    content.dataset.reviewing = 'true';
    previewRevision = preview.dataRevision;
    schedule.querySelector('h2')!.textContent = 'Schedule preview';
    description.textContent = 'Preview · Unpublished changes';
    staleNotice.hidden = true; previewButton.textContent = 'Refresh preview'; previewButton.classList.add('quiet'); back.hidden = false;
    const previewSessions = data.sessions.filter(session => session.status !== 'cancelled');
    scheduleArea.replaceChildren(table(['Session', 'Assigned volunteers', 'Backups (in order)', 'Unfilled'], scheduleGroups(previewSessions, preview.output.assignments, preview.output.backups).map(group => {
      const occurrence = group.occurrences[0]!;
      return [scheduleSession(group, data.centers), names(occurrence.assignedVolunteerIds, data.volunteers), names(occurrence.orderedBackupVolunteerIds, data.volunteers), scheduleShortfall(occurrence.unfilledCount)];
    })));
    publish.disabled = false; publish.hidden = false;
  });
  toolbar.append(append(el('div', '', 'actions'), previewButton, publish, back)); schedule.append(scheduleArea);
  function renderPublished() {
    delete content.dataset.reviewing;
    previewRevision = undefined; publish.disabled = true; publish.hidden = true; back.hidden = true;
    previewButton.textContent = 'Preview schedule'; previewButton.classList.remove('quiet'); schedule.querySelector('h2')!.textContent = 'Session schedule';
    description.textContent = publishedDescription; staleNotice.hidden = false; scheduleArea.replaceChildren();
    if (!data.sessions.length) empty(scheduleArea, 'No sessions have been created. Confirm a center proposal to add one.');
    else scheduleArea.append(table(['Session', 'Status', 'Assigned volunteers', 'Backups (in order)', 'Unfilled'], scheduleGroups(data.sessions, data.assignments, data.backups).map(group => {
      const occurrence = group.occurrences[0]!;
      return [scheduleSession(group, data.centers), occurrence.session.status, names(occurrence.assignedVolunteerIds, data.volunteers), names(occurrence.orderedBackupVolunteerIds, data.volunteers), scheduleShortfall(occurrence.unfilledCount)];
    })));
  }
  renderPublished();
}

function candidatesView(data: ResultOf<'center.candidate.read'>) {
  const administrator = me!.user.roles.includes('administrator');
  const panel = el('section', '', 'card proposals-panel'); content.append(panel);
  let editing: Candidate | undefined;
  const center = select(data.centers.filter(item => item.active).map(item => [item.id, item.name])); const day = select(days.slice(0, 5).map((label, i) => [String(i + 1), label])); const start = input('time', '09:00'); const end = input('time', '10:00'); const staff = select([['0', '0 volunteers'], ['1', '1 volunteer'], ['2', '2 volunteers']], '1'); const heading = el('h2', 'New proposal');
  const editor = form(panel, 'Save proposal', async () => {
    if (!validRange(start, end)) return;
    await api.call('center.candidate.update', { ...(editing ? { candidateId: editing.id } : {}), centerId: center.value, weekday: Number(day.value) as 1 | 2 | 3 | 4 | 5, start: start.value, end: end.value, timeZone: editing?.timeZone ?? zone, requestedStaffCount: Number(staff.value) }, data.dataRevision);
    await refreshView('candidates', 'Proposal saved.', '.proposal-form button[type=submit]');
  });
  editor.node.classList.add('proposal-form');
  const cancelEdit = button('Cancel editing', () => { editing = undefined; delete editor.node.dataset.dirty; heading.textContent = 'New proposal'; editor.submit.textContent = 'Save proposal'; center.value = data.centers.find(item => item.active)?.id ?? ''; day.value = '1'; start.value = '09:00'; end.value = '10:00'; staff.value = '1'; end.setCustomValidity(''); cancelEdit.hidden = true; center.focus(); }, 'quiet'); cancelEdit.hidden = true;
  const proposalActions = el('div', '', 'form-actions'); append(proposalActions, editor.submit, cancelEdit);
  append(editor.node, heading, field('Center', center), field('Weekday', day), field('From', start), field('Until', end), field('Requested staffing', staff), proposalActions);
  [start, end].forEach(control => control.addEventListener('input', () => end.setCustomValidity('')));
  if (!data.centers.some(item => item.active)) { editor.submit.disabled = true; empty(panel, 'No active centers are available for proposals.'); }
  const rows = data.candidates.map(({ candidate, coverage }) => {
    const actions = el('div', '', 'actions');
    if (candidate.status === 'candidate') {
      actions.append(button('Edit', () => { editing = candidate; markDirty(editor.node); heading.textContent = 'Edit proposal'; editor.submit.textContent = 'Save changes'; cancelEdit.hidden = false; end.setCustomValidity(''); center.value = candidate.centerId; day.value = String(candidate.weekday); start.value = candidate.start; end.value = candidate.end; staff.value = String(candidate.requestedStaffCount); start.focus(); editor.node.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' }); }, 'quiet'));
      actions.append(button('Withdraw', async () => { if (!confirmAction('Withdraw this unconfirmed proposal?')) return; await api.call('center.candidate.update', { candidateId: candidate.id, status: 'cancelled' }, data.dataRevision); await refreshView('candidates', 'Proposal withdrawn.', '.proposal-list-heading'); }, 'quiet danger'));
      if (administrator) actions.append(button('Confirm', async () => { if (!confirmAction(`Confirm ${data.centers.find(item => item.id === candidate.centerId)?.name ?? 'this center'} on the next ${days[candidate.weekday - 1]} at ${timeRange(candidate.start, candidate.end)}? This creates the next dated session.`)) return; await api.call('admin.center.candidate.confirm', { candidateId: candidate.id }, data.dataRevision); await refreshView('candidates', 'Proposal confirmed and its next dated session created.', '.proposal-list-heading'); }));
    }
    return [data.centers.find(item => item.id === candidate.centerId)?.name ?? 'Center', `${days[candidate.weekday - 1]} · ${timeRange(candidate.start, candidate.end)}`, String(candidate.requestedStaffCount), `${coverage.volunteers.length} available · ${coverage.shortfall} unfilled`, names(coverage.volunteers.map(item => item.id), coverage.volunteers), candidate.status, actions];
  });
  panel.append(el('h2', 'Submitted proposals', 'proposal-list-heading'));
  if (rows.length) panel.append(table(['Center', 'Time', 'Staff requested', 'Advisory coverage', 'Volunteers', 'Status', 'Actions'], rows)); else empty(panel, 'No proposals.');
}

function importsView(data: ResultOf<'admin.sync.read'>) {
  const panel = card('Availability sync', 'WhenIsGood availability is checked automatically every 30 minutes. Matched volunteers update automatically.'); content.append(panel);
  const last = el('p', `Last successful sync: ${syncTime(data.status.lastSuccessAt)}.`, 'muted sync-freshness'); panel.append(last);
  panel.append(el('p', `Last attempt: ${syncTime(data.status.lastAttemptAt)} · Last availability or participant change: ${syncTime(data.status.effectiveChangeAt)}`, 'muted'));
  const outcome = data.status.outcome === 'never' ? 'Waiting for the first check.' : data.status.outcome === 'failed' ? 'The latest check failed. Saved availability is preserved.' : `${data.status.participantCount} participants · ${data.status.matchedCount} matched · ${data.status.pendingCount} needing attention`;
  panel.append(el('p', outcome, 'notice'));
  if (data.status.diagnostic) panel.append(el('p', data.status.diagnostic, 'status error'));
  if (data.job) {
    const jobMessage = data.job.state === 'queued' ? 'An availability check is queued. Use Reload view to see its result.'
      : data.job.state === 'running' ? 'An availability check is running. Use Reload view to see its result.'
      : data.job.state === 'failed' ? `The latest availability check failed. ${data.job.diagnostic ?? 'Start another check.'}`
      : 'The latest availability check completed.';
    panel.append(el('p', jobMessage, data.job.state === 'failed' ? 'status error' : 'notice'));
  }
  panel.append(button('Sync now', async () => {
    const checked = await api.call('admin.sync.now', {}, data.dataRevision);
    await refreshView('imports', checked.job ? 'Availability check queued. Use Reload view to see its result.' : checked.status.outcome === 'failed' ? 'Sync failed. Saved availability is preserved; see the status for details.' : checked.status.outcome === 'unchanged' ? 'Availability is up to date.' : 'Availability synchronized.', '.content button', {});
  }));
  const pending = card('Participants needing attention', 'Link to an existing roster record. New volunteers must complete the usual enrollment process first; a submission does not grant account access.'); content.append(pending);
  const reasons = { new: 'New submission', ambiguous: 'Conflicting or duplicate identity', 'missing-identity': 'Missing email or identity information', 'unstable-identity': 'Stable source identity needed' };
  if (!data.pending.length) empty(pending, 'All current participants are matched. No links are needed.');
  else {
    const rows = data.pending.map(participant => {
      const participantCell = el('div');
      append(participantCell, el('p', participant.conflictingSubmissions ? 'Conflicting source entries' : participant.name || 'Unnamed participant'), el('p', `WhenIsGood ID: ${participant.id}`, 'muted'));
      if (participant.conflictingSubmissions) {
        const entries = el('details'); entries.append(el('summary', `Show all ${participant.conflictingSubmissions.length} submissions`));
        for (const submission of participant.conflictingSubmissions) entries.append(el('p', `${submission.name || 'Unnamed participant'} · ${submission.email || 'No email'} · ${submission.intervals.map(interval => `${days[interval.weekday - 1]} ${timeRange(interval.start, interval.end)}`).join('; ') || 'No weekly availability submitted'}`));
        participantCell.append(entries);
      }
      const availability = participant.intervals.map(interval => `${days[interval.weekday - 1]} ${timeRange(interval.start, interval.end)}`).join('; ') || 'No weekly availability submitted';
      const action = el('div');
      if (!participant.present) action.append(el('p', 'No longer in the latest results. Saved roster availability is preserved.', 'muted'));
      else if (participant.identityStable === false || !participant.resolvable) action.append(el('p', 'Correct the source identity before linking this submission.', 'muted'));
      else {
        const picker = select([['', 'Choose a volunteer'], ...sortedRosterOptions(data.volunteers)]); picker.required = true; picker.setAttribute('aria-label', `Roster link for ${participant.name || 'unnamed participant'} (WhenIsGood ID: ${participant.id})`); picker.dataset.focusKey = `mapping-${participant.id}`; picker.dataset.participantId = participant.id;
        const mappingForm = form(action, 'Link participant', async () => {
          await api.call('admin.import.mapping.upsert', { sourceParticipantId: participant.id, volunteerId: picker.value }, data.dataRevision);
          await refreshView('imports', 'Participant linked and the latest saved source availability applied.', '.content button', { consumedParticipantId: participant.id });
        });
        append(mappingForm.node, field(`Roster link for ${participant.name || 'unnamed participant'}`, picker), mappingForm.submit);
      }
      return [participantCell, participant.conflictingSubmissions ? 'See source entries' : participant.email || 'No email', participant.conflictingSubmissions ? 'No availability applied. Inspect each source entry.' : availability, `${reasons[participant.reason]}${participant.present ? '' : ' · absent from latest results'}`, action];
    });
    const region = table(['Participant', 'Email', 'Submitted availability', 'Needs attention', 'Roster link'], rows); region.classList.add('pending-participants'); pending.append(region);
  }
  const history = el('details', '', 'card'); history.append(el('summary', `Import history (${data.imports.length})`)); content.append(history);
  if (data.imports.length) history.append(table(['Checked', 'Status', 'Participants', 'Matched'], [...data.imports].reverse().map(run => [syncTime(run.startedAt ?? null), run.status, String(run.participantCount), String(run.matchedCount ?? 0)])));
  else empty(history, 'No import history yet.');
}

function insightsView(data: ResultOf<'admin.insights.read'>) {
  const list = card('Volunteers with time to give', 'Eligible volunteers without a current center assignment.'); content.append(list);
  const sorted = [...data.leftoverVolunteers];
  const order = select([['rank', 'Readiness rank'], ['name', 'Name'], ['email', 'Email']]);
  const rows = el('div'); append(list, field('Sort volunteers by', order), rows);
  function renderRows() {
    sorted.sort((a, b) => order.value === 'rank' ? (a.readinessRank ?? 99) - (b.readinessRank ?? 99) || a.name.localeCompare(b.name) : order.value === 'email' ? a.email.localeCompare(b.email) : a.name.localeCompare(b.name));
    rows.replaceChildren(); sorted.length ? rows.append(table(['Name', 'Email', 'Readiness rank'], sorted.map(item => [item.name, item.email, item.readinessRank === null ? 'Not ranked' : String(item.readinessRank)]))) : empty(rows, 'All eligible volunteers have a center assignment.');
  }
  order.addEventListener('change', renderRows); renderRows();
  const overlap = card('Available together', 'Select a time interval to see volunteer names. The number in each cell shows the available volunteer count.'); content.append(overlap);
  const grid = el('div', '', 'heatmap'); const details = el('div', '', 'cell-details'); details.setAttribute('aria-live', 'polite');
  const maximum = Math.max(1, ...data.grid.map(cell => cell.count));
  for (let day = 1; day <= 5; day++) {
    const column = el('section', '', 'heatmap-column'); column.append(el('h3', days[day - 1]!));
    for (const cell of data.grid.filter(item => item.weekday === day).sort((a, b) => a.start.localeCompare(b.start))) {
      const control = button(`${timeRange(cell.start, cell.end)} · ${cell.count}`, () => { details.replaceChildren(el('h3', `${days[day - 1]} · ${timeRange(cell.start, cell.end)}`), el('p', `${cell.count} volunteers available`)); if (cell.volunteers.length) { const namesList = el('ul'); cell.volunteers.forEach(volunteer => namesList.append(el('li', volunteer.name))); details.append(namesList); } else empty(details, 'No volunteers are available in this interval.'); });
      control.className = 'heatmap-cell'; control.style.backgroundColor = `hsl(145 35% ${96 - (cell.count / maximum) * 34}%)`; control.setAttribute('aria-label', `${days[day - 1]} ${timeText(cell.start)} to ${timeText(cell.end)}, ${cell.count} available volunteers`); column.append(control);
    }
    grid.append(column);
  }
  append(overlap, grid, details);
  if (!data.grid.length) empty(overlap, 'No availability intervals to show.');

  const overlapTable = card('Availability overlap table', 'Each row shows a merged weekday and time interval with its available volunteers.'); content.append(overlapTable);
  if (data.grid.length) {
    const order = select([['weekday', 'Weekday and time'], ['count', 'Available volunteer count (high to low)']], 'weekday');
    const rows = el('div'); append(overlapTable, field('Sort overlap intervals by', order), rows);
    const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    const byWeekdayTime = (a: (typeof data.grid)[number], b: (typeof data.grid)[number]) => a.weekday - b.weekday || compareText(a.start, b.start) || compareText(a.end, b.end);
    const volunteerKey = (cell: (typeof data.grid)[number]) => cell.volunteers.map(volunteer => volunteer.id).sort().join('\0');
    function renderOverlapRows() {
      const sorted = [...data.grid].sort((a, b) => order.value === 'count'
        ? b.count - a.count || byWeekdayTime(a, b) || compareText(volunteerKey(a), volunteerKey(b))
        : byWeekdayTime(a, b) || b.count - a.count || compareText(volunteerKey(a), volunteerKey(b)));
      const rendered = table(['Weekday', 'Time', 'Available volunteers', 'Volunteers'], sorted.map(cell => [
        days[cell.weekday - 1]!, timeRange(cell.start, cell.end), String(cell.count), cell.volunteers.map(volunteer => volunteer.name).join(', ') || '—',
      ]));
      rendered.querySelector('table')?.classList.add('overlap-table');
      rows.replaceChildren(rendered);
    }
    order.addEventListener('change', renderOverlapRows); renderOverlapRows();
    if (data.grid.every(cell => cell.count === 0)) empty(overlapTable, 'No volunteers are available during the listed intervals.');
  } else empty(overlapTable, 'No overlap intervals are available.');
}
export async function startClient(options: { fetch?: typeof fetch; confirm?: (message: string) => boolean; prompt?: (message: string) => string | null; id?: () => string } = {}) {
  pageGeneration++; me = undefined; signingIn = false; activeTab = '';
  clientFetch = options.fetch ?? fetch; api = new ApiClient(clientFetch, options.id);
  confirmAction = options.confirm ?? (message => window.confirm(message)); promptAction = options.prompt ?? (message => window.prompt(message));
  app = document.querySelector<HTMLDivElement>('#app')!; shell(); await execute(signInView);
}
