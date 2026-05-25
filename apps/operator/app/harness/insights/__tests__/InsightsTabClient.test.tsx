/**
 * @vitest-environment jsdom
 *
 * InsightsTabClient — Phase 8 P-073 client wrapper tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { InsightsTabClient } from '../InsightsTabClient';
import type { InsightsTabProps } from '../InsightsTab';

afterEach(() => {
  cleanup();
});

function makeInsights(slug: string): InsightsTabProps {
  return {
    project: {
      name: slug,
      description: '',
      ownerDisplayName: 'unknown',
      claimStatus: 'unclaimed',
      githubUrl: `https://github.com/${slug}`,
    },
    activity: { events: [] },
    people: { people: [] },
    yourPlace: {
      queue: { queued: 0, working: 0, shipped_this_week: 0 },
      role: {
        pr_reviewer_enabled: false,
        is_provisional_owner: false,
        is_claimant: false,
      },
      trust: { trusted_authors_count: 0, trusted_by_count: 0 },
      spend: { spent_usd_this_week: 0 },
    },
    howItWorks: {
      harnessName: slug,
      config: {
        has_orchestrator: true,
        pr_reviewer_role_enabled: false,
        auto_review: false,
        auto_merge: false,
        merge_method: 'squash',
        branch_policy: 'feature-branch',
      },
    },
    spend: {
      harnessTotalUsdThisWeek: 0,
      viewerUsdThisWeek: 0,
    },
  };
}

function mockFetchOk(insights: InsightsTabProps): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ insights }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

function mockFetchFail(status: number): typeof fetch {
  return vi.fn(async () => new Response('', { status })) as unknown as typeof fetch;
}

describe('InsightsTabClient', () => {
  it('renders the loading state initially', async () => {
    // never-resolving fetch keeps it pinned in loading
    const fetchImpl = vi.fn(
      () => new Promise(() => {}),
    ) as unknown as typeof fetch;
    render(<InsightsTabClient slug="papercup" fetchImpl={fetchImpl} />);
    expect(screen.getByTestId('insights-tab-client-loading')).toBeTruthy();
  });

  it('renders InsightsTab after a successful fetch', async () => {
    const fetchImpl = mockFetchOk(makeInsights('papercup'));
    render(<InsightsTabClient slug="papercup" fetchImpl={fetchImpl} />);
    await waitFor(() => {
      expect(screen.getByTestId('insights-tab')).toBeTruthy();
    });
    expect(screen.getByTestId('insights-project-card').textContent).toContain(
      'papercup',
    );
  });

  it('renders the error state on non-2xx', async () => {
    const fetchImpl = mockFetchFail(500);
    render(<InsightsTabClient slug="papercup" fetchImpl={fetchImpl} />);
    await waitFor(() => {
      expect(screen.getByTestId('insights-tab-client-error')).toBeTruthy();
    });
    expect(
      screen.getByTestId('insights-tab-client-error').textContent,
    ).toContain('HTTP 500');
  });

  it('renders error on missing envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    render(<InsightsTabClient slug="papercup" fetchImpl={fetchImpl} />);
    await waitFor(() => {
      expect(screen.getByTestId('insights-tab-client-error')).toBeTruthy();
    });
    expect(
      screen.getByTestId('insights-tab-client-error').textContent,
    ).toContain('insights');
  });

  it('appends activity_limit query param when provided', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const str = typeof url === 'string' ? url : (url as URL).toString();
      expect(str).toContain('activity_limit=7');
      return new Response(JSON.stringify({ insights: makeInsights('papercup') }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    render(
      <InsightsTabClient
        slug="papercup"
        activityLimit={7}
        fetchImpl={fetchImpl}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('insights-tab')).toBeTruthy();
    });
  });

  it('re-fetches when slug changes', async () => {
    const fetches: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const str = typeof url === 'string' ? url : (url as URL).toString();
      fetches.push(str);
      return new Response(JSON.stringify({ insights: makeInsights(str) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const { rerender } = render(
      <InsightsTabClient slug="a" fetchImpl={fetchImpl} />,
    );
    await waitFor(() => {
      expect(fetches.some((u) => u.includes('/a/insights'))).toBe(true);
    });
    rerender(<InsightsTabClient slug="b" fetchImpl={fetchImpl} />);
    await waitFor(() => {
      expect(fetches.some((u) => u.includes('/b/insights'))).toBe(true);
    });
  });
});
