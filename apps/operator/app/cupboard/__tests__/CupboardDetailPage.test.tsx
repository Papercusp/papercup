/**
 * @vitest-environment jsdom
 *
 * CupboardDetailPage — snapshot "Fork" action (revive-cupboard D-008).
 *
 * A snapshot listing's Fork button is CROSS-MACHINE: it POSTs
 * /api/snapshots/fork-from-cupboard {listing_id}, which pulls the tarball from
 * the Cupboard R2 store, verifies it, and restore()s a new local harness — then
 * navigates to it. Blueprint/plugin actions keep their E1/E2 + plugin-host
 * hand-off (not exercised here).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { HarnessListing } from '@papercusp/operator-core/lib/cupboard/types';

const h = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }));

vi.mock('@/lib/router-compat/navigation', () => ({
  useRouter: () => ({ push: h.push, back: h.back }),
  useParams: () => ({ id: 'snap-listing-1' }),
}));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import CupboardDetailPage from '../[id]/page';

function snapshotListing(overrides: Partial<HarnessListing> = {}): HarnessListing {
  return {
    id: 'snap-listing-1' as unknown as number, // worker ids are string uuids
    slug: 'demo-snap',
    title: 'Demo snapshot',
    description: 'a captured snapshot',
    harness_link: '',
    listing_kind: 'snapshot',
    listing_ref: 'snap_abc',
    tarball_content_hash: 'a'.repeat(64),
    github_repository_id: 7,
    github_repo: 'papercupai/demo',
    github_repo_must_be_public: true,
    published_by_github_user_id: 10,
    provisional_owner_github_user_id: 10,
    claim_status: 'unclaimed',
    claimed_at: null,
    last_permission_verified_at: null,
    superseded_by_harness_id: null,
    contributor_count_estimate: 0,
    last_activity_at: null,
    language: null,
    tags: [],
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

function mockFetch(listing: HarnessListing, fork: { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/cupboard/listings/')) {
      return new Response(JSON.stringify({ listing }), { status: 200 });
    }
    if (u.includes('/api/snapshots/fork-from-cupboard')) {
      void init;
      return new Response(JSON.stringify(fork.body), { status: fork.status });
    }
    return new Response('{}', { status: 404 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('CupboardDetailPage — snapshot Fork (cross-machine)', () => {
  it('Fork POSTs fork-from-cupboard with the listing id, then navigates to the new harness', async () => {
    const fetchMock = mockFetch(snapshotListing(), { status: 200, body: { ok: true, newSlug: 'forked-harness' } });
    render(<CupboardDetailPage />);

    const btn = await screen.findByTestId('cupboard-detail-action');
    expect(btn.getAttribute('data-action')).toBe('fork');
    fireEvent.click(btn);

    await waitFor(() => {
      const forkCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/snapshots/fork-from-cupboard'));
      expect(forkCall).toBeTruthy();
      expect(JSON.parse(String((forkCall![1] as RequestInit).body))).toEqual({ listing_id: 'snap-listing-1' });
    });
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/harness/forked-harness'));
    expect(h.toastSuccess).toHaveBeenCalledWith('Forked snapshot → forked-harness');
  });

  it('surfaces a fork failure (e.g. metadata-only snapshot 422) as a toast, no navigation', async () => {
    mockFetch(snapshotListing(), {
      status: 422,
      body: { ok: false, error: 'metadata-only', hint: 'local-fork only' },
    });
    render(<CupboardDetailPage />);

    const btn = await screen.findByTestId('cupboard-detail-action');
    fireEvent.click(btn);

    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(String(h.toastError.mock.calls[0][0])).toContain('metadata-only');
    expect(h.push).not.toHaveBeenCalled();
  });
});
