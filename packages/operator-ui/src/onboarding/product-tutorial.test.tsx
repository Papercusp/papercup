/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountProductTutorial, validProductTutorialRecord, type ProductTutorialAccount } from './product-tutorial';

const account: ProductTutorialAccount = { tenantId: 'org', userId: 'user', sessionId: 'session', workspaceId: null };
const record = (patch: Record<string, unknown> = {}) => ({ scope: { tenantId: account.tenantId, userId: account.userId }, version: 3,
  revision: 0, mutationId: null, disposition: 'active', currentLessonId: 'welcome', reviewedLessonIds: [], ...patch });
const response = (value: unknown, status = 200) => Response.json({ record: value }, { status });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('account product guide entry', () => {
  it.each([null, 'preassigned'])('shows the enrolled guide before workspace first-run/Home with workspace=%s', async workspaceId => {
    const fetcher = vi.fn().mockResolvedValue(response(record())); vi.stubGlobal('fetch', fetcher);
    let mountedDestination = false;
    function Destination() { mountedDestination = true; return <p>Home/first-run</p>; }
    render(<AccountProductTutorial account={{ ...account, workspaceId }}><Destination /></AccountProductTutorial>);
    expect(screen.queryByText('Home/first-run')).toBeNull();
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    expect(mountedDestination).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toContain('scope=account&version=3');
  });
  it('saves only reviewed explanations and resumes after pause without running product actions', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(record())).mockResolvedValueOnce(response(record({ revision: 1, currentLessonId: 'navigation', reviewedLessonIds: ['welcome'] })))
      .mockResolvedValueOnce(response(record({ revision: 2, disposition: 'paused', currentLessonId: 'navigation', reviewedLessonIds: ['welcome'] })))
      .mockResolvedValueOnce(response(record({ revision: 3, currentLessonId: 'navigation', reviewedLessonIds: ['welcome'] })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Home/first-run</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed — next lesson' }));
    await screen.findByRole('heading', { name: 'Find your way around' });
    const saved = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(saved).toMatchObject({ version: 3, expectedRevision: 0, reviewedLessonIds: ['welcome'], expectedScope: { tenantId: 'org', userId: 'user' } });
    expect(saved).not.toHaveProperty('completed');
    fireEvent.click(screen.getByRole('button', { name: 'Pause guide' }));
    await screen.findByText('Home/first-run');
    fireEvent.click(screen.getByRole('button', { name: 'Resume product guide' }));
    await screen.findByRole('heading', { name: 'Find your way around' });
    expect(fetcher.mock.calls.every(([url]) => String(url).includes('tutorial-progress'))).toBe(true);
  });
  it('retains an uncertain mutation key and adopts a conflicting tab without inventing completion', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(record())).mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(response(record({ revision: 5, currentLessonId: 'billing' }), 409));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed — next lesson' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry saving choice' }));
    await screen.findByRole('heading', { name: 'Understand the bills' });
    expect(fetcher.mock.calls[2][1].body).toBe(fetcher.mock.calls[1][1].body);
    expect(screen.getByRole('alert').textContent).toContain('Another tab');
    expect(screen.getByRole('status').textContent).toContain('0 explanations');
  });
  it('keeps a returning unenrolled account on its existing destination, but exposes recovery on failed reads', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(null)).mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const first = render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    await screen.findByText('Home'); first.unmount();
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Product guide unavailable' });
    expect(screen.queryByText('Home')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Papercusp' }));
    await screen.findByText('Home');
  });
  it('refuses foreign progress and cancels a pending save when the session expires', async () => {
    expect(validProductTutorialRecord(record({ scope: { tenantId: 'foreign', userId: 'user' } }), account)).toBe(false);
    expect(validProductTutorialRecord(record({ currentLessonId: 'unknown' }), account)).toBe(false);
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(response(record())).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    fireEvent.click(screen.getByRole('button', { name: 'Pause guide' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    view.rerender(<AccountProductTutorial account={account} sessionSignal="signed-out"><p>Home</p></AccountProductTutorial>);
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
    await act(async () => resolve(response(record({ revision: 1, disposition: 'paused' }))));
    expect(screen.queryByText('Home')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Check your session' })).toBeTruthy();
  });
});
