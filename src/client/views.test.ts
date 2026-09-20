import { describe, expect, it } from 'vitest';
import {
  renderAdminSchedule,
  renderCenterSchedule,
  renderVolunteerDashboard,
  type AdminScheduleData,
  type AvailabilityException,
  type AvailabilityInterval,
  type ScheduleNotice,
  type VolunteerDashboardData
} from './views.js';

/** The event surface the view's wire handlers actually touch. */
type FakeEvent = { preventDefault(): void };

/** Small DOM double for the view's event wiring; Vitest intentionally runs in node. */
class FakeNode {
  readonly tagName: string;
  readonly children: FakeNode[] = [];
  readonly listeners = new Map<string, (event: FakeEvent) => void>();
  ownerDocument!: FakeDocument;
  parent: FakeNode | undefined;
  className = '';
  type = '';
  value = '';
  disabled = false;
  required = false;
  readonly classList = { add: (_name: string) => undefined, remove: (_name: string) => undefined };
  private ownText = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get firstChild(): FakeNode | undefined {
    return this.children[0];
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string | null) {
    this.ownText = value ?? '';
    this.children.splice(0);
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  remove(): void {
    const index = this.parent?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parent?.children.splice(index, 1);
  }

  closest(selector: string): FakeNode | null {
    if (this.tagName === selector.toUpperCase()) return this;
    return this.parent?.closest(selector) ?? null;
  }

  setAttribute(): void {
    // Accessibility attributes are not needed for this wiring-focused double.
  }

  focus(): void {
    // Focus is a browser behaviour the double does not model.
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.set(type, listener);
  }

  click(): void {
    this.listeners.get('click')?.({ preventDefault: () => undefined });
  }

  submit(): void {
    this.listeners.get('submit')?.({ preventDefault: () => undefined });
  }
}

class FakeDocument {
  createElement(tagName: string): FakeNode {
    const node = new FakeNode(tagName);
    node.ownerDocument = this;
    return node;
  }

