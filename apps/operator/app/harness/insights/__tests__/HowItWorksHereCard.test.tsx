/**
 * @vitest-environment jsdom
 *
 * HowItWorksHereCard — P-073e tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  HowItWorksHereCard,
  type HowItWorksHereConfig,
} from '../HowItWorksHereCard';

afterEach(() => {
  cleanup();
});

function makeConfig(
  overrides: Partial<HowItWorksHereConfig> = {},
): HowItWorksHereConfig {
  return {
    has_orchestrator: true,
    pr_reviewer_role_enabled: false,
    auto_review: false,
    auto_merge: false,
    merge_method: 'squash',
    branch_policy: 'feature-branch',
    ...overrides,
  };
}

describe('HowItWorksHereCard — P-073e', () => {
  it('renders title + intro + 3 steps', () => {
    render(
      <HowItWorksHereCard
        harnessName="papercup"
        config={makeConfig()}
      />,
    );
    expect(screen.getByTestId('insights-how-it-works-card')).toBeTruthy();
    expect(screen.getByTestId('how-it-works-step-1')).toBeTruthy();
    expect(screen.getByTestId('how-it-works-step-2')).toBeTruthy();
    expect(screen.getByTestId('how-it-works-step-3')).toBeTruthy();
    expect(screen.getByTestId('how-it-works-intro').textContent).toContain(
      'papercup',
    );
  });

  it('with orchestrator: step 1 mentions orchestrator', () => {
    render(
      <HowItWorksHereCard
        harnessName="papercup"
        config={makeConfig({ has_orchestrator: true })}
      />,
    );
    expect(screen.getByTestId('how-it-works-step-1').textContent).toContain(
      'orchestrator',
    );
  });

  it('without orchestrator: step 1 says manual', () => {
    render(
      <HowItWorksHereCard
        harnessName="papercup"
        config={makeConfig({ has_orchestrator: false })}
      />,
    );
    expect(screen.getByTestId('how-it-works-step-1').textContent).toContain(
      'manually',
    );
  });

  it('PR-reviewer off: step 2 says manual approvals/merges', () => {
    render(
      <HowItWorksHereCard
        harnessName="papercup"
        config={makeConfig({ pr_reviewer_role_enabled: false })}
      />,
    );
    expect(screen.getByTestId('how-it-works-step-2').textContent).toContain(
      'by hand',
    );
    expect(screen.queryByTestId('how-it-works-step-2-sub')).toBeNull();
  });

  it('PR-reviewer on, auto_review on: sub mentions auto-approve', () => {
    render(
      <HowItWorksHereCard
        harnessName="papercup"
        config={makeConfig({
          pr_reviewer_role_enabled: true,
          auto_review: true,
        })}
      />,
    );
    expect(screen.getByTestId('how-it-works-step-2-sub').textContent).toContain(
      'Auto-approve',
    );
  });

  it('PR-reviewer on, auto_merge on: sub mentions auto-merge + method', () => {
    render(
      <HowItWorksHereCard
        harnessName="papercup"
        config={makeConfig({
          pr_reviewer_role_enabled: true,
          auto_merge: true,
          merge_method: 'rebase',
        })}
      />,
    );
    const sub = screen.getByTestId('how-it-works-step-2-sub').textContent ?? '';
    expect(sub).toContain('Auto-merge');
    expect(sub).toContain('rebase');
  });

  it('PR-reviewer on, all auto off: sub says manual only', () => {
    render(
      <HowItWorksHereCard
        harnessName="papercup"
        config={makeConfig({ pr_reviewer_role_enabled: true })}
      />,
    );
    expect(screen.getByTestId('how-it-works-step-2-sub').textContent).toContain(
      'manual approvals only',
    );
  });

  it('branch_policy feature-branch: step 3 mentions squashed onto main', () => {
    render(
      <HowItWorksHereCard
        harnessName="papercup"
        config={makeConfig({ branch_policy: 'feature-branch' })}
      />,
    );
    expect(screen.getByTestId('how-it-works-step-3').textContent).toContain(
      'squashed onto main',
    );
  });

  it('branch_policy main-fast-forward: step 3 mentions fast-forwards', () => {
    render(
      <HowItWorksHereCard
        harnessName="papercup"
        config={makeConfig({ branch_policy: 'main-fast-forward' })}
      />,
    );
    expect(screen.getByTestId('how-it-works-step-3').textContent).toContain(
      'fast-forwards',
    );
  });

  it('branch_policy release-branch: step 3 mentions release branch', () => {
    render(
      <HowItWorksHereCard
        harnessName="papercup"
        config={makeConfig({ branch_policy: 'release-branch' })}
      />,
    );
    expect(screen.getByTestId('how-it-works-step-3').textContent).toContain(
      'release branch',
    );
  });

  it('customWelcome overrides the templated intro', () => {
    render(
      <HowItWorksHereCard
        harnessName="papercup"
        config={makeConfig()}
        customWelcome="Welcome to our small chaotic dev cult."
      />,
    );
    expect(screen.getByTestId('how-it-works-intro').textContent).toContain(
      'small chaotic dev cult',
    );
    expect(screen.getByTestId('how-it-works-intro').textContent).not.toContain(
      "Here's how work flows",
    );
  });
});
