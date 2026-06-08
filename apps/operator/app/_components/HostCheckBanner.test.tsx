// @vitest-environment jsdom
/**
 * Tests for <HostCheckBanner> — the one-time shared-host acknowledgement banner.
 *
 * Covers: fetches /api/provision/host-check on mount; renders only on
 * `decision: 'gate'` (and only when the payload is `ok`); shows the larger of
 * the active/configured user counts; the acknowledge POST flips to
 * allow-acked and hides the banner; and silent fallbacks (non-ok / reject /
 * non-gate → nothing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { HostCheckBanner } from './HostCheckBanner';

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function gate(active: string[], configured: string[]) {
  return okJson({
    ok: true,
    decision: 'gate',
    signals: { activeUsers: active, configuredUsers: configured, isShared: true },
  });
}

describe('HostCheckBanner', () => {
  it('renders nothing for a non-gate decision', async () => {
    mockFetch.mockResolvedValue(okJson({ ok: true, decision: 'allow', signals: { activeUsers: [], configuredUsers: [], isShared: false } }));
    const { container } = render(<HostCheckBanner />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders the banner on a gate decision with the larger user count', async () => {
    mockFetch.mockResolvedValue(gate(['a', 'b'], ['a', 'b', 'c']));
    render(<HostCheckBanner />);
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('Shared host detected.');
    // userCount = max(2 active, 3 configured) = 3
    expect(banner.textContent).toContain('3 users');
    expect(banner.textContent).toContain('(2 active, 3 configured)');
  });

  it('acknowledges and hides the banner on the POST', async () => {
    mockFetch.mockResolvedValueOnce(gate(['a'], ['a', 'b'])); // GET
    mockFetch.mockResolvedValueOnce(okJson({ ok: true })); // POST
    render(<HostCheckBanner />);
    const btn = await screen.findByRole('button', { name: 'I understand' });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    // The second call was the acknowledge POST.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, init] = mockFetch.mock.calls[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ acknowledge: true });
  });

  it('stays hidden when the host-check fetch is not ok', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    const { container } = render(<HostCheckBanner />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('stays hidden when the fetch rejects', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const { container } = render(<HostCheckBanner />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
