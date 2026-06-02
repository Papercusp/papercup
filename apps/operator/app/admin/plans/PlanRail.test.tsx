// @vitest-environment jsdom
/**
 * PlanRail drag-handle regression test (P-045).
 *
 * The "started plans aren't draggable" bug: the draggable element was the
 * `<li>`, but it wrapped a full-bleed interactive `<button>` (with the drag
 * handle nested *inside* that button). A button child swallows HTML5 drag
 * initiation, so the row could never be grabbed. The fix makes a dedicated
 * `<span>` handle — OUTSIDE the button — the drag source.
 *
 * jsdom can't exercise real HTML5 drag, so these assert the structural
 * invariant that makes drag possible: a draggable handle that is NOT a
 * descendant of any button. Drag only shows for >1 started plan.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import PlanRail from './PlanRail';
import type { AsyncResult, PlanListRow } from './plans-api';

beforeEach(() => {
  // The row renders a Start/Pause <button> nested inside the row <button> —
  // a PRE-EXISTING invalid-nesting warning, orthogonal to the drag handle
  // under test (the start-btn uses stopPropagation, so it still works).
  // Swallow only that warning; any OTHER console.error still fails the test.
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const msg = String(args[0] ?? '');
    if (
      msg.includes('cannot be a descendant of') ||
      msg.includes('cannot contain a nested') ||
      msg.includes('validateDOMNesting')
    ) {
      return;
    }
    throw new Error(`Unexpected console.error: ${msg}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

function plan(slug: string, over: Partial<PlanListRow> = {}): PlanListRow {
  return {
    slug,
    title: slug,
    status: 'active',
    updated: null,
    owner: null,
    archived: false,
    isLegacy: false,
    itemCounts: null,
    nextAction: null,
    // Empty so the HarnessPill (a Radix Tooltip needing a provider) is
    // skipped — irrelevant to the drag-handle structure under test.
    harness: '',
    startStatus: 'started',
    priority: null,
    ...over,
  };
}

function listOf(plans: PlanListRow[]): AsyncResult<{ plans: PlanListRow[] }> {
  return { data: { plans }, loading: false, error: null, refresh: vi.fn() };
}

function renderRail(plans: PlanListRow[]) {
  return render(
    <PlanRail list={listOf(plans)} selectedSlugs={[]} query="" onSelect={vi.fn()} />,
    { wrapper: withNuqsTestingAdapter({ searchParams: '' }) },
  );
}

describe('PlanRail drag-to-reorder handle', () => {
  it('renders a draggable handle that is NOT inside a button (the bug)', () => {
    const { container } = renderRail([plan('a-2026-01-01'), plan('b-2026-01-02')]);
    const handles = container.querySelectorAll<HTMLElement>('.pc-plan-row__drag-handle');
    // Two started plans → reorder is meaningful → both rows get a handle.
    expect(handles.length).toBe(2);
    for (const h of handles) {
      // The fix: the handle itself is the HTML5 drag source.
      expect(h.getAttribute('draggable')).toBe('true');
      // The regression: the handle must NOT be swallowed by an interactive
      // button, or drag never initiates.
      expect(h.closest('button')).toBeNull();
      // And it must live inside the rail item (a sibling of the row button).
      expect(h.closest('.pc-plan-rail__item')).not.toBeNull();
    }
  });

  it('does not offer drag for a single started plan (nothing to reorder)', () => {
    const { container } = renderRail([plan('only-2026-01-01')]);
    expect(container.querySelectorAll('.pc-plan-row__drag-handle').length).toBe(0);
  });

  it('does not offer drag for non-started plans', () => {
    const { container } = renderRail([
      plan('x-2026-01-01', { startStatus: null }),
      plan('y-2026-01-02', { startStatus: null }),
    ]);
    expect(container.querySelectorAll('.pc-plan-row__drag-handle').length).toBe(0);
  });
});
