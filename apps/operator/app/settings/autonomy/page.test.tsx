// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { FLAGS } from '@papercusp/flags';
import type { ReactElement } from 'react';

// WI-38240: the page no longer renders RecentAutoDecisions → DecisionLog (that wrapper
// was deleted with the rest of the unreachable autonomy UI). The nuqs adapter is kept
// because the render helper is shared by every case here and costs nothing.
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
// This mock used to be KEY-AWARE (P-011 / D-021) so the tier flag could answer
// TRUE while other flags answered the armed value — without that split, the "not
// armed" case also read the tier as retired and every assertion measured the
// refusal instead of its subject. P-068/D-098 DELETED the tier flag, so there is
// no second key to separate and the blanket form is now correct rather than a
// trap: the arming flag is the only flag this page reads.
const flagMock = vi.fn(() => true);
vi.mock('@/lib/flag-hooks', () => ({
  useFlag: () => flagMock(),
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
  syncResult = { data: ROWS, loading: false, error: null };
});
afterEach(cleanup);


/* ── Mug/Kettle retired, PERMANENTLY (P-011 / D-021, terminal step P-068 / D-098)
 *
 * This block used to pair every hide-assertion with a SHOW control on the same
 * query — rendering the tier ON first, so a `queryBy… === null` could be told
 * apart from "it never rendered anyway". P-068 deleted the tier flag, so the ON
 * case no longer exists and that pairing is no longer constructible.
 *
 * The vacuity risk it guarded against is REAL and does not go away with it, so it
 * is replaced rather than dropped: a CALIBRATION assertion proves the page
 * rendered its notice, and only then do the absence assertions mean anything. The
 * 11 cases that used to exercise the live ceiling table were deleted with their
 * subject (P-061's rule: behaviour tests follow the code they cover) — the page
 * can no longer reach that surface under any flag state.
 */
describe('AutonomySettingsPage — Mug/Kettle retired', () => {
  it('renders ONLY the retirement notice — no table, no banner, nothing clickable', () => {
    render(<AutonomySettingsPage />);

    // CALIBRATION FIRST: the page really rendered. Without this, every absence
    // below is equally satisfied by a component that threw on mount.
    expect(screen.getByText(/is retired, so there is no autonomy policy to steer/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Autonomy' })).toBeTruthy();

    expect(screen.queryByRole('region', { name: 'Autonomy categories' })).toBeNull();
    expect(screen.queryByText('Autonomy is armed.')).toBeNull();
    // No controls at all — the harm P-011 names is a DEAD CONTROL that reads as
    // live, so "no table" is not enough; nothing may be clickable.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('stays retired under EVERY arming-flag value — no flag can bring the page back', () => {
    // The original bug this pins: a key-blind `useFlag` mock made ARMED and the
    // tier flag the same value, so "not armed" and "retired" were
    // indistinguishable. The tier flag is gone, so this now asserts the stronger
    // property — the arming flag is the only one left, and neither value matters.
    for (const armed of [true, false]) {
      flagMock.mockReturnValue(armed);
      const r = render(<AutonomySettingsPage />);
      expect(screen.getByText(/is retired, so there is no autonomy policy to steer/)).toBeTruthy();
      expect(screen.queryByText('Autonomy is armed.')).toBeNull();
      expect(screen.queryByText('Autonomy is not armed.')).toBeNull();
      r.unmount();
    }
  });
});
