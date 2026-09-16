export type ViewRole = 'volunteer' | 'administrator' | 'center-contact';

export interface AvailabilityInterval {
  id?: string;
  weekday: number;
  start: string;
  end: string;
  timeZone?: string;
}

export interface AvailabilityException {
  id?: string;
  date: string;
  kind: 'unavailable' | 'available';
  start: string;
  end: string;
  reason?: string;
}

export interface VolunteerAssignment {
  id: string;
  sessionId?: string;
  date: string;
  start: string;
  end: string;
  center?: string;
  kind?: string;
  status?: string;
}

export interface VolunteerDashboardData {
  recurringAvailability: AvailabilityInterval[];
  exceptions: AvailabilityException[];
  assignments: VolunteerAssignment[];
  revision?: number | string;
  stale?: boolean;
}

export interface VolunteerDashboardActions {
  onRecurringUpdate?: (intervals: AvailabilityInterval[], expectedRevision: number | string | undefined) => void | Promise<void>;
  onExceptionCreate?: (exception: AvailabilityException, expectedRevision: number | string | undefined) => void | Promise<void>;
  onAssignmentCancel?: (assignmentId: string, reason: string, expectedRevision: number | string | undefined) => void | Promise<void>;
}

export interface ScheduleAssignment {
  id?: string;
  volunteerId?: string;
  volunteerName?: string;
  sessionId?: string;
  date: string;
  start: string;
  end: string;
  center?: string;
  role?: string;
}

export interface ScheduleSession {
  id: string;
  date: string;
  start: string;
  end: string;
  center?: string;
  kind?: string;
  requiredStaffCount?: number;
  assignments?: ScheduleAssignment[];
  backups?: string[];
  shortfall?: number;
  status?: string;
}

export interface AdminScheduleData {
  sessions: ScheduleSession[];
  revision?: number | string;
  inputRevision?: number | string;
  stale?: boolean;
  runStatus?: string;
  diagnostic?: string;
}

export interface AdminScheduleActions {
  onRerun?: (expectedRevision: number | string | undefined) => void | Promise<void>;
}

export interface ImportRunData {
  status?: string;
  resultsCode?: string;
  participantCount?: number;
  matchedCount?: number;
  unmatchedCount?: number;
  diagnostics?: string[];
  preview?: Array<{ name?: string; email?: string; status?: string }>;
  revision?: number | string;
}

export interface AdminImportActions {
  onPreview?: (resultsCode: string) => void | Promise<void>;
  onPromote?: (resultsCode: string, expectedRevision: number | string | undefined) => void | Promise<void>;
}

export interface InsightCell {
  weekday: number;
  start: string;
  end: string;
  count: number;
  volunteerNames?: string[];
}

export interface InsightsData {
  cells: InsightCell[];
  revision?: number | string;
  stale?: boolean;
  generatedAt?: string;
}

export interface AdminInsightsActions {
  onRefresh?: (expectedRevision: number | string | undefined) => void | Promise<void>;
}

export interface CenterCandidate {
  id?: string;
  weekday: number;
  start: string;
  end: string;
  requestedStaffCount: number;
  coverageCount?: number;
  volunteerNames?: string[];
  status?: string;
}

export interface CenterScheduleData {
  centerName?: string;
  candidates: CenterCandidate[];
  revision?: number | string;
}

export interface CenterScheduleActions {
  onCandidateUpdate?: (candidate: Omit<CenterCandidate, 'id' | 'coverageCount' | 'volunteerNames' | 'status'>, expectedRevision: number | string | undefined) => void | Promise<void>;
  onCandidateConfirm?: (candidateId: string, expectedRevision: number | string | undefined) => void | Promise<void>;
}

const WEEKDAY_LABELS: Record<number, string> = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday'
};

function createElement<K extends keyof HTMLElementTagNameMap>(documentRef: Document, tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = documentRef.createElement(tag);
  if (className) element.className = className;
  return element;
}

function appendText<T extends Node>(parent: T, value: unknown): T {
  parent.append(document.createTextNode(String(value ?? '')));
  return parent;
}

function labelledInput(documentRef: Document, labelText: string, type: string, value = ''): { wrapper: HTMLLabelElement; input: HTMLInputElement } {
  const wrapper = createElement(documentRef, 'label', 'field');
  appendText(wrapper, labelText);
  const input = createElement(documentRef, 'input');
  input.type = type;
  input.value = value;
  wrapper.append(input);
  return { wrapper, input };
}

