// @vitest-environment jsdom
//
// RecipesClient render coverage (code-recipes-2026-06-21 P-009) — mounts the
// /admin Recipes dashboard against mock `codeRecipes` + `recipeCandidates` sync
// data (useSyncQuery + nuqs stubbed) and asserts the recipe table, the promote
// candidates, the merge clusters, and the loading/empty states render. Guards
// against render-time crashes the typecheck can't catch (null derefs in the JSX,
// the candidates-envelope unwrap).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// nuqs: useQueryState needs the adapter context — stub it. The two params the
// component uses (rstatus, rsort) both default; return a stable [default, noop].
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => [key === 'rsort' ? 'lastRun' : 'all', vi.fn()],
  parseAsStringEnum: () => ({ withDefault: (d: unknown) => d }),
}));

const RECIPES = [
  {
    id: 'fetch-and-summarize',
    title: 'Fetch and summarize',
    description: 'pulls a URL then summarizes it',
    toolsUsed: ['fetch:get', 'llm:summarize'],
    runCount: 7,
    successCount: 6,
    lastRunAt: new Date(Date.now() - 3600_000).toISOString(),
    status: 'active',
    authorRole: 'operator',
    promotedTool: null,
    hiveSlug: 'papercusp',
  },
  {
    id: 'old-oneoff',
    title: 'Old one-off',
    description: 'never reused',
    toolsUsed: ['bash:run'],
    runCount: 1,
    successCount: 1,
    lastRunAt: new Date(Date.now() - 40 * 86400_000).toISOString(),
    status: 'retired',
    authorRole: 'bee',
    promotedTool: null,
    hiveSlug: 'papercusp',
  },
];

const CANDIDATES_ENVELOPE = {
  promoteCandidates: [
    {
      id: 'fetch-and-summarize',
      title: 'Fetch and summarize',
      description: 'pulls a URL then summarizes it',
      runCount: 7,
      distinctAgents: 3,
      successRate: 0.86,
      toolsUsed: ['fetch:get', 'llm:summarize'],
      promotionScore: 0.61,
    },
  ],
  mergeClusters: [{ recipeIds: ['dup-a', 'dup-b'], reason: 'near-duplicate scripts' }],
};

// Route the two sync queries by name to the right mock payload.
let recipesResult: Record<string, unknown>;
let candidatesResult: Record<string, unknown>;
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string }) =>
    opts.queryName === 'codeRecipes' ? recipesResult : candidatesResult,
}));

import RecipesClient from './RecipesClient';

afterEach(() => cleanup());

function setData(recipes: unknown[], envelope: unknown, loading = false) {
  recipesResult = { data: recipes, loading, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
  candidatesResult = { data: envelope ? [envelope] : [], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
}

describe('RecipesClient', () => {
  it('renders the recipe table, the corpus summary, and tool badges', () => {
    setData(RECIPES, CANDIDATES_ENVELOPE);
    render(<RecipesClient />);

    expect(screen.getByText('Code recipes')).toBeTruthy();
    // Both recipe titles appear (one in the table, "Fetch and summarize" also in
    // candidates — so just assert presence).
    expect(screen.getAllByText('Fetch and summarize').length).toBeGreaterThan(0);
    expect(screen.getByText('Old one-off')).toBeTruthy();
    // tool badges render.
    expect(screen.getAllByText('fetch:get').length).toBeGreaterThan(0);
    expect(screen.getByText('bash:run')).toBeTruthy();
    // status pills.
    expect(screen.getAllByText('active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('retired').length).toBeGreaterThan(0);
  });

  it('renders the promote candidates with their promotion score + signals', () => {
    setData(RECIPES, CANDIDATES_ENVELOPE);
    render(<RecipesClient />);

    expect(screen.getByText('Promote candidates')).toBeTruthy();
    expect(screen.getByText('0.61')).toBeTruthy(); // promotionScore.toFixed(2)
    expect(screen.getByText('agents')).toBeTruthy();
  });

  it('renders the merge clusters section', () => {
    setData(RECIPES, CANDIDATES_ENVELOPE);
    render(<RecipesClient />);

    expect(screen.getByText('Merge clusters')).toBeTruthy();
    expect(screen.getByText('dup-a')).toBeTruthy();
    expect(screen.getByText('dup-b')).toBeTruthy();
    expect(screen.getByText('near-duplicate scripts')).toBeTruthy();
  });

  it('renders the loading state with no data', () => {
    setData([], null, true);
    render(<RecipesClient />);
    expect(screen.getByText(/Loading recipes/i)).toBeTruthy();
  });

  it('renders the empty state when there are no recipes', () => {
    setData([], { promoteCandidates: [], mergeClusters: [] });
    render(<RecipesClient />);
    expect(screen.getByText(/No recipes captured yet/i)).toBeTruthy();
    expect(screen.getByText(/No promote candidates right now/i)).toBeTruthy();
  });
});
