/**
 * @vitest-environment jsdom
 *
 * CupboardDetailPage — direct-execution actions.
 *
 * blueprint "Fork" (official-blueprints-cupboard-publish-2026-06-05 P-004):
 * POSTs /api/cupboard/install-blueprint {listingId} — clone + validate +
 * dep-check into ~/.papercusp/blueprints/<id>/ — WITHOUT installPlugins (the
 * consent for plugin deps stays explicit; the toast lists installables).
 *
 * plugin / pack "Install" (EI-27): POSTs /api/cupboard/install-plugin
 * {listingId} — clone the listing repo into global-plugins — and surfaces the
 * manifest's requested capabilities + installable deps in a toast. No
 * harness/acceptCapabilities (per-harness capability consent stays explicit at
 * enable-time). Replaces the dead `/harness?cupboardListing=…` navigation no
 * consumer read.
 *
 * (The snapshot "Fork" cases were removed when the `snapshot` listing kind was
 * retired — retire-snapshots-instance-spec-2026-06-09 D-005; reproducible clone
 * is now the lightweight InstanceSpec, not a published Cupboard snapshot.)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { HarnessListing } from '@papercusp/operator-core/lib/cupboard/types';

const h = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }));

vi.mock('@/lib/router-compat/navigation', () => ({
  useRouter: () => ({ push: h.push, back: h.back }),
  useParams: () => ({ id: 'bp-listing-1' }),
}));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import CupboardDetailPage from '../[id]/page';

function listingBase(overrides: Partial<HarnessListing>): HarnessListing {
  return {
    id: 'bp-listing-1' as unknown as number, // worker ids are string uuids
    slug: 'demo-blueprint',
    title: 'Demo blueprint',
    description: 'a published blueprint',
    harness_link: '',
    listing_kind: 'blueprint',
    listing_ref: 'review',
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
  return listingBase({ listing_kind: 'blueprint', listing_ref: 'review', ...overrides });
}

function pluginListing(overrides: Partial<HarnessListing> = {}): HarnessListing {
  return listingBase({
    slug: 'demo-plugin',
    title: 'Demo plugin',
    description: 'a published plugin',
    listing_kind: 'plugin',
    listing_ref: 'demo-plugin',
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
    if (u.includes('/api/cupboard/install-blueprint') || u.includes('/api/cupboard/install-plugin')) {
      void init;
      return new Response(JSON.stringify(action.body), { status: action.status });
    }
    return new Response('{}', { status: 404 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

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
    expect(btn.getAttribute('data-action')).toBe('install');
    fireEvent.click(btn);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/cupboard/install-blueprint'));
      expect(call).toBeTruthy();
      // Consent stays explicit: the button must NOT auto-install plugin deps.
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ listingId: 'bp-listing-1' });
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

describe('CupboardDetailPage — plugin Install (direct global install, EI-27)', () => {
  it('Install POSTs install-plugin with the listing id (no harness/acceptCapabilities) and never navigates to the dead /harness?cupboardListing URL', async () => {
    const fetchMock = mockFetch(pluginListing(), {
      status: 200,
      body: {
        ok: true,
        name: 'demo-plugin',
        version: '1.3.0',
        kind: 'plugin',
        capabilities: ['fs:read', 'net:fetch'],
        installedTo: '/home/u/.papercusp/global-plugins/demo-plugin',
        granted: [],
        installableDependencies: { tools: [], packs: [], plugins: ['repomix'] },
      },
    });
    render(<CupboardDetailPage />);

    const btn = await screen.findByTestId('cupboard-detail-action');
    expect(btn.getAttribute('data-action')).toBe('install');
    fireEvent.click(btn);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/cupboard/install-plugin'));
      expect(call).toBeTruthy();
      // No harness/acceptCapabilities — per-harness consent stays explicit.
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ listingId: 'bp-listing-1' });
    });
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    const msg = String(h.toastSuccess.mock.calls[0][0]);
    expect(msg).toContain('demo-plugin');
    expect(msg).toContain('fs:read');
    expect(msg).toContain('repomix');
    // The dead navigation is gone — installing must NOT route anywhere.
    expect(h.push).not.toHaveBeenCalled();
    // And no blueprint endpoint was hit for a plugin listing.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/cupboard/install-blueprint'))).toBe(false);
  });

  it('surfaces a plugin install failure as a toast and does not navigate', async () => {
    mockFetch(pluginListing(), {
      status: 422,
      body: { ok: false, error: 'dependencies unmet', detail: 'missing tool "ghost"' },
    });
    render(<CupboardDetailPage />);

    const btn = await screen.findByTestId('cupboard-detail-action');
    fireEvent.click(btn);

    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    const msg = String(h.toastError.mock.calls[0][0]);
    expect(msg).toContain('dependencies unmet');
    expect(msg).toContain('missing tool "ghost"');
    expect(h.push).not.toHaveBeenCalled();
  });
});

/**
 * The event axis on the detail page (cupboard-public-release P-008 / D-003).
 *
 * "Provides events" is discovery — what awaiting this unit buys you. "Requires
 * events" is a DECISION surface, and that is why it earns its own section rather
 * than being folded in with the tools: a REQUIRED family that nothing on the host
 * provides is a HARD install failure (P-007's gate), so the required/optional
 * distinction must survive all the way to the screen. Blend them and the page
 * quietly implies "this install will work" when it won't.
 */
