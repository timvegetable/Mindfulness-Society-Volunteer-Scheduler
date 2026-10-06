import { ApiClient, ApiError } from './api';
import type { Candidate, Session, Volunteer, WeeklyInterval } from '../shared/domain/models';
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
let zone = 'America/New_York';
let me: ResultOf<'session.me'> | undefined;
let activeTab = '';
let pageGeneration = 0;
let status: HTMLElement;
let content: HTMLElement;
let nav: HTMLElement;
let signingIn = false;

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
function form(parent: HTMLElement, label: string, action: () => Promise<void>) {
  const node = el('form', '', 'form'); const submit = el('button', label); submit.type = 'submit';
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
const sessionTitle = (title: string) => title.replace(/^Center session:\s*/i, '');
const sessionText = (session: Pick<Session, 'title' | 'date' | 'start' | 'end'>) => `${sessionTitle(session.title)} · ${session.date} · ${timeRange(session.start, session.end)}`;
const unfilledPlaces = (session: Session, assignedCount: number) => session.status === 'cancelled' ? 0 : Math.max(0, session.requiredStaffCount - assignedCount);
const names = (ids: string[], volunteers: readonly Volunteer[]) => ids.map(id => volunteers.find(volunteer => volunteer.id === id)?.name ?? 'Volunteer').join(', ') || '—';

function shell() {
  app.replaceChildren();
  const header = el('header', '', 'header'); const brand = el('div', '', 'brand'); append(brand, el('span', '◌', 'brand-mark'), el('div', 'Mindfulness', 'brand-name'));
  const identity = el('div', '', 'identity'); if (me) append(identity, el('span', me.user.email), button('Sign out', signOut, 'quiet'));
  append(header, brand, identity); app.append(header);
  const main = el('main'); const intro = el('div', '', 'intro'); append(intro, el('p', 'VOLUNTEER COORDINATION', 'eyebrow'), el('h1', me ? 'Make room for meaningful work.' : 'A little time. A lasting difference.'), el('p', me ? 'Plan your time, coordinate sessions, and support your community.' : 'Sign in to manage your availability and help bring mindfulness to your community.', 'lede'));
  main.append(intro); status = el('div', '', 'status'); status.role = 'alert'; status.tabIndex = -1; main.append(status);
  nav = el('nav', '', 'tabs'); nav.setAttribute('aria-label', 'Workspace'); main.append(nav); content = el('div', '', 'content'); main.append(content); app.append(main);
  app.append(el('footer', 'Mindfulness society · Time well shared'));
}
function signOut() { pageGeneration++; api.signOut(); me = undefined; window.google?.accounts.id.disableAutoSelect(); shell(); void signInView(); }
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
  if (roles.includes('administrator')) tabs.push(['schedule', 'Schedule'], ['imports', 'Import availability'], ['insights', 'Insights']);
  if (roles.includes('administrator') || roles.includes('center-contact')) tabs.push(['candidates', 'Center proposals']);
  tabs.forEach(([key, title]) => nav.append(button(title, () => showTab(key), 'tab')));
  nav.append(button('Reload view', () => showTab(activeTab), 'quiet reload'));
  void execute(() => showTab(tabs[0]?.[0] ?? ''));
}
async function showTab(tab: string) {
  activeTab = tab; const generation = ++pageGeneration;
  [...nav.querySelectorAll('.tab')].forEach((node, index) => { const keys = me!.user.roles.includes('volunteer') ? ['volunteer'] : []; if (me!.user.roles.includes('administrator')) keys.push('schedule', 'imports', 'insights'); keys.push('candidates'); node.setAttribute('aria-current', keys[index] === tab ? 'page' : 'false'); });
  content.replaceChildren(el('p', 'Loading…', 'empty')); content.setAttribute('aria-busy', 'true');
  try {
    if (tab === 'volunteer') { const data = await api.call('volunteer.dashboard', {}); if (generation === pageGeneration) { content.replaceChildren(); volunteerView(data); } }
    else if (tab === 'schedule') { const data = await api.call('admin.schedule.read', {}); if (generation === pageGeneration) { content.replaceChildren(); scheduleView(data); } }
    else if (tab === 'candidates') { const data = await api.call('center.candidate.read', {}); if (generation === pageGeneration) { content.replaceChildren(); candidatesView(data); } }
    else if (tab === 'insights') { const data = await api.call('admin.insights.read', {}); if (generation === pageGeneration) { content.replaceChildren(); insightsView(data); } }
    else if (tab === 'imports') { const [identity, schedule] = await Promise.all([api.call('session.me', {}), api.call('admin.schedule.read', {})]); if (generation === pageGeneration) { me = identity; content.replaceChildren(); importsView(identity.dataRevision, schedule.volunteers); } }
  } finally { if (generation === pageGeneration) content.setAttribute('aria-busy', 'false'); }
}

