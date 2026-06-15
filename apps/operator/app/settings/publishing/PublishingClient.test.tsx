// @vitest-environment jsdom
//
// PublishingClient — the publish-credentials review/rotate page. Real render
// logic: loading → not-registered callout (tenantId null) vs registered
// definition list + rotate/forget controls. Beyond the two render branches, the
// rotate/forget handlers gate on a `useConfirmDialog().confirm` callback — the
// exact destructure-the-wrong-keys class of bug that hid in BackupsTab. So the
// interaction tests click Rotate/Forget with the confirm spy returning
// true/false and assert: confirm fired with the right copy, the gated network
// write happened (or didn't), success/error toasts, and the busy gate.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// confirmSpy is reconfigured per-test (true/false). If PublishingClient ever
// destructures the wrong key from useConfirmDialog (as BackupsTab once did),
// askConfirm would be undefined and the click handler would throw — these tests
// would catch it because they exercise the handler, not just render it.
const { confirmSpy } = vi.hoisted(() => ({ confirmSpy: vi.fn(async () => true) }));
vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmSpy, element: null }),
}));

import PublishingClient from './PublishingClient';

const REGISTERED = {
  tenantId: 'tenant-123',
  tenantSecretMasked: 'sk_••••wxyz',
  registeredAt: '2026-01-01',
  publishHost: 'publish.papercuspai.com',
  path: '/home/x/.papercusp/publish.json',
};
const NOT_REGISTERED = { tenantId: null, tenantSecretMasked: null, registeredAt: null, publishHost: null, path: '/x' };

beforeEach(() => {
  confirmSpy.mockClear();
  confirmSpy.mockResolvedValue(true);
  (toast.success as ReturnType<typeof vi.fn>).mockClear();
  (toast.error as ReturnType<typeof vi.fn>).mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => NOT_REGISTERED }) as Response));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<PublishingClient /> render branches', () => {
  it('shows the not-registered callout when there is no tenant', async () => {
    render(<PublishingClient />);
    await waitFor(() => expect(screen.getByText(/Not yet registered\./i)).toBeTruthy());
    expect(screen.queryByText('Rotate secret')).toBeNull();
  });

  it('renders the credential definition list + controls when registered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => REGISTERED }) as Response));
    render(<PublishingClient />);
    await waitFor(() => expect(screen.getByText('tenant-123')).toBeTruthy());
    expect(screen.getByText('sk_••••wxyz')).toBeTruthy();
    expect(screen.getByText('Rotate secret')).toBeTruthy();
    expect(screen.getByText('Forget credentials')).toBeTruthy();
    expect(screen.queryByText(/Not yet registered/i)).toBeNull();
  });
});

describe('<PublishingClient /> rotate flow (confirm-gated handler)', () => {
  // GET config → registered; route POST /rotate to a fresh masked secret.
  const stubRotate = (rotateResponse: () => Response) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/rotate') && init?.method === 'POST') return rotateResponse();
      return { ok: true, json: async () => REGISTERED } as Response;
    }));
  };

  it('Rotate confirms, POSTs, swaps the masked secret and toasts success', async () => {
    stubRotate(() => ({ ok: true, json: async () => ({ ...REGISTERED, tenantSecretMasked: 'sk_••••newv' }) }) as Response);
    render(<PublishingClient />);
    await screen.findByText('Rotate secret');

    fireEvent.click(screen.getByText('Rotate secret'));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0][0]).toMatchObject({ title: 'Rotate the publish secret?', destructive: true });
    await waitFor(() => expect(screen.getByText('sk_••••newv')).toBeTruthy());
    expect(toast.success).toHaveBeenCalledWith('Secret rotated.');
  });

  it('Rotate is a no-op when the user declines the confirm', async () => {
    confirmSpy.mockResolvedValue(false);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/rotate')) return { ok: true, json: async () => REGISTERED } as Response;
      return { ok: true, json: async () => REGISTERED } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublishingClient />);
    await screen.findByText('Rotate secret');

    fireEvent.click(screen.getByText('Rotate secret'));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    // No /rotate POST happened — only the initial GET.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/rotate'))).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('surfaces a rotate failure (non-ok with error body) via toast.error', async () => {
    stubRotate(() => ({ ok: false, status: 500, json: async () => ({ error: 'marketplace unreachable' }) }) as Response);
    render(<PublishingClient />);
    await screen.findByText('Rotate secret');

    fireEvent.click(screen.getByText('Rotate secret'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('rotate failed: marketplace unreachable'));
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('<PublishingClient /> forget flow', () => {
  it('Forget confirms, DELETEs, reloads to the not-registered state and toasts', async () => {
    let deleted = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/publish-credentials' && init?.method === 'DELETE') {
        deleted = true;
        return { ok: true, json: async () => ({}) } as Response;
      }
      // After the DELETE, the reload GET returns the not-registered shape.
      return { ok: true, json: async () => (deleted ? NOT_REGISTERED : REGISTERED) } as Response;
    }));
    render(<PublishingClient />);
    await screen.findByText('Forget credentials');

    fireEvent.click(screen.getByText('Forget credentials'));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0][0]).toMatchObject({ title: 'Delete local publish credentials?', destructive: true });
    await waitFor(() => expect(screen.getByText(/Not yet registered/i)).toBeTruthy());
    expect(toast.success).toHaveBeenCalledWith('Credentials cleared.');
  });
});