function labelledSelect(documentRef: Document, labelText: string, options: Array<{ value: string; label: string }>, value?: string): { wrapper: HTMLLabelElement; select: HTMLSelectElement } {
  const wrapper = createElement(documentRef, 'label', 'field');
  appendText(wrapper, labelText);
  const select = createElement(documentRef, 'select');
  for (const optionValue of options) {
    const option = createElement(documentRef, 'option');
    option.value = optionValue.value;
    option.textContent = optionValue.label;
    select.append(option);
  }
  if (value !== undefined) select.value = value;
  wrapper.append(select);
  return { wrapper, select };
}

function button(documentRef: Document, label: string, type: 'button' | 'submit' = 'button', className?: string): HTMLButtonElement {
  const control = createElement(documentRef, 'button', className);
  control.type = type;
  control.textContent = label;
  return control;
}

function clear(container: HTMLElement): void {
  while (container.firstChild) container.firstChild.remove();
}

function heading(documentRef: Document, level: 2 | 3, label: string): HTMLHeadingElement {
  const element = createElement(documentRef, level === 2 ? 'h2' : 'h3');
  element.textContent = label;
  return element;
}

function statusNode(documentRef: Document, message = ''): HTMLParagraphElement {
  const status = createElement(documentRef, 'p', 'form-status');
  status.setAttribute('role', 'status');
  status.textContent = message;
  return status;
}

function announceFailure(status: HTMLElement, error: unknown): void {
  status.textContent = error instanceof Error ? error.message : 'The action could not be completed.';
  status.classList.add('error-text');
}

function handleAction(status: HTMLElement, action: (() => void | Promise<void>) | undefined): void {
  if (!action) {
    status.textContent = 'This action is not available right now.';
    return;
  }
  status.classList.remove('error-text');
  status.textContent = 'Saving…';
  try {
    const result = action();
    if (result && typeof (result as Promise<void>).then === 'function') {
      void result.then(() => {
        status.textContent = 'Saved.';
      }).catch((error: unknown) => announceFailure(status, error));
    } else {
      status.textContent = 'Saved.';
    }
  } catch (error) {
    announceFailure(status, error);
  }
}

function revisionLabel(documentRef: Document, revision: number | string | undefined): HTMLParagraphElement | null {
  if (revision === undefined) return null;
  const label = createElement(documentRef, 'p', 'revision-label');
  label.textContent = `Data revision: ${String(revision)}`;
  return label;
}

function intervalText(interval: AvailabilityInterval): string {
  return `${WEEKDAY_LABELS[interval.weekday] ?? `Day ${interval.weekday}`} ${interval.start}–${interval.end}`;
}

function exceptionText(exception: AvailabilityException): string {
  const type = exception.kind === 'available' ? 'available' : 'unavailable';
  return `${exception.date} ${exception.start}–${exception.end} (${type})`;
}

function assignmentText(assignment: VolunteerAssignment): string {
  const place = assignment.center ? ` at ${assignment.center}` : '';
  return `${assignment.date} ${assignment.start}–${assignment.end}${place}`;
}

function weekdayOptions(documentRef: Document, includeWeekend = true): HTMLSelectElement {
  const options = Object.entries(WEEKDAY_LABELS)
    .filter(([value]) => includeWeekend || !['0', '6'].includes(value))
    .map(([value, label]) => ({ value, label }));
  return labelledSelect(documentRef, 'Weekday', options).select;
}

function intervalEditor(documentRef: Document, includeWeekend = true): { wrapper: HTMLDivElement; weekday: HTMLSelectElement; start: HTMLInputElement; end: HTMLInputElement } {
  const wrapper = createElement(documentRef, 'div', 'interval-editor');
  const weekday = weekdayOptions(documentRef, includeWeekend);
  const weekdayLabel = createElement(documentRef, 'label', 'field');
  appendText(weekdayLabel, 'Weekday');
  weekdayLabel.append(weekday);
  wrapper.append(weekdayLabel);
  const start = labelledInput(documentRef, 'Start', 'time').input;
  const end = labelledInput(documentRef, 'End', 'time').input;
  start.required = true;
  end.required = true;
  start.step = '900';
  end.step = '900';
  start.closest('label')?.classList.add('field');
  end.closest('label')?.classList.add('field');
  wrapper.append(start.closest('label') as HTMLLabelElement, end.closest('label') as HTMLLabelElement);
  return { wrapper, weekday, start, end };
}