function volunteerView(data: ResultOf<'volunteer.dashboard'>) {
  const assignments = card('Your assignments', `Welcome, ${data.volunteer.name}. Your confirmed commitments are listed below.`); content.append(assignments);
  const rows = data.assignments.filter(item => item.status === 'assigned').map(assignment => {
    const session = data.sessions.find(item => item.id === assignment.sessionId);
    const cancel = button('Cancel assignment', async () => {
      if (!confirmAction(`Cancel your assignment for ${session ? sessionText(session) : 'this session'}? This will mark you unavailable for the session and notify the coordinator.`)) return;
      const reason = promptAction('Reason for cancellation (optional):') ?? '';
      await api.call('volunteer.assignment.cancel', { assignmentId: assignment.id, reason }, data.dataRevision); await showTab('volunteer'); notify('Your assignment cancellation has been saved.');
    }, 'danger quiet');
    return [session ? sessionText(session) : 'Session', cancel];
  });
  if (rows.length) assignments.append(table(['Session', 'Action'], rows)); else empty(assignments, 'No assignments yet. Thank you for keeping your availability up to date.');
  const recurring = card('Weekly availability', 'Add the times you can regularly help. Adjacent intervals will be combined when you save.'); content.append(recurring);
  const edit = form(recurring, 'Save weekly availability', async () => {
    const intervals: WeeklyInterval[] = [];
    for (const row of intervalRows) {
      if (!validRange(row.start, row.end)) return;
      intervals.push({ weekday: Number(row.day.value) as WeeklyInterval['weekday'], start: row.start.value, end: row.end.value, timeZone: row.timeZone });
    }
    await api.call('volunteer.availability.recurring.update', { intervals }, data.dataRevision); await showTab('volunteer'); notify('Your weekly availability has been saved.');
  });
  const list = el('div', '', 'intervals'); const intervalRows: { node: HTMLElement; day: HTMLSelectElement; start: HTMLInputElement; end: HTMLInputElement; timeZone: string }[] = [];
  const addInterval = (interval?: WeeklyInterval) => {
    const node = el('div', '', 'interval-row'); const day = select(days.map((label, i) => [String(i + 1), label]), String(interval?.weekday ?? 1)); const start = input('time', interval?.start ?? '09:00'); const end = input('time', interval?.end ?? '12:00');
    const row = { node, day, start, end, timeZone: interval?.timeZone ?? zone }; intervalRows.push(row);
    append(node, field('Day', day), field('From', start), field('Until', end), button('Remove', () => { intervalRows.splice(intervalRows.indexOf(row), 1); node.remove(); }, 'quiet'));
    list.append(node);
    for (const control of [start, end]) control.addEventListener('input', () => end.setCustomValidity(''));
  };
  data.recurringAvailability.forEach(addInterval); append(edit.node, list, button('Add interval', () => addInterval(), 'quiet'), el('p', 'Saving an empty list clears weekly availability.', 'muted'), edit.submit);
  const exceptions = card('A change of plans', 'Use a dated exception when one day differs from your usual week.'); content.append(exceptions);
  const date = input('date'); const kind = select([['unavailable', 'Unavailable'], ['available', 'Available']]); const start = input('time', '09:00'); const end = input('time', '12:00'); const reason = input('text', '', false);
  const exceptionForm = form(exceptions, 'Save exception', async () => { if (!validRange(start, end)) return; await api.call('volunteer.availability.exception.create', { date: date.value, kind: kind.value as 'available' | 'unavailable', start: start.value, end: end.value, timeZone: zone, reason: reason.value }, data.dataRevision); await showTab('volunteer'); notify('Your dated exception has been saved.'); });
  append(exceptionForm.node, field('Date', date), field('Availability', kind), field('From', start), field('Until', end), field('Reason (optional)', reason), exceptionForm.submit);
  [start, end].forEach(control => control.addEventListener('input', () => end.setCustomValidity('')));
  if (data.availabilityExceptions.length) exceptions.append(table(['Date', 'Availability', 'Time', 'Reason'], data.availabilityExceptions.map(item => [item.date, item.kind, timeRange(item.start, item.end), item.reason ?? '—'])));
  const upcoming = card('Upcoming sessions'); content.append(upcoming); const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const sessions = data.sessions.filter(session => session.date >= today && session.status !== 'cancelled').sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
  sessions.length ? upcoming.append(table(['Session', 'Date', 'Time', 'Status'], sessions.map(session => [sessionTitle(session.title), session.date, timeRange(session.start, session.end), session.status]))) : empty(upcoming, 'No upcoming sessions.');
}

