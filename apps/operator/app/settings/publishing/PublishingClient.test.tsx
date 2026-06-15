// @vitest-environment jsdom
//
// PublishingClient — the publish-credentials review/rotate page. Real render
// logic: loading → not-registered callout (tenantId null) vs registered
// definition list + rotate/forget controls. A render-smoke drives a mocked
// /api/publish-credentials to confirm both branches. The rotate/forget network
// paths are e2e (they gate on a confirm dialog + remote write).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => false), element: null }),
}));

import PublishingClient from './PublishingClient';

function stubCreds(body: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch,
  );
}

beforeEach(() => stubCreds({ tenantId: null, tenantSecretMasked: null, registeredAt: null, publishHost: null, path: '/x' }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<PublishingClient />', () => {
  it('shows the not-registered callout when there is no tenant', async () => {
    render(<PublishingClient />);
    await waitFor(() => expect(screen.getByText(/Not yet registered\./i)).toBeTruthy());
    // The rotate control is only rendered when registered.
    expect(screen.queryByText('Rotate secret')).toBeNull();
  });

  it('renders the credential definition list + controls when registered', async () => {
    stubCreds({
      tenantId: 'tenant-123',
      tenantSecretMasked: 'sk_••••wxyz',
      registeredAt: '2026-01-01',
      publishHost: 'publish.papercuspai.com',
      path: '/home/x/.papercusp/publish.json',
    });
    render(<PublishingClient />);
    await waitFor(() => expect(screen.getByText('tenant-123')).toBeTruthy());
    expect(screen.getByText('sk_••••wxyz')).toBeTruthy();
    expect(screen.getByText('Rotate secret')).toBeTruthy();
    expect(screen.getByText('Forget credentials')).toBeTruthy();
    expect(screen.queryByText(/Not yet registered/i)).toBeNull();
  });
});
