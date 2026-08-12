// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { FLAGS } from '@papercusp/flags';
import type { ReactElement } from 'react';

// The page renders RecentAutoDecisions → DecisionLog, which reads `?decision=<id>`
// via nuqs; the tree needs a nuqs adapter.
const render = (ui: ReactElement) => rtlRender(<NuqsTestingAdapter searchParams="">{ui}</NuqsTestingAdapter>);

/* ── Mocks ─────────────────────────────────────────────────────────── */

const mutateMock = vi.fn(async () => ({ ok: true }));
let syncResult: { data: unknown[]; loading: boolean; error: Error | null };

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  // queryName-aware: the policy table gets ROWS; the recent-auto-decisions feed
  // (decision.ledger, B-13/P-113) gets its own empty result so it renders its
  // empty state rather than mis-rendering policy rows as decision rows.
  useSyncQuery: (opts?: { queryName?: string }) =>
    opts?.queryName === 'decision.ledger'
      ? { data: [], loading: false, error: null, fetching: false, invalidate: vi.fn() }
      : { ...syncResult, fetching: false, invalidate: vi.fn() },
  useSyncMutate: () => mutateMock,
}));

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

// The armed banner reads the autonomy arming flag; mock the hook so the page
// renders deterministically without the flag bootstrap / SSE stream.
//
// KEY-AWARE ON PURPOSE (retire-mug-kettle-su-only-2026-08-09 P-011 / D-021).
// This was a blanket `useFlag: () => flagMock()`, which answers EVERY flag with
// the armed value — so the "not armed" case ALSO read MUG_KETTLE_SYSTEM as false,
// retired the tier, and made the page render its retirement notice. Every
// assertion in this file would then have been measuring the refusal instead of
// its subject: a pass-shaped failure that looks like coverage. This suite's
// subject IS mug work, so the tier flag answers TRUE here by default; the OFF
// case gets its own block below. `FLAGS` is dereferenced at render time, not in
// the hoisted factory, so the key cannot drift from the registry.
const flagMock = vi.fn(() => true);
const mugKettleMock = vi.fn(() => true);
vi.mock('@/lib/flag-hooks', () => ({
  useFlag: (k: string) => (k === FLAGS.MUG_KETTLE_SYSTEM ? mugKettleMock() : flagMock()),
}));

// Self-contained nuqs stand-in (no NuqsAdapter needed): useState-backed.
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', async () => {
  const React = await import('react');
  const builder = (def: unknown) => ({ __default: def, withDefault: (d: unknown) => ({ __default: d }) });
  return {
    ...nuqsParsers,
    parseAsString: builder(null),
    parseAsInteger: builder(null),
    parseAsBoolean: builder(null),
    parseAsStringEnum: () => ({ withDefault: (d: unknown) => ({ __default: d }) }),
    useQueryState: (_key: string, parser?: { __default?: unknown }) => {
      const [v, setV] = React.useState<unknown>(parser?.__default ?? null);
      return [v, (next: unknown) => { setV(next); return Promise.resolve(true); }];
    },
  };
});

// Lexicon resolver echoes its key (t('brain') → 'brain') — isolates the
// Queen→brain routed intro copy from the THE_HIVE flag hook (restore-pot-lexicon P-007).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import AutonomySettingsPage from './page';

function row(over: Record<string, unknown>) {
  return {
    category: 'inbox-triage',
    ceiling: 'never-auto',
    locked: false,
    graduatedLevel: 'never-auto',
    effectiveCeiling: 'never-auto',
    ownerOverride: null,
    label: 'Inbox triage',
    protected: false,
    suggestedPosture: 'early-autonomy',
    covers: 'tier / downgrade / dismiss inbox items',
    ...over,
  };
}

