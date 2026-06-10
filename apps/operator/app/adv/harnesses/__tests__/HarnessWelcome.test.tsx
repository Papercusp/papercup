/**
 * @vitest-environment jsdom
 *
 * HarnessWelcome — the harness-tab no-work welcome empty-state
 * (spec-md-ui-deprecation-cleanup-2026-05-30 P-005 / D-002).
 *
 * Verifies: the D-002 copy renders verbatim when the harness has no
 * work; the gate stays hidden while data loads, on errors, or when any
 * work exists; the CTAs write `?tab=`; dismissal writes `?welcome=0`.
 *
 * useHarnessData is mocked — the gate logic under test is
 * HarnessWelcome's, not the data hooks'.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import HarnessWelcome, { HarnessWelcomeCard } from '../HarnessWelcome';
import type { HarnessFeature } from '../useHarnessData';

const mockFeatures = vi.fn<() => { features: HarnessFeature[] | null; error: string | null }>();
const mockIssues = vi.fn<() => { issues: unknown[] | null; error: string | null }>();

vi.mock('../useHarnessData', () => ({
  useHarnessFeatures: (slug: string) => ({
    loading: false,
    patchFeature: vi.fn(),
    ...mockFeatures(),
    slug,
  }),
  useHarnessIssues: (slug: string) => ({
    loading: false,
    pendingCount: 0,
    patchIssue: vi.fn(),
    ...mockIssues(),
    slug,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const noWork = () => {
  mockFeatures.mockReturnValue({ features: [], error: null });
  mockIssues.mockReturnValue({ issues: [], error: null });
};

function renderWelcome(searchParams = '?slug=demo', onUrlUpdate?: (e: unknown) => void) {
  return render(<HarnessWelcome slug="demo" />, {
    wrapper: withNuqsTestingAdapter({ searchParams, onUrlUpdate }),
  });
}

describe('HarnessWelcome gate', () => {
  it('renders the D-002 copy verbatim when the harness has no work', () => {
    noWork();
    renderWelcome();
    screen.getByTestId('harness-welcome');
    screen.getByText('Welcome to your harness.');
    expect(
      screen.getByText(
        /Come up with ideas in the brainstorm tab, plan them in the plan tab\.\s*Start them, and then watch agents work on them in the harness tab\./,
      ),
    ).toBeTruthy();
  });

  it('stays hidden while either list is still loading', () => {
    mockFeatures.mockReturnValue({ features: null, error: null });
    mockIssues.mockReturnValue({ issues: [], error: null });
    renderWelcome();
    expect(screen.queryByTestId('harness-welcome')).toBeNull();
  });

  it('stays hidden when features exist', () => {
    mockFeatures.mockReturnValue({
      features: [{ id: 'F-001', title: 'x', status: 'todo' }],
      error: null,
    });
    mockIssues.mockReturnValue({ issues: [], error: null });
    renderWelcome();
    expect(screen.queryByTestId('harness-welcome')).toBeNull();
  });

  it('stays hidden when issues exist (bugs are work too)', () => {
    mockFeatures.mockReturnValue({ features: [], error: null });
    mockIssues.mockReturnValue({ issues: [{ id: 'I-1' }], error: null });
    renderWelcome();
    expect(screen.queryByTestId('harness-welcome')).toBeNull();
  });

  it('stays hidden on a data error (never masks an unknown dashboard)', () => {
    mockFeatures.mockReturnValue({ features: [], error: 'status 500' });
    mockIssues.mockReturnValue({ issues: [], error: null });
    renderWelcome();
    expect(screen.queryByTestId('harness-welcome')).toBeNull();
  });

  it('respects ?welcome=0 dismissal', () => {
    noWork();
    renderWelcome('?slug=demo&welcome=false');
    expect(screen.queryByTestId('harness-welcome')).toBeNull();
  });

  it('CTAs write ?tab=; dismiss writes ?welcome=false', async () => {
    noWork();
    const updates: Array<{ searchParams: URLSearchParams }> = [];
    renderWelcome('?slug=demo', (e) => updates.push(e as { searchParams: URLSearchParams }));
    const user = userEvent.setup();

    await user.click(screen.getByText('Open Brainstorm'));
    expect(updates.at(-1)?.searchParams.get('tab')).toBe('brainstorm');

    await user.click(screen.getByText('Open Plans'));
    expect(updates.at(-1)?.searchParams.get('tab')).toBe('plans');

    await user.click(screen.getByText('Explore the empty dashboard anyway'));
    expect(updates.at(-1)?.searchParams.get('welcome')).toBe('false');
  });
});

describe('HarnessWelcomeCard', () => {
  it('fires the three callbacks', async () => {
    const onOpenBrainstorm = vi.fn();
    const onOpenPlans = vi.fn();
    const onDismiss = vi.fn();
    render(
      <HarnessWelcomeCard
        onOpenBrainstorm={onOpenBrainstorm}
        onOpenPlans={onOpenPlans}
        onDismiss={onDismiss}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText('Open Brainstorm'));
    await user.click(screen.getByText('Open Plans'));
    await user.click(screen.getByText('Explore the empty dashboard anyway'));
    expect(onOpenBrainstorm).toHaveBeenCalledTimes(1);
    expect(onOpenPlans).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
