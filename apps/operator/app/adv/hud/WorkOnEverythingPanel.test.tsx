// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
