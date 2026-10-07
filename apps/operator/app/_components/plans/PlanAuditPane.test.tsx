// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const h = vi.hoisted(() => ({ id: null as string | null, set: vi.fn(), fetch: vi.fn(), toast: vi.fn() }));
vi.mock('nuqs', () => ({ parseAsString: {}, useQueryState: () => [h.id, h.set] }));
vi.mock('sonner', () => ({ toast: { error: h.toast } }));
import PlanAuditPane, { PlanAuditActions, PlanAuditButton } from './PlanAuditPane';
afterEach(() => { cleanup();vi.unstubAllGlobals();vi.resetAllMocks();h.id = null; });
const reply = (body: unknown, status = 200) => ({ ok: status < 400, json: async () => body });
describe('sidebar audit to report', () => {
  it('submits the exact visible selection and opens the durable run', async () => {
    vi.stubGlobal('fetch', h.fetch);h.fetch.mockResolvedValue(reply({ run: { id: 'new-run' } }, 202));
    render(<PlanAuditActions planSlugs={['alpha', 'beta']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Audit visible plans' }));
    await waitFor(() => expect(h.set).toHaveBeenCalledWith('new-run'));
    expect(JSON.parse(h.fetch.mock.calls[0][1].body)).toEqual({ scope: 'visible', planSlugs: ['alpha', 'beta'] });
  });
  it('starts a single audit without triggering the parent plan row', async () => {
    vi.stubGlobal('fetch', h.fetch);h.fetch.mockResolvedValue(reply({ run: { id: 'single' } }));const parent = vi.fn();
    render(<div onClick={parent}><PlanAuditButton planSlug="alpha" /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Audit plan alpha' }));
    await waitFor(() => expect(h.set).toHaveBeenCalledWith('single'));
    expect(parent).not.toHaveBeenCalled();
    expect(JSON.parse(h.fetch.mock.calls[0][1].body)).toEqual({ scope: 'single', planSlugs: ['alpha'] });
  });
  it('shows terminal failure and retries a distinct run with the original scope', async () => {
    h.id = 'old-run';vi.stubGlobal('fetch', h.fetch);
    h.fetch.mockResolvedValueOnce(reply({ run: { id: 'old-run', status: 'failed', scope: 'single', planSlugs: ['alpha'], error: 'Evidence unavailable' } })).mockResolvedValueOnce(reply({ run: { id: 'retry-run' } }));
    render(<PlanAuditPane />);
    expect((await screen.findByRole('alert')).textContent).toContain('Evidence unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry as a new snapshot' }));
    await waitFor(() => expect(h.set).toHaveBeenCalledWith('retry-run'));
  });
  it('reopens completed history in a sandboxed report pane and keeps Back available', async () => {
    h.id = 'saved';vi.stubGlobal('fetch', h.fetch);h.fetch.mockResolvedValue(reply({ run: { id: 'saved', status: 'complete' } }));
    render(<PlanAuditPane />);
    const iframe = await screen.findByTitle('Plan audit report');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-downloads');
    expect(iframe.getAttribute('src')).toContain('runId=saved&format=html');
    fireEvent.click(screen.getByRole('button', { name: '← Back to plans' }));expect(h.set).toHaveBeenCalledWith(null);
  });
});