function scheduleView(data: ResultOf<'admin.schedule.read'>) {
  const publishedDescription = data.run ? `Published schedule ${data.run.outputRevision}` : 'No schedule has been published yet.';
  const schedule = card('Session schedule'); content.append(schedule);
  const description = el('p', publishedDescription, 'muted'); schedule.append(description);
  const staleNotice = el('p', 'Availability or sessions have changed since publication. Review a fresh preview before publishing.', 'notice');
  if (data.stale) schedule.append(staleNotice);
  const scheduleArea = el('div'); let previewRevision: number | undefined;
  const publish = button('Publish reviewed schedule', async () => { if (previewRevision === undefined) return; if (!confirmAction('Publish this reviewed schedule? This creates a new published schedule.')) return; await api.call('admin.schedule.rerun', {}, previewRevision); await showTab('schedule'); notify('The reviewed schedule has been published.'); }); publish.disabled = true; publish.hidden = true;
  const back = button('Return to published schedule', () => renderPublished(), 'quiet'); back.hidden = true;
  const previewButton = button('Preview schedule', async () => {
    const preview = await api.call('admin.schedule.preview', {});
    if (preview.dataRevision !== data.dataRevision) throw new ApiError('STALE_REVISION', 'Reload the schedule and review a new preview.');
    previewRevision = preview.dataRevision;
    schedule.querySelector('h2')!.textContent = 'Schedule preview';
    description.textContent = 'Review these proposed assignments. The published schedule changes only when you publish.';
    staleNotice.hidden = true; previewButton.textContent = 'Refresh preview'; back.hidden = false;
    scheduleArea.replaceChildren(table(['Session', 'Assigned volunteers', 'Ordered backups', 'Unfilled places'], data.sessions.filter(session => session.status !== 'cancelled').map(session => [
      sessionText(session), names(preview.output.assignments.filter(item => item.sessionId === session.id).map(item => item.volunteerId), data.volunteers), names(preview.output.backups.filter(item => item.sessionId === session.id).sort((a, b) => a.position - b.position).map(item => item.volunteerId), data.volunteers), String(unfilledPlaces(session, preview.output.assignments.filter(item => item.sessionId === session.id).length)),
    ])));
    publish.disabled = false; publish.hidden = false;
  }, 'quiet');
  append(schedule, append(el('div', '', 'actions'), previewButton, publish, back), scheduleArea);
  function renderPublished() {
    previewRevision = undefined; publish.disabled = true; publish.hidden = true; back.hidden = true;
    previewButton.textContent = 'Preview schedule'; schedule.querySelector('h2')!.textContent = 'Session schedule';
    description.textContent = publishedDescription; staleNotice.hidden = false; scheduleArea.replaceChildren();
    if (!data.sessions.length) empty(scheduleArea, 'No sessions have been created. Confirm a center proposal to add one.');
    else scheduleArea.append(table(['Session', 'Status', 'Assigned volunteers', 'Ordered backups', 'Unfilled places'], data.sessions.map(session => [
      sessionText(session), session.status, names(data.assignments.filter(item => item.sessionId === session.id && item.status === 'assigned').map(item => item.volunteerId), data.volunteers), names(data.backups.filter(item => item.sessionId === session.id && item.status === 'available').sort((a, b) => a.position - b.position).map(item => item.volunteerId), data.volunteers), String(unfilledPlaces(session, data.assignments.filter(item => item.sessionId === session.id && item.status === 'assigned').length)),
    ])));
  }
  renderPublished();
}