function parseInterval(editor: { weekday: HTMLSelectElement; start: HTMLInputElement; end: HTMLInputElement }): AvailabilityInterval {
  const weekday = Number(editor.weekday.value);
  const start = editor.start.value;
  const end = editor.end.value;
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !start || !end || start >= end) {
    throw new Error('Choose a weekday and an interval whose end is after its start.');
  }
  return { weekday, start, end };
}

export function renderVolunteerDashboard(
  container: HTMLElement,
  data: VolunteerDashboardData,
  actions: VolunteerDashboardActions = {},
  documentRef: Document = container.ownerDocument
): void {
  clear(container);
  container.append(heading(documentRef, 2, 'My scheduling dashboard'));
  const intro = createElement(documentRef, 'p');
  intro.textContent = 'Manage your weekly availability, report one-off changes, and review future assignments.';
  container.append(intro);
  const revision = revisionLabel(documentRef, data.revision);
  if (revision) container.append(revision);
  if (data.stale) {
    const alert = createElement(documentRef, 'p', 'alert warning');
    alert.setAttribute('role', 'status');
    alert.textContent = 'The current schedule needs an administrator rerun after an availability change.';
    container.append(alert);
  }

  const recurringSection = createElement(documentRef, 'section', 'panel');
  recurringSection.append(heading(documentRef, 3, 'Weekly recurring availability'));
  const recurringList = createElement(documentRef, 'ul', 'interval-list');
  if (data.recurringAvailability.length === 0) {
    const empty = createElement(documentRef, 'li');
    empty.textContent = 'No recurring availability has been saved.';
    recurringList.append(empty);
  } else {
    for (const interval of data.recurringAvailability) {
      const item = createElement(documentRef, 'li');
      item.textContent = intervalText(interval);
      recurringList.append(item);
    }
  }
  recurringSection.append(recurringList);
  const recurringForm = createElement(documentRef, 'form', 'stacked-form');
  recurringForm.noValidate = false;
  const editor = intervalEditor(documentRef);
  recurringForm.append(editor.wrapper);
  const add = button(documentRef, 'Add interval');
  const intervalDrafts = data.recurringAvailability.map((interval) => ({ ...interval }));
  const draftList = createElement(documentRef, 'ul', 'draft-list');
  const formStatus = statusNode(documentRef);
  const drawDrafts = (): void => {
    while (draftList.firstChild) draftList.firstChild.remove();
    for (const [index, draft] of intervalDrafts.entries()) {
      const item = createElement(documentRef, 'li');
      item.textContent = intervalText(draft);
      const remove = button(documentRef, 'Remove');
      remove.addEventListener('click', () => {
        intervalDrafts.splice(index, 1);
        drawDrafts();
      });
      item.append(remove);
      draftList.append(item);
    }
  };
  add.addEventListener('click', () => {
    try {
      intervalDrafts.push(parseInterval(editor));
      drawDrafts();
      formStatus.textContent = '';
      formStatus.classList.remove('error-text');
    } catch (error) {
      announceFailure(formStatus, error);
    }
  });
  const save = button(documentRef, 'Save weekly availability', 'submit', 'primary-button');
  recurringForm.append(add, draftList, save, formStatus);
  recurringForm.addEventListener('submit', (event) => {
    event.preventDefault();
    handleAction(formStatus, actions.onRecurringUpdate ? () => actions.onRecurringUpdate?.(intervalDrafts, data.revision) : undefined);
  });
  drawDrafts();
  recurringSection.append(recurringForm);
  container.append(recurringSection);

  const exceptionSection = createElement(documentRef, 'section', 'panel');
  exceptionSection.append(heading(documentRef, 3, 'One-off dated changes'));
  const exceptionList = createElement(documentRef, 'ul', 'interval-list');
  if (data.exceptions.length === 0) {
    const empty = createElement(documentRef, 'li');
    empty.textContent = 'No dated exceptions have been saved.';
    exceptionList.append(empty);
  } else {
    for (const exception of data.exceptions) {
      const item = createElement(documentRef, 'li');
      item.textContent = `${exceptionText(exception)}${exception.reason ? ` — ${exception.reason}` : ''}`;
      exceptionList.append(item);
    }
  }
  exceptionSection.append(exceptionList);
  const exceptionForm = createElement(documentRef, 'form', 'stacked-form');
  const date = labelledInput(documentRef, 'Date', 'date').input;
  date.required = true;
  const exceptionStart = labelledInput(documentRef, 'Start', 'time').input;
  const exceptionEnd = labelledInput(documentRef, 'End', 'time').input;
  exceptionStart.required = true;
  exceptionEnd.required = true;
  const kind = labelledSelect(documentRef, 'Change', [
    { value: 'unavailable', label: 'Unavailable' },
    { value: 'available', label: 'Available instead' }
  ]).select;
  const reason = labelledInput(documentRef, 'Reason (optional)', 'text').input;
  reason.maxLength = 240;
  exceptionForm.append(date.closest('label') as HTMLLabelElement, kind.closest('label') as HTMLLabelElement, exceptionStart.closest('label') as HTMLLabelElement, exceptionEnd.closest('label') as HTMLLabelElement, reason.closest('label') as HTMLLabelElement);
  const exceptionStatus = statusNode(documentRef);
  const exceptionSave = button(documentRef, 'Save dated change', 'submit', 'primary-button');
  exceptionForm.append(exceptionSave, exceptionStatus);
  exceptionForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const exception: AvailabilityException = { date: date.value, kind: kind.value === 'available' ? 'available' : 'unavailable', start: exceptionStart.value, end: exceptionEnd.value, reason: reason.value.trim() || undefined };
    if (!exception.date || !exception.start || !exception.end || exception.start >= exception.end) {
      announceFailure(exceptionStatus, new Error('Choose a date and an interval whose end is after its start.'));
      return;
    }
    handleAction(exceptionStatus, actions.onExceptionCreate ? () => actions.onExceptionCreate?.(exception, data.revision) : undefined);
  });
  exceptionSection.append(exceptionForm);
  container.append(exceptionSection);

  const assignmentSection = createElement(documentRef, 'section', 'panel');
  assignmentSection.append(heading(documentRef, 3, 'Future assignments'));
  if (data.assignments.length === 0) {
    const empty = createElement(documentRef, 'p');
    empty.textContent = 'You have no future assignments.';
    assignmentSection.append(empty);
  } else {
    const list = createElement(documentRef, 'div', 'assignment-list');
    for (const assignment of data.assignments) {
      const item = createElement(documentRef, 'article', 'assignment-card');
      const title = createElement(documentRef, 'h4');
      title.textContent = assignmentText(assignment);
      item.append(title);
      if (assignment.kind || assignment.status) {
        const meta = createElement(documentRef, 'p', 'muted');
        meta.textContent = [assignment.kind, assignment.status].filter(Boolean).join(' · ');
        item.append(meta);
      }
      const cancelForm = createElement(documentRef, 'form', 'inline-form');
      const cancelReason = labelledInput(documentRef, 'Reason (optional)', 'text').input;
      cancelReason.maxLength = 240;
      const cancel = button(documentRef, 'Cancel assignment');
      const cancelStatus = statusNode(documentRef);
      cancelForm.append(cancelReason.closest('label') as HTMLLabelElement, cancel, cancelStatus);
      cancelForm.addEventListener('submit', (event) => {
        event.preventDefault();
        handleAction(cancelStatus, actions.onAssignmentCancel ? () => actions.onAssignmentCancel?.(assignment.id, cancelReason.value.trim(), data.revision) : undefined);
      });
      item.append(cancelForm);
      list.append(item);
    }
    assignmentSection.append(list);
  }
  container.append(assignmentSection);
}

