/**
 * @vitest-environment jsdom
 *
 * HarnessWelcome — the harness-tab no-work welcome empty-state
 * (spec-md-ui-deprecation-cleanup-2026-05-30 P-005 / D-002).
 *
 * Verifies: the D-002 copy renders verbatim when the harness has no
 * work; the gate stays hidden while data loads, on errors, or when any
 * work exists; the CTAs write `?tab=`; dismissal writes `?welcome=0`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import HarnessWelcome, { HarnessWelcomeCard } from '../HarnessWelcome';
import { lexiconFor } from '@papercusp/lexicon';

// These components render under the DEFAULT ('classic' → Pot) brand pack in tests
// (the-hive flag off). Resolve the brand term the SAME way the component does so a
// future brand-lexicon flip can never re-red these copy tests. The literal copy
// stays verbatim; only the flag-gated brand noun flexes.
// (restore-pot-lexicon-public-release-2026-07-04 fallout — green-gate fix su-e9204.)
const LEX = lexiconFor('classic');

const mockStats = vi.fn<() => { data: unknown; loading: boolean; error: unknown }>();

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => mockStats(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const noWork = () => {
  mockStats.mockReturnValue({ data: [], loading: false, error: null });
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
    screen.getByText(`Welcome to your ${LEX('pot')}.`);
    expect(
      screen.getByText(
        new RegExp(
          `Come up with ideas in the brainstorm tab, plan them in the plan tab\\.\\s*Start them, and then watch agents work on them in the ${LEX('pot')} tab\\.`,
        ),
      ),
    ).toBeTruthy();
  });

  it('stays hidden while the aggregate is still loading', () => {
    mockStats.mockReturnValue({ data: undefined, loading: true, error: null });
    renderWelcome();
    expect(screen.queryByTestId('harness-welcome')).toBeNull();
  });

  it('stays hidden when features exist', () => {
    mockStats.mockReturnValue({
      data: [{ kind: 'feature', state: 'open', n: 1 }],
      loading: false,
      error: null,
    });
    renderWelcome();
    expect(screen.queryByTestId('harness-welcome')).toBeNull();
  });

  it('stays hidden when issues exist (bugs are work too)', () => {
    mockStats.mockReturnValue({
      data: [{ kind: 'bug', state: 'open', n: '2' }],
      loading: false,
      error: null,
    });
    renderWelcome();
    expect(screen.queryByTestId('harness-welcome')).toBeNull();
  });

  it('stays hidden on a data error (never masks an unknown dashboard)', () => {
    mockStats.mockReturnValue({ data: undefined, loading: false, error: new Error('status 500') });
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
