// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DaoExecution from './DaoExecution';
vi.mock('@papercusp/sync', () => ({ onSyncBusEvent: () => () => {} }));
vi.mock('@/app/adv/harnesses/HumanWorkSection', () => ({ HumanWorkSection: () => <div>Maintained human work</div> }));
vi.mock('@/app/_components/RouteLink', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
const view = { directoryId: 'dao', localHomeSlug: 'joined-home', status: 'connected' as const, projects: { status: 'ready' as const, value: [{ slug: 'linked', title: 'Linked', plans: [] }] } };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('organization execution scope', () => {
  it('opens the maintained participation controls for a recorded human-work offer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ workItems: [{ id: 'WI-human', title: 'Contributor job', kind: 'task', state: 'todo', payload: { humanWork: { offered: true } } }], total: 1 }) }));
    render(<DaoExecution view={view} section="jobs" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Contributor job' }));
    expect(screen.getByText('Maintained human work')).toBeTruthy();
  });
  it('files work only in an explicitly selected linked project and preserves pending admission', async () => {
    const fetcher = vi.fn(async (_path: string, init?: RequestInit) => ({ ok: true, json: async () => init?.method === 'POST' ? { ok: true, id: 'WI-request' } : { workItems: [{ id: 'WI-existing', title: 'Existing work', kind: 'task', state: 'wip' }], total: 1 } }));
    vi.stubGlobal('fetch', fetcher); render(<DaoExecution view={view} section="jobs" />); await screen.findByText('Existing work');
    expect((screen.getByRole('button', { name: 'Submit work request' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Project scope'), { target: { value: 'linked' } }); fireEvent.change(screen.getByLabelText('Work title'), { target: { value: 'Build the DAO feature' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit work request' })); await screen.findByText('Work request WI-request filed for admission review.');
    expect(fetcher.mock.calls.find(call => call[1]?.method === 'POST')?.[0]).toBe('/api/harness/linked/work-items');
  });
  it('shows pending joins and lets eligible owners decide through the maintained admission route', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => ({ ok: true, json: async () => path.includes('/membership') ? init?.method === 'POST' ? { ok: true } : { ok: true, canDecide: true, pending: [{ githubUserId: 42, githubUsername: 'builder', displayName: 'Builder' }] } : { workItems: [], total: 0 } }));
    vi.stubGlobal('fetch', fetcher); render(<DaoExecution view={view} section="inbox" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve builder' })); await screen.findByText('Membership approved.');
    await waitFor(() => expect(fetcher.mock.calls.some(call => call[1]?.method === 'POST' && call[0] === '/api/pot/joined-home/membership')).toBe(true));
  });
});