function candidatesView(data: ResultOf<'center.candidate.read'>) {
  const administrator = me!.user.roles.includes('administrator');
  const panel = card('Center proposals', 'Propose the next weekday session for your center. Coverage is advisory; confirmation checks the actual upcoming date.'); content.append(panel);
  let editing: Candidate | undefined;
  const center = select(data.centers.filter(item => item.active).map(item => [item.id, item.name])); const day = select(days.slice(0, 5).map((label, i) => [String(i + 1), label])); const start = input('time', '09:00'); const end = input('time', '10:00'); const staff = select([['0', '0 volunteers'], ['1', '1 volunteer'], ['2', '2 volunteers']], '1'); const heading = el('h3', 'New proposal');
  const editor = form(panel, 'Save proposal', async () => {
    if (!validRange(start, end)) return;
    await api.call('center.candidate.update', { ...(editing ? { candidateId: editing.id } : {}), centerId: center.value, weekday: Number(day.value) as 1 | 2 | 3 | 4 | 5, start: start.value, end: end.value, timeZone: editing?.timeZone ?? zone, requestedStaffCount: Number(staff.value) }, data.dataRevision);
    await showTab('candidates'); notify('Proposal saved.');
  });
  append(editor.node, heading, field('Center', center), field('Weekday', day), field('From', start), field('Until', end), field('Requested staffing', staff), editor.submit);
  [start, end].forEach(control => control.addEventListener('input', () => end.setCustomValidity('')));
  if (!data.centers.some(item => item.active)) { editor.submit.disabled = true; empty(panel, 'No active centers are available for proposals.'); }
  const rows = data.candidates.map(({ candidate, coverage }) => {
    const actions = el('div', '', 'actions');
    if (candidate.status === 'candidate') {
      actions.append(button('Edit', () => { editing = candidate; heading.textContent = 'Edit proposal'; center.value = candidate.centerId; day.value = String(candidate.weekday); start.value = candidate.start; end.value = candidate.end; staff.value = String(candidate.requestedStaffCount); start.focus(); editor.node.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 'quiet'));
      actions.append(button('Withdraw', async () => { if (!confirmAction('Withdraw this unconfirmed proposal?')) return; await api.call('center.candidate.update', { candidateId: candidate.id, status: 'cancelled' }, data.dataRevision); await showTab('candidates'); notify('Proposal withdrawn.'); }, 'quiet danger'));
      if (administrator) actions.append(button('Confirm', async () => { if (!confirmAction(`Confirm ${data.centers.find(item => item.id === candidate.centerId)?.name ?? 'this center'} on the next ${days[candidate.weekday - 1]} at ${timeRange(candidate.start, candidate.end)}? This creates the next dated session.`)) return; await api.call('admin.center.candidate.confirm', { candidateId: candidate.id }, data.dataRevision); await showTab('candidates'); notify('Proposal confirmed and its next dated session created.'); }));
    }
    return [data.centers.find(item => item.id === candidate.centerId)?.name ?? 'Center', `${days[candidate.weekday - 1]} · ${timeRange(candidate.start, candidate.end)}`, String(candidate.requestedStaffCount), `${coverage.volunteers.length} available · ${coverage.shortfall} unfilled`, names(coverage.volunteers.map(item => item.id), coverage.volunteers), candidate.status, actions];
  });
  if (rows.length) panel.append(table(['Center', 'Time', 'Staff requested', 'Advisory coverage', 'Volunteers', 'Status', 'Actions'], rows)); else empty(panel, 'No center proposals yet.');
}

function importsView(initialRevision: number, volunteers: readonly Volunteer[]) {
  const panel = card('Import availability', 'Import availability from WhenIsGood. Matching participants are linked automatically.'); content.append(panel);
  let revision = initialRevision;
  let reviewed: ResultOf<'admin.import.whenIsGood.preview'>['import'] | undefined;
  let reviewedCode = '';
  const resultsCode = input('text'); resultsCode.autocomplete = 'off';
  const resultArea = el('div');
  const previewForm = form(panel, 'Preview results', async () => {
    const code = resultsCode.value.trim();
    const result = await api.call('admin.import.whenIsGood.preview', { resultsCode: code }, revision);
    revision = result.dataRevision; reviewed = result.import; reviewedCode = code; renderImport();
  });
  append(previewForm.node, field('WhenIsGood results code', resultsCode), previewForm.submit); panel.append(resultArea);
  resultsCode.addEventListener('input', () => { reviewed = undefined; resultArea.replaceChildren(); });
  function renderImport() {
    if (!reviewed) return;
    const run = reviewed;
    resultArea.replaceChildren(el('h3', 'Import preview'), el('p', `${run.status === 'failed' ? 'Preview failed' : run.promotedAt ? 'Promoted' : 'Ready to import'} · ${run.participantCount ?? run.stagedAvailability.length} participants · ${run.matchedCount ?? 0} matched · ${run.unmatched.length} unmatched`, 'notice'));
    if (run.status === 'failed') { empty(resultArea, `${run.diagnostic || 'This results page could not be parsed.'} Current availability has not changed.`); return; }
    resultArea.append(table(['Participant', 'Email', 'Volunteer', 'Weekly availability'], run.stagedAvailability.map(participant => [participant.name, participant.email ?? '—', volunteers.find(item => item.id === participant.volunteerId)?.name ?? 'Unmatched', participant.intervals.map(interval => `${days[interval.weekday - 1]} ${timeRange(interval.start, interval.end)}`).join('; ') || 'No intervals'])));
    if (run.promotedAt) return;
    const unmatched = run.stagedAvailability.filter(participant => !participant.volunteerId);
    const mappingPanel = card('Unmatched participants', 'Choose a volunteer only for participants who could not be matched automatically.');
    if (unmatched.length) resultArea.append(mappingPanel);
    else resultArea.append(el('p', 'All participants are matched. No mapping changes are needed.', 'muted'));
    const overrides = el('details'); overrides.append(el('summary', 'Change matched volunteers'));
    if (run.stagedAvailability.some(participant => participant.volunteerId)) resultArea.append(overrides);
    for (const participant of run.stagedAvailability) {
      const mappingTarget = participant.volunteerId ? overrides : mappingPanel;
      const picker = select([['', 'Choose a volunteer'], ...volunteers.map(item => [item.id, `${item.name} (${item.email})`] as [string, string])], participant.volunteerId ?? ''); picker.required = true;
      const mappingForm = form(mappingTarget, 'Save mapping', async () => {
        const result = await api.call('admin.import.mapping.upsert', { sourceParticipantId: participant.id, ...(participant.email ? { sourceEmail: participant.email } : {}), ...(participant.name ? { sourceName: participant.name } : {}), volunteerId: picker.value }, revision);
        revision = result.dataRevision;
        const refreshed = await api.call('admin.import.whenIsGood.preview', { resultsCode: reviewedCode }, revision); revision = refreshed.dataRevision; reviewed = refreshed.import; renderImport(); notify('Mapping saved and the import preview refreshed.');
      });
      append(mappingForm.node, field(`${participant.name} → volunteer`, picker), mappingForm.submit);
    }
    const promote = button('Import matched availability', async () => {
      if (!reviewed || reviewedCode !== resultsCode.value.trim()) return;
      if (!confirmAction(`Replace weekly availability for the ${reviewed.matchedCount ?? 0} matched participants? Unmatched participants will not be promoted.`)) return;
      const result = await api.call('admin.import.whenIsGood.promote', { resultsCode: reviewedCode }, revision); revision = result.dataRevision; reviewed = result.import; renderImport(); notify('Matched availability has been promoted.');
    });
    promote.disabled = !!run.promotedAt || !run.matchedCount;
    append(resultArea, el('p', 'Importing replaces weekly availability for all matched volunteers. Unmatched participants are skipped.', 'muted'), promote);
  }
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
