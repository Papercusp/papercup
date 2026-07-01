// @vitest-environment jsdom
/**
 * Tests for <HostCheckBanner> — the one-time shared-host acknowledgement banner.
 *
 * Covers: primes the passwordless session via GET /api/auth/me BEFORE firing
 * /api/provision/host-check (the auth-bootstrap race fix — see the docstring
 * in HostCheckBanner.tsx); renders only on `decision: 'gate'` (and only when
 * the payload is `ok`); shows the larger of the active/configured user
 * counts; the acknowledge POST flips to allow-acked and hides the banner;
 * and silent fallbacks (non-ok / reject / non-gate / auth/me itself failing
 * → nothing throws, host-check still fires).
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
/** Generic stand-in for the priming GET /api/auth/me response — its body is
 * never read by the component, only its settling order matters. */
function authMeOk(): Response {
  return okJson({ user: { id: 'default' }, autoLogin: true, available: [] });
}

describe('HostCheckBanner', () => {
  it('primes the session via /api/auth/me BEFORE firing /api/provision/host-check', async () => {
    mockFetch.mockResolvedValueOnce(authMeOk());
    mockFetch.mockResolvedValueOnce(
      okJson({ ok: true, decision: 'allow', signals: { activeUsers: [], configuredUsers: [], isShared: false } }),
    );
    render(<HostCheckBanner />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockFetch.mock.calls[0][0]).toBe('/api/auth/me');
    expect(mockFetch.mock.calls[1][0]).toBe('/api/provision/host-check');
  });

  it('renders nothing for a non-gate decision', async () => {
    mockFetch.mockResolvedValueOnce(authMeOk());
    mockFetch.mockResolvedValueOnce(
      okJson({ ok: true, decision: 'allow', signals: { activeUsers: [], configuredUsers: [], isShared: false } }),
    );
    const { container } = render(<HostCheckBanner />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders the banner on a gate decision with the larger user count', async () => {
    mockFetch.mockResolvedValueOnce(authMeOk());
    mockFetch.mockResolvedValueOnce(gate(['a', 'b'], ['a', 'b', 'c']));
    render(<HostCheckBanner />);
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('Shared host detected.');
    // userCount = max(2 active, 3 configured) = 3
    expect(banner.textContent).toContain('3 users');
    expect(banner.textContent).toContain('(2 active, 3 configured)');
  });

  it('acknowledges and hides the banner on the POST', async () => {
    mockFetch.mockResolvedValueOnce(authMeOk()); // GET /api/auth/me (priming)
    mockFetch.mockResolvedValueOnce(gate(['a'], ['a', 'b'])); // GET host-check
    mockFetch.mockResolvedValueOnce(okJson({ ok: true })); // POST acknowledge
    render(<HostCheckBanner />);
    const btn = await screen.findByRole('button', { name: 'I understand' });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // The third call was the acknowledge POST.
    const [, init] = mockFetch.mock.calls[2];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ acknowledge: true });
  });

  it('stays hidden when the host-check fetch is not ok', async () => {
    mockFetch.mockResolvedValueOnce(authMeOk());
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    const { container } = render(<HostCheckBanner />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('stays hidden when the host-check fetch rejects', async () => {
    mockFetch.mockResolvedValueOnce(authMeOk());
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    const { container } = render(<HostCheckBanner />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('still fires host-check even when the /api/auth/me priming call itself rejects', async () => {
    // Regression guard for the race fix: a failed priming fetch must not
    // block the host-check request behind it (best-effort priming only).
    mockFetch.mockRejectedValueOnce(new Error('auth/me down'));
    mockFetch.mockResolvedValueOnce(gate(['a'], ['a', 'b']));
    render(<HostCheckBanner />);
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('Shared host detected.');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
