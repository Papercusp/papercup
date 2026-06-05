/**
 * @vitest-environment jsdom
 *
 * CupboardDetailPage — direct-execution actions.
 *
 * snapshot "Fork" (revive-cupboard D-008): POSTs
 * /api/snapshots/fork-from-cupboard {listing_id}, which pulls the tarball from
 * the Cupboard R2 store, verifies it, and restore()s a new local harness — then
 * navigates to it.
 *
 * blueprint "Fork" (official-blueprints-cupboard-publish-2026-06-05 P-004):
 * POSTs /api/cupboard/install-blueprint {listingId} — clone + validate +
 * dep-check into ~/.papercusp/blueprints/<id>/ — WITHOUT installPlugins (the
 * consent for plugin deps stays explicit; the toast lists installables).
 *
 * Plugin install keeps its plugin-host hand-off (not exercised here).
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

function blueprintListing(overrides: Partial<HarnessListing> = {}): HarnessListing {
  return snapshotListing({
    slug: 'demo-blueprint',
    title: 'Demo blueprint',
    description: 'a published blueprint',
    listing_kind: 'blueprint',
    listing_ref: 'review',
    tarball_content_hash: undefined as unknown as string,
    ...overrides,
  });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

function mockFetch(listing: HarnessListing, action: { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/cupboard/listings/')) {
      return new Response(JSON.stringify({ listing }), { status: 200 });
    }
    if (u.includes('/api/snapshots/fork-from-cupboard') || u.includes('/api/cupboard/install-blueprint')) {
      void init;
      return new Response(JSON.stringify(action.body), { status: action.status });
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

describe('CupboardDetailPage — blueprint Fork (install into the local installed tier)', () => {
  it('Fork POSTs install-blueprint with the listing id (no installPlugins) and toasts installable plugin deps', async () => {
    const fetchMock = mockFetch(blueprintListing(), {
      status: 200,
      body: {
        ok: true,
        id: 'review',
        version: '0.2.0',
        installedTo: '/home/u/.papercusp/blueprints/review',
        depCheck: { ok: true, installable: { plugins: ['repomix'] } },
      },
    });
    render(<CupboardDetailPage />);

    const btn = await screen.findByTestId('cupboard-detail-action');
    expect(btn.getAttribute('data-action')).toBe('fork');
    fireEvent.click(btn);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/cupboard/install-blueprint'));
      expect(call).toBeTruthy();
      // Consent stays explicit: the button must NOT auto-install plugin deps.
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ listingId: 'snap-listing-1' });
    });
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    const msg = String(h.toastSuccess.mock.calls[0][0]);
    expect(msg).toContain('review');
    expect(msg).toContain('repomix');
    // No navigation for a blueprint install — it lands in ~/.papercusp/blueprints.
    expect(h.push).not.toHaveBeenCalled();
  });

  it('surfaces an install failure (e.g. dep-validation 422) as a toast', async () => {
    mockFetch(blueprintListing(), {
      status: 422,
      body: { ok: false, error: 'blueprint dependencies unresolvable', detail: 'needs plugin "ghost"' },
    });
    render(<CupboardDetailPage />);

    const btn = await screen.findByTestId('cupboard-detail-action');
    fireEvent.click(btn);

    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    const msg = String(h.toastError.mock.calls[0][0]);
    expect(msg).toContain('dependencies unresolvable');
    expect(msg).toContain('needs plugin "ghost"');
    expect(h.push).not.toHaveBeenCalled();
  });
});
