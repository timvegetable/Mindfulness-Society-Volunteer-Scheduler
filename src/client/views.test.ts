import { describe, expect, it } from 'vitest';
import { renderAdminSchedule, type AdminScheduleData, type ScheduleNotice } from './views.js';

/** Small DOM double for the view's event wiring; Vitest intentionally runs in node. */
class FakeNode {
  readonly tagName: string;
  readonly children: FakeNode[] = [];
  readonly listeners = new Map<string, () => void>();
  ownerDocument!: FakeDocument;
  parent: FakeNode | undefined;
  className = '';
  type = '';
  disabled = false;
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

  setAttribute(): void {
    // Accessibility attributes are not needed for this wiring-focused double.
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  click(): void {
    this.listeners.get('click')?.();
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

function buttons(container: FakeNode): FakeNode[] {
  return container.children.flatMap((child) => [
    ...(child.tagName === 'BUTTON' ? [child] : []),
    ...buttons(child)
  ]);
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
