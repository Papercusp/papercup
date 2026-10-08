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
vi.mock('./GoalStatusControl', () => ({ default: () => <span>Goal control</span> }));
vi.mock('./GoalSettingsSection', () => ({ default: () => <span>Goal settings</span> }));
import WorkOnEverythingPanel from './WorkOnEverythingPanel';

function fixture(): GoalDetailInput {
  return { goal: { id: 'g1', title: 'Work on everything', status: 'active', goalPackage: { ref: 'work-on-everything' } },
    effectiveStatus: 'active', holderLiveness: 'held', goalData: { collections: { worklist: {
      selection: { ok: true, configured: true, policyVersion: 7,
        collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority', selectable: true, defaultSelected: true },
        policy: { order: ['plan:h/a', 'plan:h/b', 'plan:h/out', 'plan:h/dormant'], excluded: ['plan:h/out'] },
        items: [{ id: 'plan:h/a', selected: true }, { id: 'plan:h/b', selected: true }, { id: 'plan:h/out', selected: false }],
        selected: ['plan:h/a', 'plan:h/b'] },
      rows: [{ id: 'plan:h/a', selected: true, label: 'Cloud setup', harness: 'h', planSlug: 'a', state: 'active', reason: null },
        { id: 'plan:h/b', selected: true, label: 'Search reliability', harness: 'h', planSlug: 'b', state: 'active', reason: null },
        { id: 'plan:h/out', selected: false, label: 'Mobile', harness: 'h', planSlug: 'out', state: 'active', reason: null }] } } },
    agents: [{ ownerId: 'holder', live: true }] };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('02C draft and apply', () => {
  it('stages keyboard changes, reviews before saving, and waits for canonical acknowledgement', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, version: 8 }) });
    vi.stubGlobal('fetch', fetch);
    const data = fixture(), refresh = vi.fn();
    const view = render(<WorkOnEverythingPanel data={data} nowMs={Date.now()} onClose={vi.fn()} refresh={refresh} />);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
    const globalNavigation = vi.fn();
    document.addEventListener('keydown', globalNavigation);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowUp', altKey: true });
    document.removeEventListener('keydown', globalNavigation);
    expect(globalNavigation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Pending changes' })).toBeTruthy();
    fireEvent.click(screen.getByText('Review & apply'));
    expect(screen.getByText('After apply')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: /Why/ }), { target: { value: 'Demo priority' } });
    fireEvent.click(screen.getByText('Apply changes'));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ goalId: 'g1', property: 'worklist_policy', expectedVersion: 7, reason: 'Demo priority' });
    expect(body.value.order[0]).toBe('plan:h/b');
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.getByText('Saved. Waiting for the confirmed worklist…')).toBeTruthy();
    const updated = structuredClone(data);
    const c = updated.goalData!.collections.worklist;
    if (!c.selection.ok || !c.selection.configured) throw new Error('fixture');
    c.selection.policyVersion = 8; c.selection.policy = body.value;
    c.rows = [c.rows[1], c.rows[0], c.rows[2]];
    view.rerender(<WorkOnEverythingPanel data={updated} nowMs={Date.now()} onClose={vi.fn()} refresh={refresh} />);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Pending changes' })).toBeNull());
    expect(screen.getByText(/Worklist applied/)).toBeTruthy();
  });
  it('discard never writes; a stale snapshot keeps the draft and prevents apply', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const data = fixture(), props = { nowMs: Date.now(), onClose: vi.fn(), refresh: vi.fn() };
    const view = render(<WorkOnEverythingPanel {...props} data={data} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cloud setup' }));
    fireEvent.click(screen.getByText('Discard'));
    expect(screen.queryByRole('region', { name: 'Pending changes' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cloud setup' }));
    const changed = structuredClone(data);
    const c = changed.goalData!.collections.worklist;
    if (!c.selection.ok || !c.selection.configured) throw new Error('fixture');
    c.selection.policyVersion = 9;
    view.rerender(<WorkOnEverythingPanel {...props} data={changed} />);
    expect(screen.getByRole('alert').textContent).toContain('changed while you were editing');
    expect((screen.getByText('Review & apply') as HTMLButtonElement).disabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('failed saves keep the reason and pending changes for correction', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false,
      json: async () => ({ error: 'stale', message: 'Another owner edited this worklist' }) }));
    render(<WorkOnEverythingPanel data={fixture()} nowMs={Date.now()} onClose={vi.fn()} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cloud setup' }));
    fireEvent.click(screen.getByText('Review & apply'));
    fireEvent.change(screen.getByRole('textbox', { name: /Why/ }), { target: { value: 'Keep the reason' } });
    fireEvent.click(screen.getByText('Apply changes'));
    await waitFor(() => expect(screen.getAllByRole('alert')[0].textContent).toContain('Another owner'));
    expect((screen.getByRole('textbox', { name: /Why/ }) as HTMLTextAreaElement).value).toBe('Keep the reason');
    expect(screen.getByRole('region', { name: 'Pending changes' })).toBeTruthy();
  });
  it('uses real plan navigation and exposes unmeasured evidence without fabricated activity', () => {
    const open = vi.fn();
    render(<WorkOnEverythingPanel data={fixture()} nowMs={Date.now()} onClose={vi.fn()} refresh={vi.fn()} onOpenPlan={open} />);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' });
    expect(open).toHaveBeenCalledWith('h', 'a');
    fireEvent.click(screen.getByRole('tab', { name: 'Evidence' }));
    expect(screen.getByText('No completed outcome was read for this plan.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.getByText(/No scope or priority change/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search worklist' }), { target: { value: 'does-not-exist' } });
    expect(screen.getByText('No plans match your search.')).toBeTruthy();
  });
  it('keeps scope totals separate from search and updates them while staging and discarding', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(<WorkOnEverythingPanel data={fixture()} nowMs={Date.now()} onClose={vi.fn()} refresh={vi.fn()} />);
    const summary = document.querySelector('dl[aria-label="Worklist overview"]')!;
    const values = () => Array.from(summary.querySelectorAll('dd')).map((el) => el.textContent);
    expect(values()).toEqual(['2', '1', '0']);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search worklist' }), { target: { value: 'Cloud' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(values()).toEqual(['2', '1', '0']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cloud setup' }));
    expect(values()).toEqual(['1', '2', '2']);
    fireEvent.click(screen.getByText('Discard'));
    expect(values()).toEqual(['2', '1', '0']);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('shows complete next steps and measured progress, and keeps unknown progress unknown', () => {
    const data = fixture(), rows = data.goalData!.collections.worklist.rows;
    rows[0].nextStep = 'Verify the deployment configuration before opening the next work item';
    rows[0].counts = { todo: 2, wip: 1, done: 3, blocked: 0, needsHuman: 0 };
    const view = render(<WorkOnEverythingPanel data={data} nowMs={Date.now()} onClose={vi.fn()} refresh={vi.fn()} />);
    expect(within(screen.getAllByRole('option')[0]).getByText(rows[0].nextStep)).toBeTruthy();
    const progress = screen.getByRole('progressbar', { name: 'Plan completion' }) as HTMLProgressElement;
    expect(progress.value).toBe(3);
    expect(progress.max).toBe(6);
    fireEvent.click(screen.getAllByRole('option')[1]);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('Task progress has not been measured.')).toBeTruthy();
    const unavailable = fixture(); unavailable.goalData!.collections = {};
    view.rerender(<WorkOnEverythingPanel data={unavailable} nowMs={Date.now()} onClose={vi.fn()} refresh={vi.fn()} />);
    expect(document.querySelector('dl[aria-label="Worklist overview"]')).toBeNull();
    expect(screen.getByText('Worklist unavailable')).toBeTruthy();
  });
  it('renders a configured empty worklist without errors or writes', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const data = fixture(), collection = data.goalData!.collections.worklist;
    if (!collection.selection.ok || !collection.selection.configured) throw new Error('fixture');
    collection.rows = [];
    collection.selection.items = [];
    collection.selection.selected = [];
    collection.selection.policy = { order: [], excluded: [] };
    const open = vi.fn();
    render(<WorkOnEverythingPanel data={data} nowMs={Date.now()} onClose={vi.fn()} refresh={vi.fn()} onOpenPlan={open} />);
    expect(screen.getByText('No plans are available.')).toBeTruthy();
    expect(screen.getByText('Select a plan to inspect.')).toBeTruthy();
    expect(screen.queryByText('Worklist unavailable')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    for (const key of ['ArrowDown', 'ArrowUp', 'x', 'Enter']) {
      fireEvent.keyDown(screen.getByRole('listbox'), { key });
    }
    expect(screen.queryByRole('region', { name: 'Pending changes' })).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reorders from a focused row control without triggering global navigation', () => {
    render(<WorkOnEverythingPanel data={fixture()} nowMs={Date.now()} onClose={vi.fn()} refresh={vi.fn()} />);
    const control = screen.getByRole('button', { name: 'Move Search reliability up' });
    control.focus();
    const navigation = vi.fn();
    document.addEventListener('keydown', navigation);
    fireEvent.keyDown(control, { key: 'ArrowUp', altKey: true });
    document.removeEventListener('keydown', navigation);
    expect(navigation).not.toHaveBeenCalled();
    expect(screen.getAllByRole('option')[0].textContent).toContain('Search reliability');
    expect(screen.getByRole('region', { name: 'Pending changes' })).toBeTruthy();
  });
});
