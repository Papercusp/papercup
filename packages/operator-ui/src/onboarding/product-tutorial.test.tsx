/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountProductTutorial, productTutorialDestination, validProductTutorialRecord, type ProductTutorialAccount } from './product-tutorial';

const account: ProductTutorialAccount = { tenantId: 'org', userId: 'user', sessionId: 'session', workspaceId: null };
const record = (patch: Record<string, unknown> = {}) => ({ scope: { tenantId: account.tenantId, userId: account.userId }, version: 3,
  revision: 0, mutationId: null, disposition: 'active', currentLessonId: 'welcome', reviewedLessonIds: [], ...patch });
const response = (value: unknown, status = 200) => Response.json({ record: value }, { status });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('account product guide entry', () => {
  it('focuses the committed resume control after pause even when an animation frame precedes React commit', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    const fetcher = vi.fn().mockResolvedValueOnce(response(record()))
      .mockResolvedValueOnce(response(record({ revision: 1, disposition: 'paused' })))
      .mockResolvedValueOnce(response(record({ revision: 2, disposition: 'active' })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Destination</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    fireEvent.click(screen.getByRole('button', { name: 'Pause guide' }));
    const resume = await screen.findByRole('button', { name: 'Resume product guide' });
    await waitFor(() => expect(document.activeElement).toBe(resume));
    fireEvent.click(resume);
    const heading = await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
  it('preserves shell panel/search targets through the explicit pre-workspace entry seam', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(record({ currentLessonId: 'navigation' })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    const launcher = await screen.findByRole('link', { name: 'Open launcher' });
    const params = new URL(launcher.getAttribute('href')!, 'https://portal.example').searchParams;
    expect(params.get('panel')).toBe('launcher');
    expect(params.get('firstRun')).toBe('deferred');
    expect(new URL(productTutorialDestination('/?q=plans', null), 'https://portal.example').searchParams.get('q')).toBe('plans');
    expect(productTutorialDestination('/billing', null)).toBe('/billing');
    expect(productTutorialDestination('/?panel=account', 'selected')).toBe('/?panel=account');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps the paused lesson Help available beside the real product destination without a mutation', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(record({ currentLessonId: 'billing', disposition: 'paused' })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Billing destination</p></AccountProductTutorial>);
    await screen.findByText('Billing destination');
    fireEvent.click(screen.getByText('Help with Understand the bills'));
    expect(screen.getByText(/Papercusp subscription, model\/provider usage/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume product guide' })).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
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
  it('teaches billing and payment recovery without starting checkout or billing management', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(record({ currentLessonId: 'billing' })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Understand the bills' });
    expect(screen.getByText(/review the price, currency and payment terms in Stripe/i)).toBeTruthy();
    expect(screen.getByText(/Test mode — no real charges/)).toBeTruthy();
    fireEvent.click(screen.getByText('Help with this lesson'));
    const help = screen.getByText(/Papercusp subscription, model\/provider usage/).textContent!;
    expect(help).toContain('bring your own cloud (BYOC)');
    expect(help).toContain('Only organization owners and billing admins');
    expect(help).toContain('Manage billing');
    expect(help).toContain('invoices');
    expect(help).toContain('per-payment receipts');
    expect(help).toContain('If a payment fails');
    expect(help).toContain('awaiting confirmation');
    expect(help).toContain('unavailable is not free');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toContain('tutorial-progress');
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