describe('CupboardDetailPage — the event axis (P-008)', () => {
  const eventPluginListing = () =>
    pluginListing({
      provides_events: JSON.stringify([
        { family: 'relay:sent', keyTemplate: 'relay:sent:<id>', describe: 'a relay message landed' },
      ]),
      requires_events: JSON.stringify([
        { family: 'deploy:done' },
        { family: 'canary:flipped', optional: true },
      ]),
    });

  it('renders provided families with their KEY TEMPLATE — the thing an awaiter actually parks on', async () => {
    mockFetch(eventPluginListing(), { status: 200, body: { ok: true } });
    render(<CupboardDetailPage />);

    const section = await screen.findByTestId('cupboard-detail-provides-events');
    expect(section).toBeTruthy();
    expect(section.textContent).toContain('relay:sent');
    // Naming the family without its template would leave the user unable to
    // actually await it — the template IS the usable artifact.
    expect(section.textContent).toContain('relay:sent:<id>');
    expect(section.textContent).toContain('a relay message landed');
  });

  it('renders required families and marks REQUIRED vs OPTIONAL distinctly', async () => {
    mockFetch(eventPluginListing(), { status: 200, body: { ok: true } });
    render(<CupboardDetailPage />);

    await screen.findByTestId('cupboard-detail-requires-events');
    const rows = screen.getAllByTestId('cupboard-detail-required-event');
    expect(rows).toHaveLength(2);

    const hard = rows.find((r) => r.getAttribute('data-family') === 'deploy:done');
    const soft = rows.find((r) => r.getAttribute('data-family') === 'canary:flipped');
    // The distinction that decides whether the install SUCCEEDS.
    expect(hard?.getAttribute('data-optional')).toBe('false');
    expect(hard?.textContent).toContain('required');
    expect(soft?.getAttribute('data-optional')).toBe('true');
    expect(soft?.textContent).toContain('optional');
  });

  it('omits both sections when the listing declares no events (a pre-012/013 row)', async () => {
    mockFetch(pluginListing(), { status: 200, body: { ok: true } });
    render(<CupboardDetailPage />);

    // Wait for the page to actually render before asserting an absence, or this
    // passes vacuously against a still-loading page.
    await screen.findByTestId('cupboard-detail-action');
    expect(screen.queryByTestId('cupboard-detail-provides-events')).toBeNull();
    expect(screen.queryByTestId('cupboard-detail-requires-events')).toBeNull();
  });

  it('degrades to no section — never a crashed page — on a MALFORMED declaration', async () => {
    // The row is a third party's declaration. A bad one must cost us the section,
    // not the whole listing page (fail-soft parse; the worker validates on publish).
    mockFetch(
      pluginListing({
        provides_events: '{not json',
        requires_events: JSON.stringify([{ nope: 1 }, { family: 'ok:done' }]),
      }),
      { status: 200, body: { ok: true } },
    );
    render(<CupboardDetailPage />);

    await screen.findByTestId('cupboard-detail-action');
    expect(screen.queryByTestId('cupboard-detail-provides-events')).toBeNull();
    // The one WELL-FORMED entry still renders; only the junk entry is dropped.
    const rows = screen.getAllByTestId('cupboard-detail-required-event');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-family')).toBe('ok:done');
  });
});
