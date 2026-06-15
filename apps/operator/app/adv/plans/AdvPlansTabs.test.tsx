// @vitest-environment jsdom
//
// AdvPlansTabs — the VSCode-style tab strip over PlansClient. Two parts:
//   • PURE label helpers (truncate / labelForPlan) — exported + tested
//     branch-by-branch (title wins, else date-suffix-stripped slug, else slug,
//     all capped at 32 chars).
//   • A render-smoke driving the strip through mocked nuqs (a per-key store the
//     tests seed) + a mocked usePlanList, asserting the pinned Plans/Search tabs,
//     one closeable tab per ?tabs= slug, the derived active highlight, and that
//     focus/close write the expected nuqs params.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// ── nuqs: a per-key store the tests seed; setters mutate the store + record. ──
const { nuqs, setters, mkSetter } = vi.hoisted(() => {
  const nuqs: Record<string, unknown> = {};
  const setters: Record<string, ReturnType<typeof vi.fn>> = {};
  const mkSetter = (key: string) => {
    if (!setters[key]) {
      setters[key] = vi.fn(async (v: unknown) => {
        nuqs[key] = typeof v === 'function' ? (v as (p: unknown) => unknown)(nuqs[key]) : v;
      });
    }
    return setters[key];
  };
  return { nuqs, setters, mkSetter };
});
vi.mock('nuqs', () => {
  const parser = { withDefault: () => ({}) };
  return {
    useQueryState: (key: string) => [nuqs[key], mkSetter(key)],
    parseAsString: parser,
    parseAsStringEnum: () => parser,
    parseAsArrayOf: () => parser,
  };
});

// usePlanList → a fixed list so labelForPlan can resolve human titles.
vi.mock('../../admin/plans/plans-api', () => ({
  usePlanList: () => ({
    data: { plans: [{ slug: 'alpha-plan-2026-01-02', title: 'Alpha Plan' }, { slug: 'beta-plan', title: null }] },
    loading: false,
    error: null,
  }),
}));

import AdvPlansTabs, { truncate, labelForPlan } from './AdvPlansTabs';

beforeEach(() => {
  for (const k of Object.keys(nuqs)) delete nuqs[k];
  for (const k of Object.keys(setters)) delete setters[k];
  nuqs.plan = null;
  nuqs.q = '';
  nuqs.pane = 'read';
  nuqs.tabs = [];
});
afterEach(() => cleanup());

describe('truncate', () => {
  it('returns the string unchanged when within the limit', () => {
    expect(truncate('short', 10)).toBe('short');
  });
  it('truncates with an ellipsis past the limit (length === n+1 chars in)', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('labelForPlan', () => {
  it('prefers a human title (trimmed, capped)', () => {
    expect(labelForPlan('whatever-slug', '  My Title  ')).toBe('My Title');
  });
  it('falls back to the slug with the trailing -YYYY-MM-DD stripped', () => {
    expect(labelForPlan('cool-feature-2026-06-15', null)).toBe('cool-feature');
  });
  it('uses the slug verbatim when there is no title and no date suffix', () => {
    expect(labelForPlan('plain-slug', '')).toBe('plain-slug');
  });
  it('caps a long title at 32 chars with an ellipsis', () => {
    const long = 'x'.repeat(50);
    expect(labelForPlan('s', long)).toHaveLength(32);
    expect(labelForPlan('s', long).endsWith('…')).toBe(true);
  });
});

describe('<AdvPlansTabs /> strip', () => {
  it('always renders the two pinned tabs (Plans + Search) when nothing is open', () => {
    render(<AdvPlansTabs><div /></AdvPlansTabs>);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Plans', 'Search']);
    // none are closeable → no × buttons
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
  });

  it('marks the index tab active when no plan is open and the query is empty', () => {
    render(<AdvPlansTabs><div /></AdvPlansTabs>);
    const index = screen.getAllByRole('tab').find((t) => t.textContent === 'Plans')!;
    expect(index.getAttribute('aria-selected')).toBe('true');
  });

  it('marks the Search tab active and labels it with the query when ?q is set', () => {
    nuqs.q = 'migrations';
    render(<AdvPlansTabs><div /></AdvPlansTabs>);
    const search = screen.getAllByRole('tab').find((t) => t.textContent?.startsWith('Search'))!;
    expect(search.getAttribute('aria-selected')).toBe('true');
    expect(search.textContent).toContain('migrations');
  });

  it('renders a closeable tab per open slug (human title resolved) and marks the open one active', () => {
    nuqs.tabs = ['alpha-plan-2026-01-02', 'beta-plan'];
    nuqs.plan = 'beta-plan';
    render(<AdvPlansTabs><div /></AdvPlansTabs>);
    // titled tab uses its title; the untitled one strips no date (no suffix) → slug
    expect(screen.getByText('Alpha Plan')).toBeTruthy();
    expect(screen.getByText('beta-plan')).toBeTruthy();
    const open = screen.getAllByRole('tab').find((t) => t.getAttribute('title') === 'beta-plan')!;
    expect(open.getAttribute('aria-selected')).toBe('true');
    // both plan tabs are closeable
    expect(screen.getAllByRole('button', { name: /close/i })).toHaveLength(2);
  });

  it('focusing the index tab clears slug + query', () => {
    nuqs.tabs = ['beta-plan'];
    nuqs.plan = 'beta-plan';
    render(<AdvPlansTabs><div /></AdvPlansTabs>);
    fireEvent.click(screen.getByRole('button', { name: 'Plans' }));
    expect(setters.plan).toHaveBeenCalledWith(null);
    expect(setters.q).toHaveBeenCalledWith('');
  });

  it('focusing a plan tab sets ?plan to that slug', () => {
    nuqs.tabs = ['beta-plan'];
    render(<AdvPlansTabs><div /></AdvPlansTabs>);
    fireEvent.click(screen.getByRole('button', { name: 'beta-plan' }));
    expect(setters.plan).toHaveBeenCalledWith('beta-plan');
  });

  it('closing the active plan tab drops it from ?tabs and clears ?plan when none remain', () => {
    nuqs.tabs = ['beta-plan'];
    nuqs.plan = 'beta-plan';
    render(<AdvPlansTabs><div /></AdvPlansTabs>);
    fireEvent.click(screen.getByRole('button', { name: /close beta-plan/i }));
    expect(setters.tabs).toHaveBeenCalledWith([]);
    expect(setters.plan).toHaveBeenCalledWith(null);
  });
});
