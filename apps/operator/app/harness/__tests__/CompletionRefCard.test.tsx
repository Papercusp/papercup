/**
 * @vitest-environment jsdom
 *
 * P-017a — CompletionRefCard renders correctly for each of the three
 * verification states: verified, pending (unverified), divergent.
 * Also covers the P-017b trust-tier badge helper and the P-017c
 * Re-check button behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { CompletionRefCard, getTrustTierBadge } from '../CompletionRefCard';

const BASE_REF = {
  remote: 'git@github.com:org/repo.git',
  branch: 'user/42',
  commit_sha: 'abcdef1234567890abcdef1234567890abcdef12',
  pr_url: 'https://github.com/org/repo/pull/99',
  pr_number: 99,
};

function makeFeatureResponse(overrides: Record<string, unknown> = {}) {
  return {
    feature: {
      id: 'F-TEST-001',
      title: 'Test feature',
      status: 'pending_done',
      completion_ref: BASE_REF,
      verified_done_at_remote_ts: null,
      verifier_last_error: null,
      verifier_last_checked_at: null,
      ...overrides,
    },
  };
}

afterEach(() => cleanup());

// ── getTrustTierBadge (P-017b) ────────────────────────────────────────

describe('getTrustTierBadge', () => {
  it('returns tier-B for verified', () => {
    const b = getTrustTierBadge('B');
    expect(b.label).toContain('B');
    expect(b.color).toBeTruthy();
  });
  it('returns tier-C for pending', () => {
    const b = getTrustTierBadge('C');
    expect(b.label).toContain('C');
  });
  it('returns warning badge for divergent', () => {
    const b = getTrustTierBadge('warning');
    expect(b.label).toContain('⚠');
  });
});

// ── CompletionRefCard — not-shown for non-completable statuses ────────

describe('CompletionRefCard – non-completable statuses', () => {
  it('renders nothing for todo status', () => {
    const { container } = render(
      <CompletionRefCard slug="test" featureId="F-001" status="todo" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for validating status', () => {
    const { container } = render(
      <CompletionRefCard slug="test" featureId="F-001" status="validating" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

// ── CompletionRefCard — verified state ───────────────────────────────

describe('CompletionRefCard – verified', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeFeatureResponse({
        verified_done_at_remote_ts: new Date(Date.now() - 60_000).toISOString(),
        verifier_last_checked_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows tier-B badge and short SHA', async () => {
    render(<CompletionRefCard slug="test" featureId="F-TEST-001" status="pending_done" />);
    await waitFor(() => expect(screen.queryByText('Checking verification…')).toBeNull());
    expect(screen.getByTitle(/tier b/i)).toBeTruthy();
    expect(screen.getByText(/abcdef12/i)).toBeTruthy();
  });

  it('shows branch name', async () => {
    render(<CompletionRefCard slug="test" featureId="F-TEST-001" status="shipped" />);
    await waitFor(() => expect(screen.queryByText('Checking verification…')).toBeNull());
    expect(screen.getByText(/user\/42/)).toBeTruthy();
  });

  it('renders a PR link', async () => {
    render(<CompletionRefCard slug="test" featureId="F-TEST-001" status="pending_done" />);
    await waitFor(() => expect(screen.queryByText('Checking verification…')).toBeNull());
    const link = screen.getByRole('link') as HTMLAnchorElement;
    expect(link.href).toContain('/pull/99');
  });
});

// ── CompletionRefCard — pending state ────────────────────────────────

describe('CompletionRefCard – pending (not yet verified)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeFeatureResponse({
        verifier_last_checked_at: new Date(Date.now() - 120_000).toISOString(),
      }),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows tier-C badge and "verifying…" text', async () => {
    render(<CompletionRefCard slug="test" featureId="F-TEST-001" status="pending_done" />);
    await waitFor(() => expect(screen.queryByText('Checking verification…')).toBeNull());
    expect(screen.getByTitle(/tier c/i)).toBeTruthy();
    expect(screen.getByText(/verifying…/i)).toBeTruthy();
  });

  it('shows Re-check button', async () => {
    render(<CompletionRefCard slug="test" featureId="F-TEST-001" status="pending_done" />);
    await waitFor(() => screen.getByText(/re-check/i));
    expect(screen.getByText(/re-check/i)).toBeTruthy();
  });
});

// ── CompletionRefCard — divergent state ──────────────────────────────

describe('CompletionRefCard – divergent', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeFeatureResponse({
        verifier_last_error: 'sha_not_found',
        verifier_last_checked_at: new Date(Date.now() - 300_000).toISOString(),
      }),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows warning badge and divergence message', async () => {
    render(<CompletionRefCard slug="test" featureId="F-TEST-001" status="failing" />);
    await waitFor(() => expect(screen.queryByText('Checking verification…')).toBeNull());
    expect(screen.getByTitle(/divergence detected/i)).toBeTruthy();
    expect(screen.getByText(/no longer present/i)).toBeTruthy();
  });

  it('Re-check button calls the recheck endpoint (P-017c)', async () => {
    // After initial load, subsequent calls handle the recheck POST
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => makeFeatureResponse({ verifier_last_error: 'sha_not_found', verifier_last_checked_at: new Date().toISOString() }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // recheck POST
    vi.stubGlobal('fetch', mockFetch);

    render(<CompletionRefCard slug="test" featureId="F-TEST-001" status="failing" />);
    await waitFor(() => screen.getByRole('button', { name: /re-check/i }));

    fireEvent.click(screen.getByRole('button', { name: /re-check/i }));

    await waitFor(() => {
      const calls = mockFetch.mock.calls as [string, RequestInit?][];
      const recheckCall = calls.find(([url]) => url.includes('completion-ref/recheck'));
      expect(recheckCall).toBeTruthy();
      expect(recheckCall?.[1]?.method).toBe('POST');
    });
  });
});

// ── CompletionRefCard — no completion_ref ────────────────────────────

describe('CompletionRefCard – no completion_ref', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeFeatureResponse({ completion_ref: null }),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders nothing when completion_ref is null', async () => {
    const { container } = render(
      <CompletionRefCard slug="test" featureId="F-TEST-001" status="pending_done" />,
    );
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