  createTextNode(value: string): FakeNode {
    const node = new FakeNode('#text');
    node.ownerDocument = this;
    node.textContent = value;
    return node;
  }
}

function walk(node: FakeNode): FakeNode[] {
  return [node, ...node.children.flatMap(walk)];
}

function findAll(node: FakeNode, predicate: (candidate: FakeNode) => boolean): FakeNode[] {
  return walk(node).filter(predicate);
}

function find(node: FakeNode, predicate: (candidate: FakeNode) => boolean): FakeNode | undefined {
  return walk(node).find(predicate);
}

function first(node: FakeNode | undefined): FakeNode {
  if (!node) throw new Error('expected a matching node');
  return node;
}

function setValue(node: FakeNode | undefined, value: string): void {
  first(node).value = value;
}

function buttons(container: FakeNode): FakeNode[] {
  return findAll(container, (node) => node.tagName === 'BUTTON');
}

const initial: AdminScheduleData = { sessions: [], revision: 7 };
const preview: AdminScheduleData = {
  sessions: [],
  revision: 7,
  inputRevision: 3,
  outputRevision: 8,
  computedAt: '2026-09-19T18:04:05.000Z',
  summary: { assignmentCount: 0, backupCount: 0, shortfallCount: 0 },
  preview: true
};

describe('schedule preview rendering', () => {
  it('keeps preview callbacks active after the controller rerenders the preview', () => {
    const documentRef = new FakeDocument();
    const container = documentRef.createElement('main');
    let previewClicks = 0;
    const render = (data: AdminScheduleData, notice?: ScheduleNotice): void => {
      renderAdminSchedule(container as unknown as HTMLElement, data, {
        notice,
        onPreview: () => {
          previewClicks += 1;
          render(preview, { kind: 'success', message: 'Preview saved.' });
        },
        onPublish: () => undefined
      }, documentRef as unknown as Document);
    };

    render(initial);
    const firstPreview = buttons(container).find((control) => control.textContent === 'Preview scheduling');
    expect(firstPreview).toBeDefined();
    firstPreview?.click();
    expect(previewClicks).toBe(1);
    expect(container.textContent).toContain('Preview saved.');

    const refreshedPreview = buttons(container).find((control) => control.textContent === 'Refresh preview');
    expect(refreshedPreview).toBeDefined();
    refreshedPreview?.click();
    expect(previewClicks).toBe(2);
  });

  it('keeps failure notices visible after a rerender and identifies the output revision', () => {
    const documentRef = new FakeDocument();
    const container = documentRef.createElement('main');
    renderAdminSchedule(container as unknown as HTMLElement, preview, {
      notice: { kind: 'error', message: 'Preview is stale.' },
      onPreview: () => undefined,
      onPublish: () => undefined
    }, documentRef as unknown as Document);
    const publish = buttons(container).find((control) => control.textContent.includes('Publish preview output revision'));
    expect(publish?.textContent).toBe('Publish preview output revision 8');
    expect(publish?.disabled).toBe(false);
    expect(container.textContent).toContain('Preview is stale.');
    expect(container.textContent).toContain('Assignments0');
    expect(container.textContent).toContain('Backups0');
    expect(container.textContent).toContain('Shortfalls0');
  });
});

const dashboard: VolunteerDashboardData = {
  recurringAvailability: [
    { weekday: 1, start: '09:00', end: '10:00', timeZone: 'America/New_York' },
    { weekday: 2, start: '09:00', end: '10:00', timeZone: 'America/New_York' }
  ],
  exceptions: [],
  assignments: [],
  revision: 4
};

describe('volunteer availability form', () => {
  it('saves the remaining intervals even though the interval adder is empty', () => {
    const documentRef = new FakeDocument();
    const container = documentRef.createElement('main');
    let saved: AvailabilityInterval[] | undefined;
    renderVolunteerDashboard(container as unknown as HTMLElement, dashboard, {
      onRecurringUpdate: (intervals) => {
        saved = intervals;
      }
    }, documentRef as unknown as Document);

    const removers = buttons(container).filter((control) => control.textContent === 'Remove');
    expect(removers).toHaveLength(2);
    first(removers[0]).click();

    const form = first(findAll(container, (node) => node.tagName === 'FORM')[0]);
    // Nothing required may live inside the submitted form: a required, empty
    // adder field would let native validation cancel the submit silently.
    expect(findAll(form, (node) => node.required)).toHaveLength(0);

    form.submit();
    expect(saved?.map((interval) => interval.weekday)).toEqual([2]);
  });

  it('states the change in the first person and hides no zone field', () => {
    const documentRef = new FakeDocument();
    const container = documentRef.createElement('main');
    let exception: AvailabilityException | undefined;
    renderVolunteerDashboard(container as unknown as HTMLElement, { ...dashboard, recurringAvailability: [] }, {
      onExceptionCreate: (value) => {
        exception = value;
      }
    }, documentRef as unknown as Document);

    expect(container.textContent).toContain('I am unavailable');
    expect(container.textContent).not.toContain('Time zone');

    const form = first(findAll(container, (node) => node.tagName === 'FORM')[1]);
    expect(findAll(form, (node) => node.required).length).toBeGreaterThan(0);
    const inputs = findAll(form, (node) => node.tagName === 'INPUT');
    const kind = find(form, (node) => node.tagName === 'SELECT');
    expect(inputs).toHaveLength(4);
    setValue(inputs[0], '2026-09-24');
    setValue(inputs[1], '14:00');
    setValue(inputs[2], '21:00');
    if (kind) kind.value = 'unavailable';

    form.submit();
    expect(exception?.date).toBe('2026-09-24');
    expect(exception?.kind).toBe('unavailable');
    expect(exception?.timeZone).toBeTruthy();
  });
});

describe('center candidate state', () => {
  const candidate = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    id: 'candidate-x',
    weekday: 1,
    start: '12:00',
    end: '13:00',
    timeZone: 'America/New_York',
    requestedStaffCount: 1,
    status: 'candidate',
    ...overrides
  });

  function stateCells(candidates: Record<string, unknown>[]): string[] {
    const documentRef = new FakeDocument();
    const container = documentRef.createElement('main');
    renderCenterSchedule(container as unknown as HTMLElement, { centerName: 'Example Center', candidates, revision: 3 } as never, 'administrator', {}, documentRef as unknown as Document);
    // One row per candidate: requested, coverage, state, action.
    return findAll(container, (node) => node.tagName === 'TD').filter((_node, index) => index % 4 === 2).map((node) => node.textContent);
  }

  // The stored status is "candidate" for every unconfirmed interval, so it can
  // never tell a centre whether its hours are coverable. Reading the status
  // alone left the shortfall unlabelled.
  it('names the shortfall or the coverage instead of echoing the stored status', () => {
    expect(stateCells([
      candidate({ id: 'c-short', requestedStaffCount: 2, coverageCount: 0 }),
      candidate({ id: 'c-one', requestedStaffCount: 2, coverageCount: 1 }),
      candidate({ id: 'c-covered', requestedStaffCount: 1, coverageCount: 2 }),
      candidate({ id: 'c-confirmed', status: 'confirmed', coverageCount: 2 }),
      candidate({ id: 'c-unknown' })
    ])).toEqual(['Coverage shortfall', 'Coverage shortfall', 'Candidate coverage', 'Confirmed', 'Candidate']);
  });
});
