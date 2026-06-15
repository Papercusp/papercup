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
              id: 'L1', listing_kind: 'learning-pack', listing_ref: 'ref-1', title: 'My Pack',
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
