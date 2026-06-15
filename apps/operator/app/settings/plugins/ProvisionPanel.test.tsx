// @vitest-environment jsdom
//
// ProvisionPanel — consent + run/teardown/verify driver for one (harness,
// plugin). The pure presentation helpers `shortJson` (audit-data truncation) and
// `kindColor` (event-kind → CSS colour) are extracted + tested. A render-smoke
// drives a mocked /api/provision/state to confirm the not-yet-run consent
// banner (with manifest display name + network reach) and the setup-failed
// banner branches.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProvisionPanel, shortJson, kindColor } from './ProvisionPanel';

const PROVISION = {
  setup: { path: 'setup.sh', displayName: 'Provision Cloudflare', description: 'Creates a pages project' },
  teardown: { path: 'teardown.sh' },
  verify: { path: 'verify.sh' },
  cloudProvider: { id: 'cloudflare', region: 'auto' },
  allowedHosts: ['api.cloudflare.com'],
};

function stubState(body: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch,
  );
}

beforeEach(() => stubState({ ok: true, state: null, audit: [] }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('shortJson', () => {
  it('serializes small objects unchanged', () => {
    expect(shortJson({ a: 1 })).toBe('{"a":1}');
  });
  it('truncates long serializations to 117 chars + ellipsis', () => {
    const big = shortJson({ s: 'x'.repeat(300) });
    expect(big.length).toBe(118);
    expect(big.endsWith('…')).toBe(true);
  });
});

describe('kindColor', () => {
  it('colours failures and rejections as bad', () => {
    expect(kindColor('setup-failed')).toBe('var(--bad)');
    expect(kindColor('consent-rejected')).toBe('var(--bad)');
  });
  it('colours successes green', () => {
    expect(kindColor('setup-succeeded')).toBe('#7fcf7f');
  });
  it('colours log-truncated amber', () => {
    expect(kindColor('log-truncated')).toBe('#e9a040');
  });
  it('falls back to grey for unknown kinds', () => {
    expect(kindColor('script-output')).toBe('#bbb');
  });
});

describe('<ProvisionPanel />', () => {
  it('shows the not-yet-run consent banner with manifest details + network reach', async () => {
    render(<ProvisionPanel harness="my-harness" plugin="@papercupai/cf" provision={PROVISION} />);
    await waitFor(() => expect(screen.getByText(/has not been run/i)).toBeTruthy());
    expect(screen.getByText('Provision Cloudflare')).toBeTruthy();
    expect(screen.getByText('Creates a pages project')).toBeTruthy();
    expect(screen.getByText('cloudflare')).toBeTruthy();
    expect(screen.getByText('api.cloudflare.com')).toBeTruthy();
    // No prior run → primary button reads "Run setup".
    expect(screen.getByText('Run setup')).toBeTruthy();
  });

  it('shows the setup-failed banner with the recorded error', async () => {
    stubState({ ok: true, state: { setupFailed: true, setupError: 'token expired', createdResources: [] }, audit: [] });
    render(<ProvisionPanel harness="h" plugin="p" provision={PROVISION} />);
    await waitFor(() => expect(screen.getByText(/Setup failed\./i)).toBeTruthy());
    expect(screen.getByText('token expired')).toBeTruthy();
  });

  it('renders "Re-run setup" when a prior run recorded hashes', async () => {
    stubState({
      ok: true,
      state: {
        setupFailed: false,
        createdResources: [],
        hashes: { configHash: 'sha256:abcdef0123456789', scriptHash: 'sha256:fedcba9876543210', pluginVersion: '1.2.3' },
      },
      audit: [],
    });
    render(<ProvisionPanel harness="h" plugin="p" provision={PROVISION} />);
    await waitFor(() => expect(screen.getByText('Re-run setup')).toBeTruthy());
  });
});
