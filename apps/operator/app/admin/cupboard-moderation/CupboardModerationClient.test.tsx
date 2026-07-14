// @vitest-environment jsdom
//
// CupboardModerationClient — operator moderation UI (Phase 9 D-002). Two pure
// helpers are extracted + exported: safeHttpUrl (XSS href guard) and fmtTime.
// The render-smoke drives the self-fetching client (pending-review queue + the
// abuse-report queue) against a mocked global fetch — both queues fetch on
// mount, so the smoke asserts the loading→loaded surfaces and the 401/403 auth
// error mapping.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import CupboardModerationClient, { safeHttpUrl, fmtTime } from './CupboardModerationClient';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('safeHttpUrl (pure)', () => {
  it('accepts http and https URLs', () => {
    expect(safeHttpUrl('https://github.com/x/y')).toBe('https://github.com/x/y');
    expect(safeHttpUrl('http://example.com/')).toBe('http://example.com/');
  });
  it('rejects javascript: and data: hrefs (XSS guard)', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>')).toBeNull();
  });
  it('rejects null and unparseable input', () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
  });
});

describe('fmtTime (pure)', () => {
  it('returns an em-dash for null or 0', () => {
    expect(fmtTime(null)).toBe('—');
    expect(fmtTime(0)).toBe('—');
  });
  it('formats a real epoch-ms timestamp to a locale string', () => {
    expect(fmtTime(1_700_000_000_000)).toEqual(expect.any(String));
    expect(fmtTime(1_700_000_000_000)).not.toBe('—');
  });
});

/** Route the two on-mount fetches (pending queue, reports) to canned payloads. */
function routeFetch(opts: {
  pending?: { ok?: boolean; status?: number; body: unknown };
  reports?: { ok?: boolean; status?: number; body: unknown };
}) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/admin/pending')) {
      const p = opts.pending ?? { ok: true, body: { pending: [] } };
      return Promise.resolve({ ok: p.ok ?? true, status: p.status ?? 200, json: async () => p.body });
    }
    const r = opts.reports ?? { ok: true, body: { reports: [] } };
    return Promise.resolve({ ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body });
  });
}

function renderClient(searchParams = '?') {
  return render(<CupboardModerationClient />, {
    wrapper: withNuqsTestingAdapter({ searchParams }),
  });
}

describe('<CupboardModerationClient />', () => {
  it('renders both queue empty-states once the mount fetches resolve', async () => {
    routeFetch({ pending: { body: { pending: [] } }, reports: { body: { reports: [] } } });
    renderClient();
    await waitFor(() => expect(screen.getByText(/no listings awaiting review/i)).toBeTruthy());
    expect(screen.getByText(/no pending reports/i)).toBeTruthy();
  });

  it('renders a pending review card with a safe repo link', async () => {
    routeFetch({
      pending: {
        body: {
          pending: [
            {
              id: 'L1', listing_kind: 'knowledge-pack', listing_ref: 'ref-1', title: 'My Pack',
              description: 'a pack', github_url: 'https://github.com/o/r',
              publisher_github_login: 'octocat', created_at: 1_700_000_000_000,
            },
          ],
        },
      },
    });
    renderClient();
    await waitFor(() => expect(screen.getByTestId('pending-review-card')).toBeTruthy());
    expect(screen.getByText('My Pack')).toBeTruthy();
    const link = screen.getByText(/review the content/i).closest('a');
    expect(link?.getAttribute('href')).toBe('https://github.com/o/r');
  });

  it('surfaces the executable provenance for a pending app (release repo + signed manifest + platforms)', async () => {
    // cupboard-app-distribution P-006: an app distributes a runnable installer —
    // the moderator must review WHERE the binary comes from, not just the source
    // repo. The worker returns the raw row (SELECT *), so the app fields ride along.
    routeFetch({
      pending: {
        body: {
          pending: [
            {
              id: 'A1', listing_kind: 'app', listing_ref: null, title: 'Oddsmith',
              description: 'a desktop app', github_url: 'https://github.com/acme/oddsmith-src',
              publisher_github_login: 'acme', created_at: 1_700_000_000_000,
              delivery_type: 'standalone', release_repo: 'acme/oddsmith',
              latest_json_url: 'https://github.com/acme/oddsmith/releases/latest/download/latest.json',
              platforms: JSON.stringify(['darwin-aarch64', 'linux-x86_64']),
            },
          ],
        },
      },
    });
    renderClient();
    await waitFor(() => expect(screen.getByTestId('pending-review-app-trust')).toBeTruthy());
    // The release the installers come from — the trust-critical surface.
    const release = screen.getByTestId('pending-review-app-release');
    expect(release.getAttribute('href')).toBe('https://github.com/acme/oddsmith/releases');
    // The signed updater manifest.
    const manifest = screen.getByTestId('pending-review-app-manifest');
    expect(manifest.getAttribute('href')).toBe(
      'https://github.com/acme/oddsmith/releases/latest/download/latest.json',
    );
    // Platform availability derived from the denormalized column.
    const trust = screen.getByTestId('pending-review-app-trust');
    expect(trust.textContent).toContain('macOS');
    expect(trust.textContent).toContain('Linux');
    // The caution reframes for an executable — not "injected into agents".
    expect(screen.getByText(/runnable installer — verify its release provenance/i)).toBeTruthy();
  });

  it('shows no app-trust block for a non-app pending listing', async () => {
    routeFetch({
      pending: {
        body: {
          pending: [
            {
              id: 'L2', listing_kind: 'blueprint', listing_ref: 'bp', title: 'A Blueprint',
              description: null, github_url: 'https://github.com/o/bp',
              publisher_github_login: 'octocat', created_at: 1_700_000_000_000,
            },
          ],
        },
      },
    });
    renderClient();
    await waitFor(() => expect(screen.getByTestId('pending-review-card')).toBeTruthy());
    expect(screen.queryByTestId('pending-review-app-trust')).toBeNull();
    // The non-app caution still applies.
    expect(screen.getByText(/injected into agents/i)).toBeTruthy();
  });

  it('renders an abuse-report card and filters out an unsafe github url', async () => {
    routeFetch({
      reports: {
        body: {
          reports: [
            {
              id: 'R1', harness_id: 'h1', reporter_github_login: 'reporter', reporter_github_user_id: 1,
              reason: 'spam listing', status: 'pending', resolved_at: null,
              resolved_by_operator_note: null, created_at: 1_700_000_000_000,
              harness_title: 'Bad Harness', harness_github_url: 'javascript:alert(1)',
              harness_unlisted_at: null,
            },
          ],
        },
      },
    });
    renderClient();
    await waitFor(() => expect(screen.getByText('Bad Harness')).toBeTruthy());
    expect(screen.getByText('spam listing')).toBeTruthy();
    // The javascript: url is filtered, so no "repo" link is rendered.
    expect(screen.queryByText(/^repo$/i)).toBeNull();
  });

  it('maps a 401 to the gh-auth error message', async () => {
    routeFetch({
      pending: { ok: false, status: 401, body: {} },
      reports: { ok: false, status: 401, body: {} },
    });
    renderClient();
    await waitFor(() =>
      expect(screen.getAllByText(/github sign-in required/i).length).toBeGreaterThan(0),
    );
  });

  it('maps a 403 to the not-an-operator error message', async () => {
    routeFetch({
      pending: { ok: false, status: 403, body: {} },
      reports: { ok: false, status: 403, body: {} },
    });
    renderClient();
    await waitFor(() =>
      expect(screen.getAllByText(/not a cupboard operator/i).length).toBeGreaterThan(0),
    );
  });
});
