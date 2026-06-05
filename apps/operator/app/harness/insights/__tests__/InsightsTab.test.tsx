/**
 * @vitest-environment jsdom
 *
 * InsightsTab — P-073 assembly tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { InsightsTab, type InsightsTabProps } from '../InsightsTab';

afterEach(() => {
  cleanup();
});

function makeProps(): InsightsTabProps {
  return {
    project: {
      name: 'papercup',
      description: 'desc',
      ownerDisplayName: 'alice',
      claimStatus: 'claimed',
      claimantLogin: 'alice',
      githubUrl: 'https://github.com/x/y',
    },
    activity: {
      events: [
        {
          id: 'e1',
          kind: 'feature_shipped',
          text: 'shipped F-1',
          actorLogin: 'alice',
          whenLabel: '5m ago',
        },
      ],
    },
    people: {
      people: [
        {
          github_user_id: 1,
          login: 'alice',
          binding_status: 'verified',
        },
      ],
    },
    yourPlace: {
      queue: { queued: 0, working: 0, shipped_this_week: 0 },
      role: {
        pr_reviewer_enabled: false,
        is_provisional_owner: true,
        is_claimant: true,
      },
      trust: { trusted_authors_count: 0, trusted_by_count: 0 },
    },
    howItWorks: {
      harnessName: 'papercup',
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
      harnessTotalUsdThisWeek: 100,
      estimatedUsdThisWeek: 30,
      tokensThisWeek: 2_000_000,
      runsThisWeek: 12,
    },
  };
}

describe('InsightsTab — P-073 assembly', () => {
  it('renders all six cards', () => {
    render(<InsightsTab {...makeProps()} />);
    expect(screen.getByTestId('insights-tab')).toBeTruthy();
    expect(screen.getByTestId('insights-project-card')).toBeTruthy();
    expect(screen.getByTestId('insights-activity-feed-card')).toBeTruthy();
    expect(screen.getByTestId('insights-people-card')).toBeTruthy();
    expect(screen.getByTestId('insights-your-place-card')).toBeTruthy();
    expect(screen.getByTestId('insights-how-it-works-card')).toBeTruthy();
    expect(screen.getByTestId('insights-spend-card')).toBeTruthy();
  });
});