const ROWS = [
  row({}),
  row({
    category: 'implementation',
    label: 'Implementation',
    ceiling: 'low',
    graduatedLevel: 'never-auto',
    effectiveCeiling: 'never-auto',
    suggestedPosture: 'risk-graded',
    covers: 'approve / dispatch auto-implement code changes',
  }),
  row({
    category: 'release-deploy',
    label: 'Release & deploy',
    locked: true,
    protected: true,
    suggestedPosture: 'protected',
    covers: 'approve deploys / releases',
  }),
];

beforeEach(() => {
  mutateMock.mockClear();
  flagMock.mockReturnValue(true);
  // The tier this page steers is ON for the whole existing suite — its subject IS
  // mug work, so a retired tier would make every case below assert the refusal.
  mugKettleMock.mockReturnValue(true);
  syncResult = { data: ROWS, loading: false, error: null };
});
afterEach(cleanup);

describe('AutonomySettingsPage', () => {
  it('renders a row per category with the Protected badge on protected ones', () => {
    render(<AutonomySettingsPage />);
    expect(screen.getByText('Inbox triage')).toBeTruthy();
    expect(screen.getByText('Implementation')).toBeTruthy();
    expect(screen.getByText('Release & deploy')).toBeTruthy();
    expect(screen.getByText('Protected')).toBeTruthy();
  });

  it('reflects the autonomy arming flag in the status banner', () => {
    flagMock.mockReturnValue(true);
    const armed = render(<AutonomySettingsPage />);
    expect(screen.getByText('Autonomy is armed.')).toBeTruthy();
    armed.unmount();
    flagMock.mockReturnValue(false);
    render(<AutonomySettingsPage />);
    expect(screen.getByText('Autonomy is not armed.')).toBeTruthy();
  });

  it('explains why effective is None even when a ceiling is set (the D-005 case)', () => {
    render(<AutonomySettingsPage />);
    // Expand the Implementation row (ceiling=low, graduated=never-auto).
    fireEvent.click(screen.getByRole('button', { name: /Implementation/ }));
    expect(
      screen.getByText(/nothing auto-runs until this category earns a graduated level/i),
    ).toBeTruthy();
  });

  it('writes a ceiling change through the mutate hook with a reason', async () => {
    render(<AutonomySettingsPage />);
    const slider = screen.getByRole('radiogroup', { name: /Inbox triage risk ceiling/i });
    fireEvent.click(within(slider).getByRole('radio', { name: 'Low' }));
    expect(mutateMock).toHaveBeenCalledTimes(1);
    const arg = mutateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({ category: 'inbox-triage', ceiling: 'low' });
    expect(typeof arg.reason).toBe('string');
    expect((arg.reason as string).length).toBeGreaterThanOrEqual(8);
  });

  it('moves the ceiling optimistically on click (before any server refetch)', () => {
    render(<AutonomySettingsPage />);
    const slider = screen.getByRole('radiogroup', { name: /Inbox triage risk ceiling/i });
    expect(within(slider).getByRole('radio', { name: 'Never' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(slider).getByRole('radio', { name: 'Low' }));
    // syncResult is unchanged (no server push), so a checked 'Low' here is the local
    // optimistic overlay — the fix for "the dot doesn't move until the SSE round-trip".
    expect(within(slider).getByRole('radio', { name: 'Low' }).getAttribute('aria-checked')).toBe('true');
  });

  it('rolls the ceiling back to server truth when the write fails', async () => {
    mutateMock.mockRejectedValueOnce(new Error('write boom'));
    render(<AutonomySettingsPage />);
    const slider = screen.getByRole('radiogroup', { name: /Inbox triage risk ceiling/i });
    fireEvent.click(within(slider).getByRole('radio', { name: 'Low' }));
    // Optimistic move shows immediately…
    expect(within(slider).getByRole('radio', { name: 'Low' }).getAttribute('aria-checked')).toBe('true');
    // …then the rejected write rolls it back to never-auto + toasts the error.
    await waitFor(() =>
      expect(within(slider).getByRole('radio', { name: 'Never' }).getAttribute('aria-checked')).toBe('true'),
    );
    const { toast } = await import('sonner');
    expect(toast.error).toHaveBeenCalled();
  });

  it('locks a configurable category directly via the toggle', () => {
    render(<AutonomySettingsPage />);
    fireEvent.click(screen.getByLabelText('Lock Inbox triage (never auto)'));
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'inbox-triage', locked: true }),
    );
  });

  it('does NOT immediately unlock a protected category (guards behind confirm)', () => {
    render(<AutonomySettingsPage />);
    fireEvent.click(screen.getByLabelText('Lock Release & deploy (never auto)'));
    // The toggle is checked (locked) → unchecking routes through a confirm toast,
    // so no mutate fires synchronously.
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('filters to protected categories only', () => {
    render(<AutonomySettingsPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'protected' }));
    expect(screen.queryByText('Inbox triage')).toBeNull();
    expect(screen.getByText('Release & deploy')).toBeTruthy();
  });

  it('renders the live recent-auto-decisions feed (P-031)', () => {
    render(<AutonomySettingsPage />);
    // P-031 feed (RecentAutoDecisions via decision.ledger) — empty mock → empty state.
    expect(screen.getByRole('heading', { name: /Recent auto-decisions/i })).toBeTruthy();
    expect(screen.getByText(/No decisions logged yet/i)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Graduation' })).toBeNull();
  });
});

