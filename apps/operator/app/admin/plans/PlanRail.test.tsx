// @vitest-environment jsdom
/**
 * PlanRail drag-handle regression test (P-045).
 *
 * Two layered bugs this guards:
 *  1. The drag handle was nested *inside* the row's full-bleed interactive
 *     `<button>`, which swallows the grab gesture — so the row could never be
 *     grabbed. The fix makes a dedicated `<span>` handle OUTSIDE the button.
 *  2. The reorder was wired with native HTML5 drag-and-drop (`draggable` +
 *     dragstart/dragover/drop), which the desktop's WebKitGTK webview never
 *     fires (tauri-apps/tauri#6695) — so drag could not initiate on the only
 *     ship/test surface. The fix drives the reorder with POINTER events; the
 *     handle is therefore NOT an HTML5 `draggable` source.
 *
 * jsdom can't exercise real pointer-drag (no layout / elementFromPoint), so
 * these assert the structural invariants that make drag possible: a handle
 * that is NOT a descendant of any button and is NOT a native HTML5 drag
 * source. Drag only shows for >1 started plan.
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
  it('renders a grab handle that is NOT inside a button and NOT a native HTML5 drag source', () => {
    const { container } = renderRail([plan('a-2026-01-01'), plan('b-2026-01-02')]);
    const handles = container.querySelectorAll<HTMLElement>('.pc-plan-row__drag-handle');
    // Two started plans → reorder is meaningful → both rows get a handle.
    expect(handles.length).toBe(2);
    for (const h of handles) {
      // Regression #2: the handle must NOT be a native HTML5 drag source —
      // WebKitGTK won't fire HTML5 drag events, so reorder is pointer-driven.
      expect(h.hasAttribute('draggable')).toBe(false);
      // Regression #1: the handle must NOT be swallowed by an interactive
      // button, or the gesture never initiates.
      expect(h.closest('button')).toBeNull();
      // And it must live inside the rail item (a sibling of the row button),
      // which carries the data-plan-slug the pointer hit-test reads.
      const item = h.closest('.pc-plan-rail__item');
      expect(item).not.toBeNull();
      expect(item?.getAttribute('data-plan-slug')).toBeTruthy();
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
