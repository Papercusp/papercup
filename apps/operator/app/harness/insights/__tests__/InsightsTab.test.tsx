/**
 * @vitest-environment jsdom
 *
 * InsightsTab — P-073 assembly + B-TOK-UI sub-tab tests.
 *
 * The Overview sub-view is the original render-only six-card layout; the Tokens
 * sub-view is the self-fetching TokensView (stubbed here so the shell test needs no
 * sync provider — TokensView's own data rendering is covered by load-tokens tests).
 */

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { InsightsTab, type InsightsTabProps } from '../InsightsTab';

// Stub the self-fetching Tokens view — the shell test only verifies routing +
// slug threading, not the live query (covered by load-tokens.test.ts).
vi.mock('../TokensView', () => ({
  TokensView: ({ slug }: { slug: string }) => <div data-testid="tokens-view-stub">tokens:{slug}</div>,
}));

afterEach(() => {
  cleanup();
});

function Wrap({ children, search }: { children: ReactNode; search?: Record<string, string> }) {
  return <NuqsTestingAdapter searchParams={search ?? {}}>{children}</NuqsTestingAdapter>;
}

function makeProps(): InsightsTabProps {
  return {
    project: {
      name: 'papercusp',
      description: 'desc',
      ownerDisplayName: 'alice',
      claimStatus: 'claimed',
      claimantLogin: 'alice',
      githubUrl: 'https://github.com/x/y',
    },
    activity: {
      events: [{ id: 'e1', kind: 'feature_shipped', text: 'shipped F-1', actorLogin: 'alice', whenLabel: '5m ago' }],
    },
    people: { people: [{ github_user_id: 1, login: 'alice', binding_status: 'verified' }] },
    yourPlace: {
      queue: { queued: 0, working: 0, shipped_this_week: 0 },
      role: { pr_reviewer_enabled: false, is_provisional_owner: true, is_claimant: true },
      trust: { trusted_authors_count: 0, trusted_by_count: 0 },
    },
    howItWorks: {
      harnessName: 'papercusp',
      config: {
        has_orchestrator: true,
        pr_reviewer_role_enabled: false,
        auto_review: false,
        auto_merge: false,
        merge_method: 'squash',
        branch_policy: 'feature-branch',
      },
    },
    spend: { harnessTotalUsdThisWeek: 100, estimatedUsdThisWeek: 30, tokensThisWeek: 2_000_000, runsThisWeek: 12 },
  };
}

describe('InsightsTab — sub-tabs', () => {
  it('defaults to Overview: renders all six cards + the sub-nav', () => {
    render(<InsightsTab slug="papercusp" {...makeProps()} />, { wrapper: Wrap });
    expect(screen.getByTestId('insights-tab')).toBeTruthy();
    expect(screen.getByTestId('insights-overview')).toBeTruthy();
    expect(screen.getByTestId('insights-project-card')).toBeTruthy();
    expect(screen.getByTestId('insights-activity-feed-card')).toBeTruthy();
    expect(screen.getByTestId('insights-people-card')).toBeTruthy();
    expect(screen.getByTestId('insights-your-place-card')).toBeTruthy();
    expect(screen.getByTestId('insights-how-it-works-card')).toBeTruthy();
    expect(screen.getByTestId('insights-spend-card')).toBeTruthy();
    // The Tokens view is not mounted in the default Overview.
    expect(screen.queryByTestId('tokens-view-stub')).toBeNull();
  });

  it('renders the Tokens sub-view from ?insightView=tokens, threading the slug', () => {
    render(<InsightsTab slug="papercusp" {...makeProps()} />, {
      wrapper: ({ children }) => <Wrap search={{ insightView: 'tokens' }}>{children}</Wrap>,
    });
    const stub = screen.getByTestId('tokens-view-stub');
    expect(stub.textContent).toBe('tokens:papercusp');
    // Overview cards are not mounted when Tokens is active.
    expect(screen.queryByTestId('insights-overview')).toBeNull();
  });

  it('switches Overview → Tokens on sub-tab click', () => {
    render(<InsightsTab slug="papercusp" {...makeProps()} />, { wrapper: Wrap });
    expect(screen.getByTestId('insights-overview')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Tokens/i }));
    expect(screen.getByTestId('tokens-view-stub')).toBeTruthy();
    expect(screen.queryByTestId('insights-overview')).toBeNull();
  });
});
