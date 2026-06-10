// @vitest-environment jsdom
/**
 * PlanRail drag-to-reorder regression test (P-045).
 *
 * Two layered bugs this guards:
 *  1. The drag handle was nested *inside* the row's full-bleed interactive
 *     `<button>`, which swallows the grab gesture — so the row could never be
 *     grabbed. The fix makes a dedicated `<span>` handle OUTSIDE the button.
 *  2. THE LOAD-BEARING ONE: the reorder uses native HTML5 drag-and-drop, and
 *     `dragstart` MUST call `dataTransfer.setData(...)`. WebKit/Gecko (and our
 *     WebKitGTK desktop webview) silently abort a drag that sets no data, so
 *     `dragover`/`drop` never fire and the reorder does nothing. The original
 *     handler set only React state and never touched `dataTransfer`, which got
 *     misread as "WebKitGTK doesn't support HTML5 DnD" (it does — dockview and
 *     PlanDetail's kanban both use native HTML5 DnD in the same shell). A later
 *     pointer-events rewrite worked around the phantom limitation; this test
 *     now pins the correct native-DnD contract so neither regression returns.
 *
 * jsdom has no real drag, but it does dispatch synthetic drag events through
 * React's handlers — enough to assert the contract: the handle is a native
 * HTML5 drag source, `dragstart` calls setData, and a drag→drop persists the
 * new order via setPlanPriority. Drag only shows for >1 started plan.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import PlanRail from './PlanRail';
import type { AsyncResult, PlanListRow } from './plans-api';

// setPlanPriority is the persistence call on drop — mock it so we can assert
// the committed order without a backend. Keep every other plans-api export real
// (PlanRail imports several at module load).
vi.mock('./plans-api', async (orig) => ({
  ...(await orig<typeof import('./plans-api')>()),
  setPlanPriority: vi.fn().mockResolvedValue({ ok: true }),
}));
import { setPlanPriority } from './plans-api';

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
  vi.mocked(setPlanPriority).mockClear();
  cleanup();
});

function plan(slug: string, over: Partial<PlanListRow> = {}): PlanListRow {
  return {
    slug,
    title: slug,
    status: 'active',
    updated: null,
    created: null,
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
    maxImportance: null,
    ...over,
  };
}

function listOf(plans: PlanListRow[]): AsyncResult<{ plans: PlanListRow[] }> {
  return { data: { plans }, loading: false, error: null, refresh: vi.fn() };
}

function renderRail(plans: PlanListRow[], searchParams = '') {
  return render(
    <PlanRail list={listOf(plans)} selectedSlugs={[]} query="" onSelect={vi.fn()} />,
    { wrapper: withNuqsTestingAdapter({ searchParams }) },
  );
}

// jsdom has no DataTransfer — provide a minimal stand-in that records setData.
function makeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    setData: vi.fn((type: string, val: string) => {
      store[type] = val;
    }),
    getData: vi.fn((type: string) => store[type] ?? ''),
    effectAllowed: 'none',
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

describe('PlanRail drag-to-reorder handle', () => {
  it('renders a native HTML5 drag handle that is NOT inside a button', () => {
    const { container } = renderRail([plan('a-2026-01-01'), plan('b-2026-01-02')]);
    const handles = container.querySelectorAll<HTMLElement>('.pc-plan-row__drag-handle');
    // Two started plans → reorder is meaningful → both rows get a handle.
    expect(handles.length).toBe(2);
    for (const h of handles) {
      // Regression #2: the handle MUST be a native HTML5 drag source. WebKitGTK
      // fires HTML5 drag events fine; the earlier "not draggable" belief was the
      // bug, not the fix.
      expect(h.getAttribute('draggable')).toBe('true');
      // Regression #1: the handle must NOT be swallowed by an interactive
      // button, or the gesture never initiates.
      expect(h.closest('button')).toBeNull();
      // And it must live inside the rail item (a sibling of the row button),
      // which carries the data-plan-slug used as the drag payload + drop target.
      const item = h.closest('.pc-plan-rail__item');
      expect(item).not.toBeNull();
      expect(item?.getAttribute('data-plan-slug')).toBeTruthy();
    }
  });

  it('dragstart sets dataTransfer data (the WebKit requirement) and a drag→drop persists the new order', async () => {
    const { container } = renderRail([plan('a-2026-01-01'), plan('b-2026-01-02')]);
    const items = Array.from(
      container.querySelectorAll<HTMLElement>('.pc-plan-rail__item[data-plan-slug]'),
    );
    expect(items.length).toBe(2);
    const firstSlug = items[0].dataset.planSlug!;
    const secondSlug = items[1].dataset.planSlug!;
    const handleOfSecond = items[1].querySelector<HTMLElement>('.pc-plan-row__drag-handle')!;
    const ul = container.querySelector('ul.pc-plan-rail__rows')!;
    const dt = makeDataTransfer();

    // Grab the second row…
    fireEvent.dragStart(handleOfSecond, { dataTransfer: dt });
    // …the load-bearing assertion: without this setData call WebKitGTK aborts
    // the drag and nothing downstream fires.
    expect(dt.setData).toHaveBeenCalledWith('text/plain', secondSlug);

    // …drag it over the first row (reorders second above first)…
    fireEvent.dragOver(items[0], { dataTransfer: dt });
    // …and drop to commit.
    fireEvent.drop(ul, { dataTransfer: dt });

    await waitFor(() => expect(setPlanPriority).toHaveBeenCalled());
    // Second slug moved to the front → priority 1; first slug pushed to 2.
    expect(setPlanPriority).toHaveBeenCalledWith(secondSlug, 1);
    expect(setPlanPriority).toHaveBeenCalledWith(firstSlug, 2);
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

  it('does not offer drag under a non-default sort (drag edits priority, which that view does not show)', () => {
    const { container } = renderRail(
      [plan('a-2026-01-01'), plan('b-2026-01-02')],
      '?pSort=title',
    );
    expect(container.querySelectorAll('.pc-plan-row__drag-handle').length).toBe(0);
  });
});

describe('PlanRail pSort ordering', () => {
  const rowSlugs = (container: HTMLElement) =>
    Array.from(
      container.querySelectorAll<HTMLElement>('.pc-plan-rail__item[data-plan-slug]'),
    ).map((el) => el.dataset.planSlug);

  it('applies the pSort nuqs key to the rendered order', () => {
    const plans = [
      plan('bravo', { startStatus: null, title: 'Bravo', updated: '2026-06-01' }),
      plan('alpha', { startStatus: null, title: 'alpha', updated: '2026-01-01' }),
    ];
    // Default smart order: same bucket → updated desc → bravo first.
    const byDefault = renderRail(plans);
    expect(rowSlugs(byDefault.container as HTMLElement)).toEqual(['bravo', 'alpha']);
    cleanup();
    // Title sort: case-insensitive A–Z → alpha first.
    const byTitle = renderRail(plans, '?pSort=title');
    expect(rowSlugs(byTitle.container as HTMLElement)).toEqual(['alpha', 'bravo']);
  });
});
