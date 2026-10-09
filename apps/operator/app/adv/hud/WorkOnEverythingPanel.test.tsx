// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
import type { GoalDetailInput } from './goal-detail-model';

vi.mock('nuqs', async () => {
  const React = await import('react');
  return { ...nuqsParsers, useQueryState: (_key: string, p?: { defaultValue?: unknown }) =>
    React.useState<unknown>(p?.defaultValue ?? null) };
});
vi.mock('@/app/harness/Modal', () => ({
  Modal: ({ open, children, title }: { open: boolean; children: React.ReactNode; title: string }) =>
    open ? <div role="dialog" aria-label={title}>{children}</div> : null,
}));
vi.mock('@/app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('./GoalStatusControl', () => ({ default: () => <span>Goal control</span> }));
vi.mock('./GoalSettingsSection', () => ({ default: () => <span>Goal settings</span> }));
import WorkOnEverythingPanel from './WorkOnEverythingPanel';

const counts = (todo: number, wip: number, done: number, extra: Partial<{ blocked: number; needsHuman: number }> = {}) =>
  ({ todo, wip, done, blocked: extra.blocked ?? 0, needsHuman: extra.needsHuman ?? 0 });

function fixture(): GoalDetailInput {
  return { goal: { id: 'g1', title: 'Work on everything', status: 'active', goalPackage: { ref: 'work-on-everything' } },
    effectiveStatus: 'active', holderLiveness: 'held', goalData: { collections: { worklist: {
      selection: { ok: true, configured: true, policyVersion: 7,
        collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority', selectable: true, defaultSelected: false },
        policy: { order: ['plan:h/a', 'plan:h/b'], excluded: [], included: ['plan:h/a', 'plan:h/b'] },
        items: [{ id: 'plan:h/a', selected: true }, { id: 'plan:h/b', selected: true }, { id: 'plan:h/out', selected: false },
          { id: 'plan:h/empty', selected: false }],
        selected: ['plan:h/a', 'plan:h/b'] },
      rows: [{ id: 'plan:h/a', selected: true, label: 'Cloud setup', harness: 'h', planSlug: 'a', state: 'working', reason: null,
          counts: counts(2, 1, 3), nextStep: 'Verify the deployment configuration' },
        { id: 'plan:h/b', selected: true, label: 'Search reliability', harness: 'h', planSlug: 'b', state: 'unplaced', reason: null,
          counts: counts(0, 0, 1, { needsHuman: 2 }) },
        { id: 'plan:h/out', selected: false, label: 'Mobile', harness: 'h', planSlug: 'out', state: 'blocked',
          reason: 'Not in the worklist: the owner has not picked this plan for this goal.', counts: counts(4, 0, 6) },
        { id: 'plan:h/empty', selected: false, label: 'Placeholder', harness: 'h', planSlug: 'empty', state: 'blocked',
          reason: null, counts: counts(0, 0, 0) }] } } },
    completedByDay: { windowDays: 3, days: [{ day: '2026-10-07', done: 4 }] },
    agents: [{ ownerId: 'holder', live: true }] };
}
const props = () => ({ nowMs: Date.parse('2026-10-08T12:00:00Z'), onClose: vi.fn(), refresh: vi.fn() });
const rowLabels = () => screen.getAllByTestId('ongoing-worklist-row').map((r) => within(r).getAllByRole('cell')[1].textContent);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Work on everything: progress table (WI-10007603)', () => {
  it('surfaces the three duties while absent evidence stays explicitly unmeasured', () => {
    render(<WorkOnEverythingPanel data={fixture()} {...props()} />);
    const quality = screen.getByRole('region', { name: 'Rubric stewardship' });
    expect(within(quality).getByText('Maintain rubric coverage')).toBeTruthy();
    expect(within(quality).getByText('Improve rubric quality')).toBeTruthy();
    expect(within(quality).getByText('Grade, improve and re-grade')).toBeTruthy();
    expect(within(quality).getAllByText('Not measured')).toHaveLength(3);
    expect(within(quality).queryByText('Improvement verified')).toBeNull();
  });

  it('shows comparable-cycle state, canonical references and bounded evidence without claiming completion', () => {
    const data = fixture();
    data.rubricStewardship = { measuredAt: '2026-10-09T12:00:00Z', windowStart: '2026-10-02T12:00:00Z',
      complete: false, rubricRef: 'work-on-everything-stewardship-health', rubricRevision: 46,
      criteria: { 'rubric-coverage-stewardship': null, 'rubric-quality-stewardship': null,
        'grading-correction-closure': { rating: 'partial', evidence: 'Re-grade still needed', scorecardRef: 'EI-4' } },
      cycles: [{ target: 'Search', rubricRef: 'quality', rubricRevision: 2, baselineRef: 'EI-1', scorecardRef: 'EI-2',
        repairRefs: ['WI-12'], status: 'incomparable', reason: 'Target or rubric revision changed; record a fresh baseline.' }], error: null };
    const open = vi.fn();
    render(<WorkOnEverythingPanel data={data} {...props()} onOpenWorkItem={open} />);
    expect(screen.getByRole('table', { name: 'Grading cycles' })).toBeTruthy();
    expect(screen.getByText('Fresh baseline needed')).toBeTruthy();
    expect(screen.getByText(/limited recent page/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Baseline' }));
    expect(open).toHaveBeenLastCalledWith('EI-1');
    fireEvent.click(screen.getByRole('button', { name: 'WI-12' }));
    expect(open).toHaveBeenLastCalledWith('WI-12');
    expect(screen.queryByText('Improvement verified')).toBeNull();
  });

  it('shows every plan with progress, keeps unpicked plans visible, and hides empty plans by default', () => {
    render(<WorkOnEverythingPanel data={fixture()} {...props()} />);
    expect(rowLabels().map((t) => t?.split('h ·')[0])).toEqual(['Cloud setup', 'Search reliability', 'Mobile']);
    const mobile = screen.getAllByTestId('ongoing-worklist-row')[2];
    expect(within(mobile).getByRole('button', { name: 'Add Mobile' })).toBeTruthy();
    expect(within(mobile).getByRole('img', { name: '6 of 10 items done' })).toBeTruthy();
    expect(within(mobile).getByText(/add it to the worklist/)).toBeTruthy();
    expect(screen.getByText(/1 with no items hidden/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /Show plans with no items/ }));
    expect(screen.getAllByTestId('ongoing-worklist-row')).toHaveLength(4);
    expect(screen.getByRole('img', { name: '4 work items finished in the last 3 days' })).toBeTruthy();
  });

  it('totals filter the table, and scope narrows to the worklist or the rest', () => {
    render(<WorkOnEverythingPanel data={fixture()} {...props()} />);
    const totals = screen.getByRole('group', { name: 'Totals' });
    expect(within(totals).getAllByRole('button')[0].textContent).toContain('10 of 19 items done');
    fireEvent.click(within(totals).getByRole('button', { name: /Waiting on you/ }));
    expect(rowLabels()).toHaveLength(1);
    expect(rowLabels()[0]).toContain('Search reliability');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    fireEvent.click(screen.getByRole('button', { name: /Not in worklist · 1/ }));
    expect(rowLabels()).toHaveLength(1);
    expect(rowLabels()[0]).toContain('Mobile');
  });

  it('adds a plan through draft, review and apply, then waits for the confirmed version', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, version: 8 }) });
    vi.stubGlobal('fetch', fetch);
    const data = fixture(), p = props();
    const view = render(<WorkOnEverythingPanel data={data} {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Mobile' }));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Pending changes' })).toBeTruthy();
    fireEvent.click(screen.getByText('Review & apply'));
    fireEvent.change(screen.getByRole('textbox', { name: /Why/ }), { target: { value: 'Ship mobile' } });
    fireEvent.click(screen.getByText('Apply changes'));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ goalId: 'g1', property: 'worklist_policy', expectedVersion: 7, reason: 'Ship mobile' });
    expect(body.value.included).toEqual(['plan:h/a', 'plan:h/b', 'plan:h/out']);
    await waitFor(() => expect(p.refresh).toHaveBeenCalledOnce());
    const updated = structuredClone(data);
    const c = updated.goalData!.collections.worklist;
    if (!c.selection.ok || !c.selection.configured) throw new Error('fixture');
    c.selection.policyVersion = 8; c.selection.policy = body.value; c.rows[2].selected = true;
    view.rerender(<WorkOnEverythingPanel data={updated} {...p} />);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Pending changes' })).toBeNull());
    expect(screen.getByText(/Worklist applied/)).toBeTruthy();
  });

  it('discard never writes; a stale snapshot keeps the draft and blocks apply; a failed save keeps the reason', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'stale', message: 'Another owner edited this worklist' }) });
    vi.stubGlobal('fetch', fetch);
    const data = fixture(), p = props();
    const view = render(<WorkOnEverythingPanel data={data} {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cloud setup' }));
    // Removing a plan is a draft until review: no write yet.
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Pending changes' })).toBeTruthy();
    fireEvent.click(screen.getByText('Discard'));
    expect(screen.queryByRole('region', { name: 'Pending changes' })).toBeNull();
    // Discard drops the draft without ever writing.
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cloud setup' }));
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Review & apply'));
    fireEvent.click(screen.getByText('Apply changes'));
    await waitFor(() => expect(screen.getAllByRole('alert')[0].textContent).toContain('Another owner'));
    expect(screen.getByRole('region', { name: 'Pending changes' })).toBeTruthy();
    const changed = structuredClone(data);
    const c = changed.goalData!.collections.worklist;
    if (!c.selection.ok || !c.selection.configured) throw new Error('fixture');
    c.selection.policyVersion = 9;
    view.rerender(<WorkOnEverythingPanel data={changed} {...p} />);
    expect(screen.getAllByRole('alert').some((a) => a.textContent?.includes('changed while you were editing'))).toBe(true);
    expect((screen.getByText('Review & apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it('reorders in worklist order and opens a plan by its title', () => {
    const open = vi.fn();
    render(<WorkOnEverythingPanel data={fixture()} {...props()} onOpenPlan={open} />);
    expect(screen.queryByRole('button', { name: 'Move Search reliability up' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort plans' }), { target: { value: 'rank' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move Search reliability up' }));
    expect(rowLabels()[0]).toContain('Search reliability');
    expect(screen.getByText('Priority 2 → 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mobile' }));
    expect(open).toHaveBeenCalledWith('h', 'out');
  });

  it('says where the worklist came from when the picks are derived from the saved list', () => {
    const data = fixture(), s = data.goalData!.collections.worklist.selection;
    if (!s.ok || !s.configured) throw new Error('fixture');
    s.seededFromList = true; s.policyVersion = 0;
    render(<WorkOnEverythingPanel data={data} {...props()} />);
    expect(screen.getByRole('status').textContent).toContain('starts from the 2 plans saved on this goal');
  });

  it('never renders blank: each unloaded case names its reason and offers Retry', () => {
    const p = props();
    const cases: Array<[(d: GoalDetailInput) => void, RegExp]> = [
      [(d) => { delete (d.goalData as { collections?: unknown }).collections; }, /server is older than this app/],
      [(d) => { d.goalData!.collections.worklist.selection = { ok: false, configured: true, reason: 'provider offline' }; },
        /Plans could not be loaded/],
      [(d) => { d.goalData = null; }, /Goal data did not load/],
      [(d) => { d.goalData!.collections = {}; }, /no plan worklist/],
      [(d) => { d.goalData!.collections = {}; d.goalData!.error = 'permission denied for goal data'; },
        /Goal data could not be read/],
    ];
    for (const [mutate, title] of cases) {
      const data = fixture(); mutate(data);
      const view = render(<WorkOnEverythingPanel data={data} {...p} />);
      expect(screen.getByRole('alert').textContent).toMatch(title);
      expect(screen.queryByRole('table')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      view.unmount();
    }
    expect(p.refresh).toHaveBeenCalledTimes(cases.length);
  });
});