function scheduleSessionText(session: ScheduleSession): string {
  return `${session.date} ${session.start}–${session.end}${session.center ? ` — ${session.center}` : ''}`;
}

export function renderAdminSchedule(
  container: HTMLElement,
  data: AdminScheduleData,
  actions: AdminScheduleActions = {},
  documentRef: Document = container.ownerDocument
): void {
  clear(container);
  container.append(heading(documentRef, 2, 'Schedule administration'));
  const toolbar = createElement(documentRef, 'div', 'toolbar');
  const rerun = button(documentRef, data.stale ? 'Rerun scheduling' : 'Run scheduling', 'button', 'primary-button');
  const status = statusNode(documentRef, data.runStatus ?? '');
  rerun.addEventListener('click', () => handleAction(status, actions.onRerun ? () => actions.onRerun?.(data.inputRevision ?? data.revision) : undefined));
  toolbar.append(rerun, status);
  container.append(toolbar);
  if (data.stale) {
    const alert = createElement(documentRef, 'p', 'alert warning');
    alert.textContent = 'Schedule is stale because an input changed. Review and rerun deliberately.';
    container.append(alert);
  }
  const revision = revisionLabel(documentRef, data.revision);
  if (revision) container.append(revision);
  if (data.inputRevision !== undefined) {
    const inputRevision = createElement(documentRef, 'p', 'muted');
    inputRevision.textContent = `Input revision: ${String(data.inputRevision)}`;
    container.append(inputRevision);
  }
  if (data.diagnostic) {
    const diagnostic = createElement(documentRef, 'p', 'alert error');
    diagnostic.setAttribute('role', 'alert');
    diagnostic.textContent = data.diagnostic;
    container.append(diagnostic);
  }
  const table = createElement(documentRef, 'table', 'data-table');
  const caption = createElement(documentRef, 'caption');
  caption.textContent = 'Assignments, backups, and staffing shortfalls';
  table.append(caption);
  const head = createElement(documentRef, 'thead');
  const headRow = createElement(documentRef, 'tr');
  for (const label of ['Session', 'Required', 'Assigned volunteers', 'Ordered backups', 'Status']) {
    const cell = createElement(documentRef, 'th');
    cell.scope = 'col';
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);
  const body = createElement(documentRef, 'tbody');
  if (data.sessions.length === 0) {
    const row = createElement(documentRef, 'tr');
    const cell = createElement(documentRef, 'td');
    cell.colSpan = 5;
    cell.textContent = 'No sessions are available in this revision.';
    row.append(cell);
    body.append(row);
  } else {
    for (const session of data.sessions) {
      const row = createElement(documentRef, 'tr');
      const sessionCell = createElement(documentRef, 'th');
      sessionCell.scope = 'row';
      sessionCell.textContent = scheduleSessionText(session);
      const required = createElement(documentRef, 'td');
      required.textContent = String(session.requiredStaffCount ?? 0);
      const assigned = createElement(documentRef, 'td');
      assigned.textContent = session.assignments?.map((entry) => entry.volunteerName ?? entry.volunteerId ?? 'Assigned volunteer').join(', ') || 'None';
      const backups = createElement(documentRef, 'td');
      backups.textContent = session.backups?.join(', ') || 'None';
      const state = createElement(documentRef, 'td');
      const shortfall = session.shortfall ?? Math.max(0, (session.requiredStaffCount ?? 0) - (session.assignments?.length ?? 0));
      state.textContent = shortfall > 0 ? `Understaffed by ${shortfall}` : (session.status ?? 'Staffed');
      if (shortfall > 0) state.className = 'error-text';
      row.append(sessionCell, required, assigned, backups, state);
      body.append(row);
    }
  }
  table.append(body);
  container.append(table);
}

