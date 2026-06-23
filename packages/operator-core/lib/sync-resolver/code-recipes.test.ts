/**
 * codeRecipes + recipeCandidates resolver coverage (code-recipes-2026-06-21 P-009).
 *
 * Asserts both queries are registered, that codeRecipes returns the hive-scoped
 * recipe rows from listRecipes() in order, and that recipeCandidates wraps the
 * { promoteCandidates, mergeClusters } envelope in a single flat row (the resolver
 * flat-row contract). The store + candidate scorer are mocked — this is the
 * resolver wiring (arg → workspace/hive resolution → shape), not the SQL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  listRecipes: vi.fn(),
  countRecipes: vi.fn(),
  recipeCandidates: vi.fn(),
  hiveHomeSlugForHarness: vi.fn(),
  activeWorkspaceId: vi.fn(() => 'ws-1'),
  buildQueryEmbedder: vi.fn(async () => null),
  buildRecipeCooccurrenceDep: vi.fn(async () => null),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../code-recipes-store', () => ({ listRecipes: H.listRecipes, countRecipes: H.countRecipes }));
vi.mock('../code-recipes-candidates', () => ({ recipeCandidates: H.recipeCandidates }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: H.activeWorkspaceId }));
vi.mock('../hive-federation', () => ({ hiveHomeSlugForHarness: H.hiveHomeSlugForHarness }));
vi.mock('../agent-tools/search/embedder', () => ({ buildQueryEmbedder: H.buildQueryEmbedder }));
vi.mock('../recipe-cooccurrence-leg', () => ({ buildRecipeCooccurrenceDep: H.buildRecipeCooccurrenceDep }));

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';

const RECIPE = {
  id: 'fetch-and-summarize',
  workspaceId: 'ws-1',
  hiveSlug: 'papercusp',
  title: 'Fetch and summarize',
  description: 'pulls a URL then summarizes',
  script: '// ...',
  authorRole: 'operator',
  toolsUsed: ['fetch:get', 'llm:summarize'],
  runCount: 7,
  successCount: 6,
  lastRunAt: '2026-06-21T00:00:00.000Z',
  status: 'active',
  promotedTool: null,
  mergedInto: null,
  tags: [],
  hasEmbedding: true,
  createdBy: 'owner:abc',
  createdAt: '2026-06-20T00:00:00.000Z',
  updatedAt: '2026-06-21T00:00:00.000Z',
};

describe('codeRecipes resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.activeWorkspaceId.mockReturnValue('ws-1');
    H.hiveHomeSlugForHarness.mockResolvedValue('papercusp');
    H.listRecipes.mockResolvedValue([RECIPE]);
    H.countRecipes.mockResolvedValue(1);
  });

  it('is registered alongside recipeCandidates in the v2 resolver', () => {
    const names = knownQueryNamesV2();
    expect(names).toContain('codeRecipes');
    expect(names).toContain('recipeCandidates');
  });

  it('returns the hive-scoped recipe rows from listRecipes() with the true total on row[0]._meta', async () => {
    H.countRecipes.mockResolvedValue(42);
    const rows = (await resolveNamedQueryV2('codeRecipes', {})) as Array<typeof RECIPE & { _meta?: { total?: number } }>;
    // The row data is preserved; row[0] carries the capped-aware total via attachListMeta.
    expect(rows[0]).toMatchObject(RECIPE);
    expect(rows[0]._meta).toEqual({ total: 42 });
    // recipes are GLOBAL (P-001): no workspace/hive filter; default LIMIT applied.
    expect(H.listRecipes).toHaveBeenCalledWith({}, { limit: 1000, includeTrivial: true });
    // COUNT is the true total (also global, no limit).
    expect(H.countRecipes).toHaveBeenCalledWith({});
  });

  it('honors an explicit limit arg (recipes are global — no hive narrowing)', async () => {
    await resolveNamedQueryV2('codeRecipes', { limit: 25 });
    expect(H.listRecipes).toHaveBeenCalledWith({}, { limit: 25, includeTrivial: true });
    expect(H.hiveHomeSlugForHarness).not.toHaveBeenCalled();
  });
});

describe('recipeCandidates resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.activeWorkspaceId.mockReturnValue('ws-1');
    H.hiveHomeSlugForHarness.mockResolvedValue('papercusp');
    H.recipeCandidates.mockResolvedValue({
      promoteCandidates: [
        {
          id: 'fetch-and-summarize',
          title: 'Fetch and summarize',
          description: 'pulls a URL then summarizes',
          runCount: 7,
          distinctAgents: 3,
          successRate: 0.86,
          toolsUsed: ['fetch:get', 'llm:summarize'],
          promotionScore: 0.61,
        },
      ],
      mergeClusters: [{ recipeIds: ['a', 'b'], reason: 'near-duplicate scripts' }],
      signals: [],
    });
  });

  it('wraps { promoteCandidates, mergeClusters } in a single flat row', async () => {
    const rows = (await resolveNamedQueryV2('recipeCandidates', {})) as unknown[];
    expect(rows).toHaveLength(1);
    const env = rows[0] as { promoteCandidates: unknown[]; mergeClusters: unknown[] };
    expect(env.promoteCandidates).toHaveLength(1);
    expect(env.mergeClusters).toHaveLength(1);
    // signals are intentionally NOT in the envelope (debug-only).
    expect(env).not.toHaveProperty('signals');
  });

  it('passes minRunCount/limit through to the scorer (recipes are global — no workspace/hive)', async () => {
    await resolveNamedQueryV2('recipeCandidates', { minRunCount: 3, limit: 10 });
    expect(H.recipeCandidates).toHaveBeenCalledWith(
      {},
      { minRunCount: 3, limit: 10 },
      expect.objectContaining({ embedder: null, toolCooccurrence: null }),
    );
  });
});
