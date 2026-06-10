// @vitest-environment jsdom
/**
 * PlanKanbanView — the Create-tab plan board (P-025, dnd-kit + @papercusp/sync).
 * Pins the render-side contracts that don't need a real drag:
 *   - the six canonical status columns always render, in order, with counts;
 *   - an item with an UNEXPECTED status gets a trailing column — the
 *     never-silently-hidden invariant the column-builder comments promise;
 *   - normalization: `storedStatus` (plans:get snapshot) wins over `status`
 *     (raw jsonb), missing both → todo, id-less rows are dropped;
 *   - data source: live `useSyncQuery('planItems.byPlan')` rows win over the
 *     snapshot prop; the snapshot is the fallback when the query is undefined
 *     (no SyncProvider / first pull pending).
 * Drag mechanics (dnd-kit sensors) are exercised by the real browser e2e
 * surface, not jsdom.
 *
 * Seam: @papercusp/sync (useSyncQuery/useSyncMutate) module-mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({
  liveData: undefined as unknown,
  lastQuery: null as { queryName: string; args: unknown } | null,
  mutate: vi.fn(async (_args: unknown) => ({ ok: true })),
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (q: { queryName: string; args: unknown }) => {
    h.lastQuery = q;
    return { data: h.liveData, loading: false };
  },
  useSyncMutate: () => h.mutate,
}));

import PlanKanbanView from './PlanKanbanView';
import type { PlanItem } from './plans-api';

/** plans:get-snapshot-shaped item (carries storedStatus). */
const snap = (id: string, storedStatus: string, text = `${id} text`): PlanItem =>
  ({ id, text, storedStatus }) as unknown as PlanItem;

const COL_LABELS = ['To Do', 'In Progress', 'Blocked', 'Needs Human', 'Done', 'Dropped'];

beforeEach(() => {
  h.liveData = undefined;
  h.lastQuery = null;
  h.mutate.mockClear();
});

afterEach(cleanup);

describe('PlanKanbanView', () => {
  it('renders the six canonical columns in order with per-column counts', () => {
    render(
      <PlanKanbanView
        slug="my-plan"
        items={[snap('P-001', 'todo'), snap('P-002', 'todo'), snap('P-003', 'done')]}
      />,
    );
    const labels = COL_LABELS.map((l) => screen.getByText(l));
    for (let i = 1; i < labels.length; i++) {
      expect(
        labels[i - 1].compareDocumentPosition(labels[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // Counts: the (N) badge sits inside the column header next to the label.
    expect(screen.getByText('To Do').textContent).toContain('(2)');
    expect(screen.getByText('Done').textContent).toContain('(1)');
    expect(screen.getByText('Blocked').textContent).toContain('(0)');
  });

  it('gives an unexpected status its own trailing column — no item is silently hidden', () => {
    render(
      <PlanKanbanView slug="my-plan" items={[snap('P-001', 'todo'), snap('P-009', 'weird-status')]} />,
    );
    // The trailing column is labeled with the raw status token and holds the item.
    const extraCol = screen.getByText('weird-status');
    expect(extraCol.textContent).toContain('(1)');
    expect(screen.getByText('P-009')).toBeTruthy();
  });

  it('queries planItems.byPlan for the given slug', () => {
    render(<PlanKanbanView slug="my-plan" items={[]} />);
    expect(h.lastQuery).toEqual({ queryName: 'planItems.byPlan', args: { planSlug: 'my-plan' } });
  });

  it('prefers live sync rows over the snapshot prop', () => {
    h.liveData = [{ id: 'P-100', text: 'live row', status: 'wip' }];
    render(<PlanKanbanView slug="my-plan" items={[snap('P-001', 'todo', 'snapshot row')]} />);
    expect(screen.getByText('P-100')).toBeTruthy();
    expect(screen.queryByText('P-001')).toBeNull();
    expect(screen.getByText('In Progress').textContent).toContain('(1)');
  });

  it('falls back to the snapshot when the sync query is undefined', () => {
    h.liveData = undefined;
    render(<PlanKanbanView slug="my-plan" items={[snap('P-001', 'blocked')]} />);
    expect(screen.getByText('P-001')).toBeTruthy();
    expect(screen.getByText('Blocked').textContent).toContain('(1)');
  });

  it('normalizes: storedStatus wins over status; missing both → todo; id-less rows dropped', () => {
    h.liveData = [
      { id: 'P-201', text: 'both', status: 'done', storedStatus: 'wip' },
      { id: 'P-202', text: 'neither' },
      { text: 'no id at all', status: 'todo' },
    ];
    render(<PlanKanbanView slug="my-plan" items={[]} />);
    expect(screen.getByText('In Progress').textContent).toContain('(1)'); // storedStatus won
    expect(screen.getByText('To Do').textContent).toContain('(1)'); // default
    expect(screen.getByText('Done').textContent).toContain('(0)');
    expect(screen.queryByText('no id at all')).toBeNull();
  });

  it('strips a leading backticked token from card text and caps the preview', () => {
    render(
      <PlanKanbanView
        slug="my-plan"
        items={[snap('P-301', 'todo', '`api-surface` Build the thing')]}
      />,
    );
    expect(screen.getByText('Build the thing')).toBeTruthy();
  });
});