/* ── Mug/Kettle retired (retire-mug-kettle-su-only-2026-08-09 P-011 / D-021) ──
 *
 * Every hide-assertion here is PAIRED with a show control on the same query. A
 * bare `queryBy… === null` cannot tell "the gate hid it" from "it never rendered
 * anyway" (a renamed aria-label, a broken fixture, a page that threw) — those are
 * the same null, and the second one is a test that passes while measuring
 * nothing. Asserting the ON case FIRST, with the throwing `getBy…`, is what makes
 * the null below evidence rather than an assumption.
 */
describe('AutonomySettingsPage — Mug/Kettle retired', () => {
  it('hides the ceiling table + armed banner and explains why, but shows them when the tier is on', () => {
    // SHOW CONTROL — `getBy…` throws if these are absent, so reaching the
    // unmount() proves the queries below are capable of finding the surface.
    mugKettleMock.mockReturnValue(true);
    const on = render(<AutonomySettingsPage />);
    expect(screen.getByRole('region', { name: 'Autonomy categories' })).toBeTruthy();
    expect(screen.getByText('Autonomy is armed.')).toBeTruthy();
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
    on.unmount();

    // HIDE — same queries, tier retired.
    mugKettleMock.mockReturnValue(false);
    render(<AutonomySettingsPage />);
    expect(screen.queryByRole('region', { name: 'Autonomy categories' })).toBeNull();
    expect(screen.queryByText('Autonomy is armed.')).toBeNull();
    // No controls at all — the harm P-011 names is a DEAD CONTROL that reads as
    // live, so "no table" is not enough; nothing may be clickable.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(/is retired, so there is no autonomy policy to steer/)).toBeTruthy();
  });

  it('stays retired regardless of the arming flag — the two flags are independent', () => {
    // The bug this pins: a key-blind `useFlag` mock made ARMED and
    // MUG_KETTLE_SYSTEM the same value, so "not armed" and "retired" were
    // indistinguishable. They are orthogonal; assert both combinations.
    mugKettleMock.mockReturnValue(false);
    flagMock.mockReturnValue(true); // armed…
    const armedRetired = render(<AutonomySettingsPage />);
    expect(screen.getByText(/is retired, so there is no autonomy policy to steer/)).toBeTruthy();
    expect(screen.queryByText('Autonomy is armed.')).toBeNull();
    armedRetired.unmount();

    flagMock.mockReturnValue(false); // …and not armed
    render(<AutonomySettingsPage />);
    expect(screen.getByText(/is retired, so there is no autonomy policy to steer/)).toBeTruthy();
    expect(screen.queryByText('Autonomy is not armed.')).toBeNull();
  });
});
