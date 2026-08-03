// @vitest-environment jsdom
/**
 * Tests for use-interaction-settle.ts — the `settled && active` gate that
 * fixes the WARM-PANE silent-zero (EI-19383745196363732).
 *
 * WHY THIS FILE EXISTS. AnalyzePanel.perf-settle.test.tsx (and its
 * ObservationsPanel sibling) only ever render with `active` at its default
 * (true) — every test there exercises the ORIGINAL "settled flips false→true
 * on mount/remount" path, which was never the bug. The regression this hook
 * was written to fix is specific to a panel that stays MOUNTED across a view
 * switch (LearningTab's `warmViews`): `settled` is already `true` before the
 * revisit even starts, so an effect keyed on `settled` alone never re-runs
 * and the interaction the parent just began is never ended. Nothing in the
 * existing panel test suites pins that shape, so a future refactor of this
 * hook (e.g. dropping `active` from the dependency array, or reverting to a
 * bare `if (settled)`) would regress silently — this file is the recurrence
 * guard the bug report asked for.
 *
 * Uses the REAL perf-marks begin/end (not a spy) so a wiring bug between the
 * hook and perf-marks.ts would fail here too, not just at the mocked
 * AnalyzePanel level.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { beginInteraction, endInteraction, PERF_INTERACTIONS } from './perf-marks';
import { useInteractionSettle } from './use-interaction-settle';

const NAME = PERF_INTERACTIONS.learningViewSwitch;

function resetTimeline(): void {
  performance.clearMarks?.();
  performance.clearMeasures?.();
}

beforeEach(resetTimeline);
afterEach(resetTimeline);

function measureCount(): number {
  return performance.getEntriesByName(NAME, 'measure').length;
}

describe('useInteractionSettle', () => {
  it('ends the interaction once settled+active are both true on mount', () => {
    beginInteraction(NAME);
    renderHook(() => useInteractionSettle(NAME, true, true));
    expect(measureCount()).toBe(1);
  });

  it('does NOT end while settled is false, even though active is true', () => {
    beginInteraction(NAME);
    renderHook(() => useInteractionSettle(NAME, false, true));
    expect(measureCount()).toBe(0);
  });

  it('does NOT end while active is false, even though settled is true (a warm hidden pane)', () => {
    beginInteraction(NAME);
    renderHook(() => useInteractionSettle(NAME, true, false));
    expect(measureCount()).toBe(0);
  });

  it('active is true by default for a caller that omits it', () => {
    beginInteraction(NAME);
    renderHook(() => useInteractionSettle(NAME, true));
    expect(measureCount()).toBe(1);
  });

  // ── The actual regression (EI-19383745196363732) ──────────────────────────
  it('WARM REVISIT: settled stays true throughout; ending fires only when active flips false → true', () => {
    // Simulates LearningTab.warmViews: the pane is already settled (its data
    // was cached from an earlier visit) BEFORE the parent begins the new
    // interaction for this revisit.
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useInteractionSettle(NAME, true, active),
      { initialProps: { active: false } },
    );
    // The pane is warm but hidden — nothing to measure yet, and no begin has
    // even happened for THIS revisit.
    expect(measureCount()).toBe(0);

    // The user switches back to this view: the parent begins the interaction
    // in a useLayoutEffect (runs before this passive effect), THEN the pane
    // becomes visible.
    beginInteraction(NAME);
    rerender({ active: true });

    // With the old `useEffect(() => { if (settled) end() }, [settled])` this
    // would never fire — `settled` never changed across the rerender. Gating
    // on `active` too means the active:false→true transition is itself a dep
    // change that re-runs the effect.
    expect(measureCount()).toBe(1);
  });

  it('WARM REVISIT with a still-loading pane: active flips true before settled, no premature measure', () => {
    // The pane becomes visible before its own data has resolved (visit, leave
    // before it settles, come straight back).
    const { rerender } = renderHook(
      ({ settled }: { settled: boolean }) => useInteractionSettle(NAME, settled, true),
      { initialProps: { settled: false } },
    );
    beginInteraction(NAME);
    rerender({ settled: false });
    expect(measureCount()).toBe(0); // still loading — must not report ~0ms

    rerender({ settled: true });
    expect(measureCount()).toBe(1); // now it settles — the whole wait is captured
  });

  it('a rerender with unchanged settled/active does not re-fire (no double end)', () => {
    beginInteraction(NAME);
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useInteractionSettle(NAME, true, active),
      { initialProps: { active: true } },
    );
    expect(measureCount()).toBe(1);
    rerender({ active: true });
    expect(measureCount()).toBe(1); // endInteraction is measure-once + no-op with no start anyway
  });

  it('is a safe no-op with no matching begin (nothing to end)', () => {
    renderHook(() => useInteractionSettle(NAME, true, true));
    expect(measureCount()).toBe(0);
  });
});
