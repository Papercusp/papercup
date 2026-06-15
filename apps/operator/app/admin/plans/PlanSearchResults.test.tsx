// @vitest-environment jsdom
//
// PlanSearchResults — cross-plan search hits with client-side scope/status
// filtering (P-104). The genuine logic is the scope filter (match-location
// scopes narrow per-match; needs-human/needs-decision narrow by plan-set) and
// the searching/empty/error surfaces. usePlanSearch is mocked to return canned
// hits; the `qScope` nuqs key is driven via the nuqs testing adapter.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

const { search } = vi.hoisted(() => ({
  search: {
    data: null as null | { hits: unknown[] },
    loading: false,
    error: null as string | null,
  },
}));

vi.mock('./plans-api', () => ({
  usePlanSearch: () => ({
    data: search.data,
    loading: search.loading,
    error: search.error,
    refresh: () => {},
  }),
}));

import PlanSearchResults from './PlanSearchResults';

afterEach(() => {
  cleanup();
  search.data = null;
  search.loading = false;
  search.error = null;
});

function hit(plan: string, matches: Array<{ scope: string; snippet: string }>, score = 1) {
  return { plan, score, matches };
}

function renderWith(props: Partial<Parameters<typeof PlanSearchResults>[0]> = {}, searchParams = '?') {
  const onUrlUpdate = vi.fn();
  const utils = render(
    <PlanSearchResults query="memory" onPick={() => {}} {...props} />,
    { wrapper: withNuqsTestingAdapter({ searchParams, onUrlUpdate }) },
  );
  return { ...utils, onUrlUpdate };
}

describe('<PlanSearchResults />', () => {
  it('shows the searching placeholder while loading', () => {
    search.loading = true;
    renderWith();
    expect(screen.getByText(/searching…/i)).toBeTruthy();
  });

  it('renders the error surface with a retry button', () => {
    search.error = 'index down';
    renderWith();
    expect(screen.getByText('index down')).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('lists a hit per plan with its matches under the "all" scope', async () => {
    search.data = {
      hits: [
        hit('plan-a', [{ scope: 'title', snippet: 'mem in title' }]),
        hit('plan-b', [{ scope: 'prose', snippet: 'mem in prose' }]),
      ],
    };
    const { container } = renderWith();
    await waitFor(() => expect(container.querySelectorAll('.pc-search__hit')).toHaveLength(2));
    expect(screen.getByText('plan-a')).toBeTruthy();
    expect(screen.getByText('plan-b')).toBeTruthy();
  });

  it('filters matches down to the selected match-location scope (?qScope=title)', async () => {
    search.data = {
      hits: [
        hit('plan-a', [
          { scope: 'title', snippet: 'in title' },
          { scope: 'prose', snippet: 'in prose' },
        ]),
        hit('plan-b', [{ scope: 'prose', snippet: 'only prose' }]),
      ],
    };
    // qScope=title → plan-a keeps its title match; plan-b (prose-only) drops out.
    const { container } = renderWith({}, '?qScope=title');
    await waitFor(() => expect(container.querySelectorAll('.pc-search__hit')).toHaveLength(1));
    expect(screen.getByText('plan-a')).toBeTruthy();
    expect(screen.queryByText('plan-b')).toBeNull();
  });

  it('narrows by plan-set for the needs-human status filter (?qScope=needs-human)', async () => {
    search.data = {
      hits: [
        hit('plan-a', [{ scope: 'prose', snippet: 'x' }]),
        hit('plan-b', [{ scope: 'prose', snippet: 'y' }]),
      ],
    };
    const { container } = renderWith(
      { needsHumanPlans: new Set(['plan-b']) },
      '?qScope=needs-human',
    );
    await waitFor(() => expect(container.querySelectorAll('.pc-search__hit')).toHaveLength(1));
    expect(screen.getByText('plan-b')).toBeTruthy();
  });

  it('shows the scoped empty-state when a filter removes every hit', async () => {
    search.data = { hits: [hit('plan-a', [{ scope: 'prose', snippet: 'x' }])] };
    renderWith({ needsHumanPlans: new Set() }, '?qScope=needs-human');
    await waitFor(() => expect(screen.getByText(/no matches in needs human/i)).toBeTruthy());
  });

  it('fires onPick with the plan slug when a hit is clicked', async () => {
    search.data = { hits: [hit('plan-a', [{ scope: 'title', snippet: 'x' }])] };
    const onPick = vi.fn();
    renderWith({ onPick });
    await waitFor(() => expect(screen.getByText('plan-a')).toBeTruthy());
    fireEvent.click(screen.getByText('plan-a').closest('button')!);
    expect(onPick).toHaveBeenCalledWith('plan-a');
  });

  it('narrows by plan-set for the needs-decision status filter (?qScope=needs-decision)', async () => {
    search.data = {
      hits: [
        hit('plan-a', [{ scope: 'prose', snippet: 'x' }]),
        hit('plan-b', [{ scope: 'prose', snippet: 'y' }]),
      ],
    };
    const { container } = renderWith({ needsDecisionPlans: new Set(['plan-a']) }, '?qScope=needs-decision');
    await waitFor(() => expect(container.querySelectorAll('.pc-search__hit')).toHaveLength(1));
    expect(screen.getByText('plan-a')).toBeTruthy();
    expect(screen.queryByText('plan-b')).toBeNull();
  });

  it('clicking a scope chip writes ?qScope and re-filters the rendered hits', async () => {
    search.data = {
      hits: [
        hit('plan-a', [{ scope: 'title', snippet: 'in title' }, { scope: 'prose', snippet: 'in prose' }]),
        hit('plan-b', [{ scope: 'prose', snippet: 'only prose' }]),
      ],
    };
    const { onUrlUpdate } = renderWith();
    await waitFor(() => expect(screen.getByText('plan-b')).toBeTruthy());
    // click the "title" scope chip → the qScope param is written, plan-b (prose-only) drops
    fireEvent.click(screen.getByRole('button', { name: 'title', pressed: false }));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    expect(onUrlUpdate.mock.calls.at(-1)![0].searchParams.get('qScope')).toBe('title');
    await waitFor(() => expect(screen.queryByText('plan-b')).toBeNull());
    expect(screen.getByText('plan-a')).toBeTruthy();
  });

  it('caps the visible matches at 4 and shows a "+ N more" row', async () => {
    search.data = {
      hits: [
        hit(
          'plan-a',
          Array.from({ length: 6 }, (_, i) => ({ scope: 'prose', snippet: `m${i}` })),
        ),
      ],
    };
    renderWith();
    await waitFor(() => expect(screen.getByText('plan-a')).toBeTruthy());
    expect(screen.getByText('+ 2 more')).toBeTruthy();
  });
});
