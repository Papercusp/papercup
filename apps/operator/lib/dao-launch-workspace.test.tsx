/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { defaultDaoLaunchSections, projectDaoLaunch, type DaoLaunchProjection, type DaoLaunchRecord } from '@papercusp/operator-core/lib/dao-launch';

const sync = vi.hoisted(() => ({ data: [] as DaoLaunchProjection[], loading: false, error: null as Error | null, invalidate: vi.fn() }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => sync }));
vi.mock('nuqs', () => {
  const parser = { withDefault: () => parser };
  return {
    parseAsString: parser, parseAsBoolean: parser, parseAsStringEnum: () => parser,
    useQueryStates: () => {
      const [state, set] = useState({ daoOrg: '', daoPanel: 'launch', daoEdit: '', daoNew: false });
      return [state, (patch: object) => set(current => ({ ...current, ...patch }))];
    },
  };
});
vi.mock('../app/harness/Modal', () => ({
  Modal: ({ open, title, children }: { open: boolean; title: string; children: React.ReactNode }) => open ? <div role="dialog" aria-label={title}>{children}</div> : null,
}));
vi.mock('../app/harness/Select', () => ({
  Select: ({ value, onChange, options, ariaLabel }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; ariaLabel: string }) =>
    <select aria-label={ariaLabel} value={value} onChange={e => onChange(e.target.value)}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>,
}));
vi.mock('../app/harness/Checkbox', () => ({
  Checkbox: ({ checked, onChange, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; ariaLabel: string }) =>
    <input type="checkbox" aria-label={ariaLabel} checked={checked} onChange={e => onChange(e.target.checked)} />,
}));
import { DaoLaunchWorkspace } from '../app/dao/DaoLaunchWorkspace';

function draft(): DaoLaunchProjection {
  const sections = defaultDaoLaunchSections('Founder'); sections.purpose = 'Shared software';
  const record: DaoLaunchRecord = { id: 'org-1', name: 'Moss Collective', creatorId: 'user-1', revision: 2, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z', reviewedRevision: null, sections };
  return projectDaoLaunch(record);
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => { sync.data = []; sync.loading = false; sync.error = null; sync.invalidate.mockReset(); });

describe('DAO launch checklist workspace', () => {
  it('shows a useful empty state and creates a persistent organization through the mutation API', async () => {
    const saved = draft(); const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ organization: saved }) }); vi.stubGlobal('fetch', fetchMock);
    render(<DaoLaunchWorkspace />);
    expect(screen.getByText('Your DAO starts here.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create an organization' }));
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Moss Collective' } });
    fireEvent.change(screen.getByLabelText('Shared purpose'), { target: { value: 'Shared software' } });
    fireEvent.click(screen.getByRole('button', { name: /Create organization draft/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(options.body)).toEqual({ name: 'Moss Collective', purpose: 'Shared software' });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'From idea to operating DAO.' })).toBeTruthy());
    expect(sync.invalidate).toHaveBeenCalled();
  });
  it('uses real prepared counts, keeps the balance unknown and blocks premature final review', () => {
    sync.data = [draft()]; render(<DaoLaunchWorkspace />);
    expect(screen.getByText(/1 of 5 steps prepared/)).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Open setup/ }).at(-1)!);
    const complete = screen.getByRole('button', { name: /Complete launch preparation/ }) as HTMLButtonElement;
    expect(complete.disabled).toBe(true);
    expect(screen.getByText('Preparation still needed')).toBeTruthy();
  });
  it('saves governance with the original revision and displays stale-write errors without losing the draft', async () => {
    sync.data = [draft()];
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ message: 'Someone changed this draft. Reload the latest version before saving.' }) }); vi.stubGlobal('fetch', fetchMock);
    render(<DaoLaunchWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: /Open governance setup/ }));
    fireEvent.change(screen.getByLabelText('Quorum (%)'), { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: /Save preparation/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/desktop/dao-launch/org-1');
    expect(JSON.parse(options.body)).toMatchObject({ expectedRevision: 2, sections: { governance: { quorumBps: 7500 } } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Someone changed this draft'));
    expect((screen.getByLabelText('Quorum (%)') as HTMLInputElement).value).toBe('75');
  });
  it('keeps invalid funding edits renderable and surfaces a validation error rather than sending them', async () => {
    sync.data = [draft()]; const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    render(<DaoLaunchWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Money flow' }));
    fireEvent.click(screen.getByRole('button', { name: /Edit funding/ }));
    fireEvent.change(screen.getByLabelText('DAO revenue share (%)'), { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Save preparation/ }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('lets users discard an edit and reopen the saved configuration', () => {
    sync.data = [draft()]; const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    render(<DaoLaunchWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: /Open governance setup/ }));
    expect(screen.getByRole('heading', { name: 'Governance rules' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Quorum (%)'), { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Open governance setup/ }));
    expect((screen.getByLabelText('Quorum (%)') as HTMLInputElement).value).toBe('50');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('provides retry instead of presenting a failed read as an empty workspace', () => {
    sync.error = new Error('Connection unavailable'); render(<DaoLaunchWorkspace />);
    expect(screen.getByRole('alert').textContent).toContain('Connection unavailable');
    expect(screen.queryByText('Your DAO starts here.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(sync.invalidate).toHaveBeenCalled();
  });
});