export function renderAdminImport(
  container: HTMLElement,
  data: ImportRunData = {},
  actions: AdminImportActions = {},
  expectedRevision?: number | string,
  documentRef: Document = container.ownerDocument
): void {
  clear(container);
  container.append(heading(documentRef, 2, 'WhenIsGood import'));
  const description = createElement(documentRef, 'p');
  description.textContent = 'Preview a complete source result before promoting it. A failed parse never replaces the last successful import.';
  container.append(description);
  const form = createElement(documentRef, 'form', 'toolbar');
  const codeField = labelledInput(documentRef, 'Results code', 'text', data.resultsCode ?? '');
  codeField.input.required = true;
  codeField.input.autocomplete = 'off';
  codeField.input.maxLength = 200;
  const preview = button(documentRef, 'Preview import');
  const promote = button(documentRef, 'Promote valid import', 'submit', 'primary-button');
  const status = statusNode(documentRef, data.status ?? '');
  form.append(codeField.wrapper, preview, promote, status);
  container.append(form);
  preview.addEventListener('click', () => {
    if (!codeField.input.value.trim()) {
      announceFailure(status, new Error('Enter a WhenIsGood results code.'));
      return;
    }
    handleAction(status, actions.onPreview ? () => actions.onPreview?.(codeField.input.value.trim()) : undefined);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!codeField.input.value.trim()) {
      announceFailure(status, new Error('Enter a WhenIsGood results code.'));
      return;
    }
    handleAction(status, actions.onPromote ? () => actions.onPromote?.(codeField.input.value.trim(), expectedRevision) : undefined);
  });
  if (data.participantCount !== undefined || data.matchedCount !== undefined || data.unmatchedCount !== undefined) {
    const counts = createElement(documentRef, 'dl', 'summary-grid');
    for (const [label, value] of [['Participants', data.participantCount], ['Matched', data.matchedCount], ['Unmatched', data.unmatchedCount]] as const) {
      if (value === undefined) continue;
      const term = createElement(documentRef, 'dt');
      term.textContent = label;
      const descriptionNode = createElement(documentRef, 'dd');
      descriptionNode.textContent = String(value);
      counts.append(term, descriptionNode);
    }
    container.append(counts);
  }
  if (data.diagnostics && data.diagnostics.length > 0) {
    const diagnostics = createElement(documentRef, 'section', 'panel');
    diagnostics.append(heading(documentRef, 3, 'Diagnostics'));
    const list = createElement(documentRef, 'ul');
    for (const detail of data.diagnostics) {
      const item = createElement(documentRef, 'li');
      item.textContent = detail;
      list.append(item);
    }
    diagnostics.append(list);
    container.append(diagnostics);
  }
  if (data.preview && data.preview.length > 0) {
    const table = createElement(documentRef, 'table', 'data-table');
    const caption = createElement(documentRef, 'caption');
    caption.textContent = 'Import preview';
    table.append(caption);
    const row = createElement(documentRef, 'tr');
    for (const label of ['Participant', 'Email', 'Match status']) {
      const cell = createElement(documentRef, 'th');
      cell.scope = 'col';
      cell.textContent = label;
      row.append(cell);
    }
    const thead = createElement(documentRef, 'thead');
    thead.append(row);
    table.append(thead);
    const tbody = createElement(documentRef, 'tbody');
    for (const participant of data.preview) {
      const participantRow = createElement(documentRef, 'tr');
      for (const value of [participant.name ?? 'Unknown participant', participant.email ?? 'Not provided', participant.status ?? 'Unmatched']) {
        const cell = createElement(documentRef, 'td');
        cell.textContent = value;
        participantRow.append(cell);
      }
      tbody.append(participantRow);
    }
    table.append(tbody);
    container.append(table);
  }
}

