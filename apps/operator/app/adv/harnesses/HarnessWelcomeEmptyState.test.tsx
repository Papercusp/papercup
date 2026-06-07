// @vitest-environment jsdom
/**
 * HarnessWelcomeEmptyState — the post-SPEC.md onboarding welcome
 * (spec-md-ui-deprecation-cleanup-2026-05-30 P-005 / D-003).
 *
 * Covers:
 *  - the card shows ONLY when both sources have loaded and confirmed
 *    no-work (0 started plans AND 0 eligible features) — loading,
 *    fetch-error, eligible-feature and started-plan states all render
 *    nothing (a working harness never flashes the welcome);
 *  - deprecated-only features still count as no-work;
 *  - the D-003 copy renders verbatim;
 *  - CTAs route via the `?tab=` nuqs param (brainstorm / plans);
 *  - dismissal flips `?welcome=` to false and unmounts the card.
 *
 * nuqs is mocked to plain useState (AdvContributorsPanel pattern) with a
 * per-key setter-call log; useHarnessFeatures + fetchPlanList are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { nuqsSetCalls, dataMocks } = vi.hoisted(() => ({
  nuqsSetCalls: {} as Record<string, unknown[]>,
  dataMocks: {
    features: null as unknown,
    fetchPlanList: undefined as unknown,
  },
}));

// nuqs: useQueryState → a plain useState seeded with the parser default,
// logging setter calls per key so CTA routing is assertable.
vi.mock('nuqs', () => ({
  useQueryState: (key: string, opts?: { defaultValue?: unknown }) => {
    const [v, setV] = React.useState(opts?.defaultValue ?? null);
    return [
      v,
      async (x: unknown) => {
        (nuqsSetCalls[key] ??= []).push(x);
        setV(x);
      },
    ];
  },
  parseAsBoolean: { withDefault: (d: unknown) => ({ defaultValue: d }) },
  parseAsString: {},
}));

vi.mock('./useHarnessData', () => ({
  useHarnessFeatures: () => ({
    features: dataMocks.features,
    loading: dataMocks.features === null,
    error: null,
    patchFeature: vi.fn(),
  }),
}));

vi.mock('@/app/admin/plans/plans-api', () => ({
  fetchPlanList: (...args: unknown[]) =>
    (dataMocks.fetchPlanList as (...a: unknown[]) => Promise<unknown>)(...args),
}));

import HarnessWelcomeEmptyState from './HarnessWelcomeEmptyState';

const SLUG = 'fresh-harness';
const COPY_TITLE = 'Welcome to your harness.';
const COPY_BODY =
  'Come up with ideas in the brainstorm tab, plan them in the plan tab. Start them, and ' +
  'then watch agents work on them in the harness tab.';

function plansResponse(startStatuses: Array<string | null>) {
  return {
    plans: startStatuses.map((s, i) => ({ slug: `p-${i}`, startStatus: s })),
  };
}

beforeEach(() => {
  for (const k of Object.keys(nuqsSetCalls)) delete nuqsSetCalls[k];
  dataMocks.features = [];
  dataMocks.fetchPlanList = vi.fn(async () => plansResponse([]));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('HarnessWelcomeEmptyState', () => {
  it('renders the D-003 copy verbatim when the harness has no work', async () => {
    render(<HarnessWelcomeEmptyState slug={SLUG} />);
    await waitFor(() => expect(screen.getByTestId('harness-welcome')).toBeTruthy());
    expect(screen.getByText(COPY_TITLE)).toBeTruthy();
    expect(screen.getByText(COPY_BODY)).toBeTruthy();
    // fetched scoped to this harness
    expect(dataMocks.fetchPlanList).toHaveBeenCalledWith({ harness_slugs: [SLUG] });
  });

  it('renders nothing while features are still loading', async () => {
    dataMocks.features = null;
    render(<HarnessWelcomeEmptyState slug={SLUG} />);
    await waitFor(() =>
      expect((dataMocks.fetchPlanList as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1),
    );
    expect(screen.queryByTestId('harness-welcome')).toBeNull();
  });

  it('renders nothing while the plan list is still loading', () => {
    dataMocks.fetchPlanList = vi.fn(() => new Promise(() => {})); // never resolves
    render(<HarnessWelcomeEmptyState slug={SLUG} />);
    expect(screen.queryByTestId('harness-welcome')).toBeNull();
  });

  it('renders nothing when the plan list fetch fails (unknown ≠ empty)', async () => {
    const rejecting = vi.fn(async () => {
      throw new Error('plans:list → 500');
    });
    dataMocks.fetchPlanList = rejecting;
    render(<HarnessWelcomeEmptyState slug={SLUG} />);
    await waitFor(() => expect(rejecting).toHaveBeenCalled());
    expect(screen.queryByTestId('harness-welcome')).toBeNull();
  });

  it('renders nothing when an eligible feature exists', async () => {
    dataMocks.features = [{ id: 'F-001', title: 'x', status: 'todo' }];
    render(<HarnessWelcomeEmptyState slug={SLUG} />);
    await waitFor(() =>
      expect((dataMocks.fetchPlanList as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1),
    );
    expect(screen.queryByTestId('harness-welcome')).toBeNull();
  });

  it('still shows when the only features are deprecated', async () => {
    dataMocks.features = [{ id: 'F-001', title: 'x', status: 'deprecated' }];
    render(<HarnessWelcomeEmptyState slug={SLUG} />);
    await waitFor(() => expect(screen.getByTestId('harness-welcome')).toBeTruthy());
  });

  it('renders nothing when a plan has been started (incl. paused/done)', async () => {
    for (const startStatus of ['started', 'paused', 'done']) {
      const resolving = vi.fn(async () => plansResponse([null, startStatus]));
      dataMocks.fetchPlanList = resolving;
      const { unmount } = render(<HarnessWelcomeEmptyState slug={SLUG} />);
      await waitFor(() => expect(resolving).toHaveBeenCalled());
      expect(screen.queryByTestId('harness-welcome')).toBeNull();
      unmount();
    }
  });

  it('routes the CTAs through the ?tab= param', async () => {
    render(<HarnessWelcomeEmptyState slug={SLUG} />);
    await waitFor(() => expect(screen.getByTestId('harness-welcome')).toBeTruthy());
    fireEvent.click(screen.getByText('Open brainstorm'));
    fireEvent.click(screen.getByText('Open plans'));
    expect(nuqsSetCalls['tab']).toEqual(['brainstorm', 'plans']);
  });

  it('dismisses via ?welcome=false and unmounts', async () => {
    render(<HarnessWelcomeEmptyState slug={SLUG} />);
    await waitFor(() => expect(screen.getByTestId('harness-welcome')).toBeTruthy());
    fireEvent.click(screen.getByText('Show the workspace anyway'));
    await waitFor(() => expect(screen.queryByTestId('harness-welcome')).toBeNull());
    expect(nuqsSetCalls['welcome']).toEqual([false]);
  });

  it('backdrop click dismisses; card click does not', async () => {
    render(<HarnessWelcomeEmptyState slug={SLUG} />);
    await waitFor(() => expect(screen.getByTestId('harness-welcome')).toBeTruthy());
    fireEvent.click(screen.getByText(COPY_TITLE)); // inside the card — no dismiss
    expect(screen.getByTestId('harness-welcome')).toBeTruthy();
    fireEvent.click(screen.getByTestId('harness-welcome')); // backdrop
    await waitFor(() => expect(screen.queryByTestId('harness-welcome')).toBeNull());
  });
});