function cellStart(cell: InsightCell): number {
  const [hours, minutes] = cell.start.split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function insightCellLabel(cell: InsightCell): string {
  return `${WEEKDAY_LABELS[cell.weekday] ?? `Day ${cell.weekday}`} ${cell.start}–${cell.end}, ${cell.count} volunteer${cell.count === 1 ? '' : 's'}`;
}

export function renderAdminInsights(
  container: HTMLElement,
  data: InsightsData,
  actions: AdminInsightsActions = {},
  showVolunteerDetails = true,
  documentRef: Document = container.ownerDocument
): void {
  clear(container);
  container.append(heading(documentRef, 2, 'Unused recurring availability'));
  const intro = createElement(documentRef, 'p');
  intro.textContent = 'These windows are derived from active, ranked volunteers without assignments in one consistent schedule revision.';
  container.append(intro);
  const toolbar = createElement(documentRef, 'div', 'toolbar');
  const refresh = button(documentRef, data.stale ? 'Refresh stale insights' : 'Refresh insights', 'button', 'primary-button');
  const status = statusNode(documentRef, data.stale ? 'Insights are stale.' : '');
  refresh.addEventListener('click', () => handleAction(status, actions.onRefresh ? () => actions.onRefresh?.(data.revision) : undefined));
  toolbar.append(refresh, status);
  container.append(toolbar);
  if (data.stale) {
    const stale = createElement(documentRef, 'p', 'alert warning');
    stale.setAttribute('role', 'status');
    stale.textContent = 'Counts are from an earlier revision and must be refreshed before use.';
    container.append(stale);
  }
  const revision = revisionLabel(documentRef, data.revision);
  if (revision) container.append(revision);
  if (data.generatedAt) {
    const generated = createElement(documentRef, 'p', 'muted');
    generated.textContent = `Generated ${data.generatedAt}`;
    container.append(generated);
  }

  const controls = createElement(documentRef, 'div', 'toolbar');
  const sort = labelledSelect(documentRef, 'Sort overlap windows', [
    { value: 'weekday', label: 'Weekday and time' },
    { value: 'count', label: 'Volunteer count' }
  ]).select;
  controls.append(sort);
  const table = createElement(documentRef, 'table', 'data-table sortable-table');
  const caption = createElement(documentRef, 'caption');
  caption.textContent = 'Recurring availability overlap';
  table.append(caption);
  const thead = createElement(documentRef, 'thead');
  const headerRow = createElement(documentRef, 'tr');
  for (const label of ['Window', 'Count', 'Volunteers']) {
    const cell = createElement(documentRef, 'th');
    cell.scope = 'col';
    cell.textContent = label;
    headerRow.append(cell);
  }
  thead.append(headerRow);
  table.append(thead);
  const tbody = createElement(documentRef, 'tbody');
  const drawRows = (): void => {
    while (tbody.firstChild) tbody.firstChild.remove();
    const cells = [...data.cells].sort((left, right) => sort.value === 'count' ? right.count - left.count || left.weekday - right.weekday || cellStart(left) - cellStart(right) : left.weekday - right.weekday || cellStart(left) - cellStart(right));
    if (cells.length === 0) {
      const row = createElement(documentRef, 'tr');
      const cell = createElement(documentRef, 'td');
      cell.colSpan = 3;
      cell.textContent = 'No overlapping windows were found.';
      row.append(cell);
      tbody.append(row);
      return;
    }
    for (const cellData of cells) {
      const row = createElement(documentRef, 'tr');
      const windowCell = createElement(documentRef, 'th');
      windowCell.scope = 'row';
      windowCell.textContent = `${WEEKDAY_LABELS[cellData.weekday] ?? `Day ${cellData.weekday}`} ${cellData.start}–${cellData.end}`;
      const countCell = createElement(documentRef, 'td');
      countCell.textContent = String(cellData.count);
      const namesCell = createElement(documentRef, 'td');
      namesCell.textContent = showVolunteerDetails ? (cellData.volunteerNames?.join(', ') || 'No names available') : 'Administrator-only details';
      row.append(windowCell, countCell, namesCell);
      tbody.append(row);
    }
  };
  sort.addEventListener('change', drawRows);
  drawRows();
  table.append(tbody);
  controls.append(table);
  container.append(controls);

  const heatmapSection = createElement(documentRef, 'section', 'panel');
  heatmapSection.append(heading(documentRef, 3, 'Weekly availability heatmap'));
  const heatmapHelp = createElement(documentRef, 'p', 'muted');
  heatmapHelp.textContent = 'Select a green cell with Tab or arrow keys to review its numeric count. Color is supplementary, not the only signal.';
  heatmapSection.append(heatmapHelp);
  const grid = createElement(documentRef, 'div', 'heatmap-grid');
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-label', 'Monday through Friday recurring availability by time');
  const weekdays = [1, 2, 3, 4, 5];
  const cells = [...data.cells].filter((cell) => weekdays.includes(cell.weekday)).sort((left, right) => left.weekday - right.weekday || cellStart(left) - cellStart(right));
  const maximum = Math.max(1, ...cells.map((cell) => cell.count));
  const details = createElement(documentRef, 'p', 'selection-detail');
  details.setAttribute('aria-live', 'polite');
  details.textContent = 'Select an interval to see its details.';
  for (const weekday of weekdays) {
    const column = createElement(documentRef, 'div', 'heatmap-column');
    column.setAttribute('role', 'row');
    const label = createElement(documentRef, 'h4');
    label.textContent = WEEKDAY_LABELS[weekday];
    column.append(label);
    const dayCells = cells.filter((cell) => cell.weekday === weekday);
    if (dayCells.length === 0) {
      const empty = createElement(documentRef, 'p', 'muted');
      empty.textContent = 'No data';
      column.append(empty);
    }
    for (const cellData of dayCells) {
      const cellButton = button(documentRef, `${cellData.start}–${cellData.end}: ${cellData.count}`, 'button', 'heatmap-cell');
      cellButton.setAttribute('role', 'gridcell');
      cellButton.setAttribute('aria-label', insightCellLabel(cellData));
      cellButton.setAttribute('aria-pressed', 'false');
      cellButton.style.setProperty('--heat-level', String(cellData.count / maximum));
      cellButton.addEventListener('click', () => {
        for (const selected of grid.querySelectorAll<HTMLButtonElement>('.heatmap-cell[aria-pressed="true"]')) selected.setAttribute('aria-pressed', 'false');
        cellButton.setAttribute('aria-pressed', 'true');
        const names = showVolunteerDetails && cellData.volunteerNames?.length ? ` Volunteers: ${cellData.volunteerNames.join(', ')}.` : '';
        details.textContent = `${insightCellLabel(cellData)}.${names}`;
      });
      column.append(cellButton);
    }
    grid.append(column);
  }
  heatmapSection.append(grid, details);
  container.append(heatmapSection);
}

export function renderCenterSchedule(
  container: HTMLElement,
  data: CenterScheduleData,
  role: ViewRole,
  actions: CenterScheduleActions = {},
  documentRef: Document = container.ownerDocument
): void {
  clear(container);
  const centerName = data.centerName ? ` — ${data.centerName}` : '';
  container.append(heading(documentRef, 2, `Candidate center schedule${centerName}`));
  const intro = createElement(documentRef, 'p');
  intro.textContent = 'Candidate coverage is advisory only. It does not create assignments or promise a class until an administrator confirms it.';
  container.append(intro);
  const revision = revisionLabel(documentRef, data.revision);
  if (revision) container.append(revision);
  const form = createElement(documentRef, 'form', 'stacked-form');
  const editor = intervalEditor(documentRef, false);
  const count = labelledInput(documentRef, 'Requested volunteers (1–2)', 'number').input;
  count.min = '1';
  count.max = '2';
  count.step = '1';
  count.required = true;
  form.append(editor.wrapper, count.closest('label') as HTMLLabelElement);
  const submit = button(documentRef, 'Save candidate interval', 'submit', 'primary-button');
  const status = statusNode(documentRef);
  form.append(submit, status);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const interval = parseInterval(editor);
      const requestedStaffCount = Number(count.value);
      if (!Number.isInteger(requestedStaffCount) || requestedStaffCount < 1 || requestedStaffCount > 2) throw new Error('Requested staffing must be one or two volunteers.');
      const candidate = { ...interval, requestedStaffCount };
      handleAction(status, actions.onCandidateUpdate ? () => actions.onCandidateUpdate?.(candidate, data.revision) : undefined);
    } catch (error) {
      announceFailure(status, error);
    }
  });
  container.append(form);

  const table = createElement(documentRef, 'table', 'data-table');
  const caption = createElement(documentRef, 'caption');
  caption.textContent = 'Your candidate intervals and current advisory coverage';
  table.append(caption);
  const header = createElement(documentRef, 'tr');
  for (const label of ['Interval', 'Requested', 'Coverage', 'State', 'Action']) {
    const cell = createElement(documentRef, 'th');
    cell.scope = 'col';
    cell.textContent = label;
    header.append(cell);
  }
  const thead = createElement(documentRef, 'thead');
  thead.append(header);
  table.append(thead);
  const tbody = createElement(documentRef, 'tbody');
  if (data.candidates.length === 0) {
    const row = createElement(documentRef, 'tr');
    const cell = createElement(documentRef, 'td');
    cell.colSpan = 5;
    cell.textContent = 'No candidate intervals have been entered.';
    row.append(cell);
    tbody.append(row);
  } else {
    for (const candidate of data.candidates) {
      const row = createElement(documentRef, 'tr');
      const interval = createElement(documentRef, 'th');
      interval.scope = 'row';
      interval.textContent = `${WEEKDAY_LABELS[candidate.weekday] ?? `Day ${candidate.weekday}`} ${candidate.start}–${candidate.end}`;
      const requested = createElement(documentRef, 'td');
      requested.textContent = String(candidate.requestedStaffCount);
      const coverage = createElement(documentRef, 'td');
      coverage.textContent = candidate.coverageCount === undefined ? 'Not evaluated' : `${candidate.coverageCount} eligible volunteers`;
      const state = createElement(documentRef, 'td');
      state.textContent = candidate.status ?? (candidate.coverageCount !== undefined && candidate.coverageCount >= candidate.requestedStaffCount ? 'Candidate coverage' : 'Coverage shortfall');
      const actionCell = createElement(documentRef, 'td');
      if (role === 'administrator' && candidate.id) {
        const confirm = button(documentRef, 'Confirm for scheduling');
        const confirmStatus = statusNode(documentRef);
        confirm.addEventListener('click', () => handleAction(confirmStatus, actions.onCandidateConfirm ? () => actions.onCandidateConfirm?.(candidate.id as string, data.revision) : undefined));
        actionCell.append(confirm, confirmStatus);
      } else {
        actionCell.textContent = 'Administrator confirmation required';
      }
      row.append(interval, requested, coverage, state, actionCell);
      tbody.append(row);
    }
  }
  table.append(tbody);
  container.append(table);
}

export function renderUnauthorized(container: HTMLElement, message: string, documentRef: Document = container.ownerDocument): void {
  clear(container);
  const panel = createElement(documentRef, 'section', 'panel');
  panel.append(heading(documentRef, 2, 'Access unavailable'));
  const text = createElement(documentRef, 'p');
  text.textContent = message;
  panel.append(text);
  container.append(panel);
}
