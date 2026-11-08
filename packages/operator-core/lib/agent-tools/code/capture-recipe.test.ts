/**
 * capture-recipe.test.ts — the PURE code:run → recipe capture helpers
 * (code-recipes-2026-06-21 Phase 1, P-003): slug derivation, the always-derive
 * fallback title/description (so a recipe is ALWAYS saveable), and tools_used
 * extraction via the parse-check ref resolver mapped to canonical ns:verb.
 *
 * The PG/embedder side of captureRecipe is exercised through the store
 * integration test + the run.test.ts capture-trigger test; this file pins the
 * deterministic derivation logic with no PG.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ensureParseCheckReady } from '@papercusp/tooldef';
import {
  recipeSlug,
  recipeId,
  deriveTitleDescription,
  extractToolsUsed,
  selectRecipeCaptureTarget,
  captureRecipe,
} from './capture-recipe';
import type { CodeRecipeRow, UpsertCodeRecipeInput } from '../../code-recipes-store';

const captureStore = vi.hoisted(() => ({ rows: new Map<string, CodeRecipeRow>(),
  record: vi.fn(async () => {}), structural: vi.fn(async () => null), similar: vi.fn(async () => []) }));
vi.mock('../../code-recipes-store', async original => ({
  ...(await original<Record<string, unknown>>()),
  getRecipe: async (_sql: unknown, id: string) => captureStore.rows.get(id) ?? null,
  upsertRecipe: async (_sql: unknown, input: UpsertCodeRecipeInput) => {
    const row = { ...input, status: 'active', runCount: 0, successCount: 0, updatedAt: new Date().toISOString() } as CodeRecipeRow;
    captureStore.rows.set(input.id, row); return row;
  },
  recordRecipeRun: captureStore.record,
  findActiveRecipeByStructuralFingerprint: captureStore.structural,
}));
vi.mock('../../code-recipes-search', () => ({ searchSimilarRecipes: captureStore.similar }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: async () => {} }));

// extractToolsUsed → checkScript uses a lazy-loaded TS compiler (kept out of the
// eager client bundle) — warm it once before the suite.
beforeAll(async () => { await ensureParseCheckReady(); });

const mkTool = (name: string) => ({ expose: { mcp: { name } } }) as never;
const TOOLS = [
  mkTool('work_items:list'),
  mkTool('work_items:get'),
  mkTool('coord:wake-queue'),
  mkTool('plans:set-status'),
];

describe('automatic private operation capture through the shared store', () => {
  const scope = { workspaceId: 'workspace-private', sourceBoundary: 'authorized-tool-ledger',
    epoch: '2026-11', key: new Uint8Array(32).fill(57) };
  beforeEach(() => { captureStore.rows.clear(); vi.clearAllMocks(); });
  const deps = () => ({ sql: {} as never, embed: vi.fn(async () => null), resolveHive: async () => 'home' });
  const make = (family: 'sql' | 'shell', id = '123', value = 'PRIVATE_SAMPLE') => ({
    script: '/* PRIVATE_TITLE */ return "PRIVATE_WRAPPER";', workspaceId: scope.workspaceId, harness: 'alpha',
    ownerId: 'agent-a', role: 'operator', title: 'PRIVATE_TITLE', description: 'PRIVATE_DESCRIPTION', tags: ['PRIVATE_TAG'],
    tools: [mkTool('dev:pg_query'), mkTool('capability:bash')], allowed: new Set(['dev:pg_query', 'capability:bash']),
    operationSource: { scope, source: { id, workspaceId: scope.workspaceId, harness: 'alpha', at: new Date().toISOString(),
      tool: family === 'sql' ? 'dev:pg_query' : 'capability:bash',
      args: family === 'sql' ? { sql: 'SELECT $1::text AS PRIVATE_COLUMN', parameters: [value] }
        : { command: `printf '%s' '${value}'`, cwd: '/PRIVATE_PATH' } } },
  });
  for (const family of ['sql', 'shell'] as const) {
    it(`${family}: stores only the adapter/ref/schema and deduplicates changed typed values`, async () => {
      const d = deps();
      const first = await captureRecipe(d, make(family));
      expect(first?.disposition).toBe('created');
      expect(first?.row.bindingSchema?.properties).toMatchObject({ value0: { type: 'string', required: true } });
      expect(JSON.stringify(first?.row)).not.toContain('PRIVATE_');
      expect(JSON.stringify(d.embed.mock.calls)).not.toContain('PRIVATE_');
      const next = await captureRecipe(d, make(family, '124', 'ANOTHER_SAMPLE'));
      expect(next?.disposition).toBe('exact-fingerprint-reuse');
      expect(next?.row.id).toBe(first?.row.id);
      expect(next?.row.capabilityManifest?.sourceOperation?.invocationId).toBe('124');
      expect(captureStore.rows.size).toBe(1);
      expect(captureStore.structural).not.toHaveBeenCalled();
      expect(captureStore.similar).not.toHaveBeenCalled();
      expect(captureStore.record).toHaveBeenCalledTimes(2);
      expect(captureStore.record.mock.calls[1]).toEqual([expect.anything(), expect.objectContaining({ reused: true })]);
    });

    it(`${family}: distinguishes fixed semantics, binding types and source scope`, async () => {
      const first = await captureRecipe(deps(), make(family));
      const changed = make(family, '125');
      changed.operationSource.source.args = family === 'sql'
        ? { sql: 'SELECT $1::text AS DIFFERENT_COLUMN', parameters: ['PRIVATE_SAMPLE'] }
        : { command: "printf '%s\\n' 'PRIVATE_SAMPLE'", cwd: '/PRIVATE_PATH' };
      expect((await captureRecipe(deps(), changed))?.row.id).not.toBe(first?.row.id);
      const foreign = make(family, '126'); foreign.harness = foreign.operationSource.source.harness = 'beta';
      expect((await captureRecipe(deps(), foreign))?.row.id).not.toBe(first?.row.id);
      const denied = make(family); denied.allowed.clear();
      expect(await captureRecipe(deps(), denied)).toBeNull();
      const mismatched = make(family); mismatched.operationSource.source.workspaceId = 'foreign';
      expect(await captureRecipe(deps(), mismatched)).toBeNull();
    });
  }

  it('does not turn unsupported or expired source evidence into a recipe', async () => {
    const bad = make('shell'); bad.operationSource.source.args = { command: 'echo x; rm /tmp/x', cwd: '/tmp' };
    expect(await captureRecipe(deps(), bad)).toBeNull();
    const expired = make('sql'); expired.operationSource.source.at = '2000-01-01T00:00:00Z';
    expect(await captureRecipe(deps(), expired)).toBeNull();
    expect(captureStore.rows.size).toBe(0);
    expect(captureStore.record).not.toHaveBeenCalled();
  });
});

describe('recipeSlug', () => {
  it('kebab-cases a title into a stable slug', () => {
    expect(recipeSlug('Triage Stale Work-Items!')).toBe('triage-stale-work-items');
    expect(recipeSlug('  leading/trailing  ')).toBe('leading-trailing');
  });
});

describe('recipeId — explicit title is the stable dedup key; auto-derived gets a content-hash suffix (P-003)', () => {
  it('uses the bare slug when the agent GAVE a title (the intended explicit dedup key)', () => {
    const id = recipeId('Triage Stale Items', 'desc', 'return 1;', { title: 'Triage Stale Items' });
    expect(id).toBe('triage-stale-items');
    // re-deriving with the same explicit title is stable (upserts in place)
    expect(recipeId('Triage Stale Items', 'desc', 'return 2;', { title: 'Triage Stale Items' })).toBe(
      'triage-stale-items',
    );
  });

  it('suffixes a content-hash when the title was AUTO-DERIVED (no given.title)', () => {
    const id = recipeId('recipe: a + b', 'd', 'return 1;', {});
    expect(id).toMatch(/^recipe-a-b-[0-9a-f]{8}$/);
  });

  it('two DIFFERENT auto-derived scripts with the SAME fallback title get DISTINCT ids (no clobber)', () => {
    const idA = recipeId('recipe: a + b', 'd', 'return 1;', {});
    const idB = recipeId('recipe: a + b', 'd', 'return 2;', {});
    expect(idA).not.toBe(idB); // different script ⇒ different hash suffix
    // same script ⇒ same id (deterministic)
    expect(recipeId('recipe: a + b', 'd', 'return 1;', {})).toBe(idA);
  });
});

describe('extractToolsUsed', () => {
  it('maps dotted refs back to canonical ns:verb (sorted, de-duped)', () => {
    const used = extractToolsUsed(
      `const o = await tools.work_items.list({});
       for (const w of o.items) await tools.work_items.get({ id: w.id });
       await tools.coord.wakeQueue();`,
      TOOLS,
    );
    expect(used).toEqual(['coord:wake-queue', 'work_items:get', 'work_items:list']);
  });

  it('maps a bracket ref with a kebab-case verb back to its canonical tool name', () => {
    const used = extractToolsUsed(
      `await tools.capability["git-evidence"]({ path: 'packages/operator-core' });`,
      [...TOOLS, mkTool('capability:git-evidence')],
    );
    expect(used).toEqual(['capability:git-evidence']);
  });

  it('resolves the tools.call() escape-hatch full name', () => {
    const used = extractToolsUsed(`await tools.call('plans:set-status', { id: 'P-1' });`, TOOLS);
    expect(used).toEqual(['plans:set-status']);
  });

  it('respects the allow-list (a ref outside it is not counted)', () => {
    const used = extractToolsUsed(
      `await tools.work_items.list({}); await tools.plans.setStatus({});`,
      TOOLS,
      new Set(['work_items:list']),
    );
    expect(used).toEqual(['work_items:list']);
  });

  it('returns [] for a tool-free script', () => {
    expect(extractToolsUsed('return 1 + 1;', TOOLS)).toEqual([]);
  });
});

describe('deriveTitleDescription — always produces a saveable title + description', () => {
  it('uses agent-supplied title/description when given', () => {
    const r = deriveTitleDescription('return 1;', ['coord:send'], {
      title: 'My recipe',
      description: 'does a thing',
    });
    expect(r.title).toBe('My recipe');
    expect(r.description).toBe('does a thing');
  });

  it('falls back to the first // comment for the title', () => {
    const r = deriveTitleDescription(
      `// triage stale items\nawait tools.work_items.list({});`,
      ['work_items:list'],
      {},
    );
    expect(r.title).toBe('triage stale items');
    expect(r.description).toBe('auto-captured recipe: calls work_items:list');
  });

  it('falls back to the tool-set for the title when there is no comment', () => {
    const r = deriveTitleDescription(
      `await tools.work_items.list({}); await tools.coord.wakeQueue();`,
      ['coord:wake-queue', 'work_items:list'],
      {},
    );
    expect(r.title).toBe('recipe: coord:wake-queue + work_items:list');
    expect(r.description).toBe('auto-captured recipe: calls coord:wake-queue, work_items:list');
  });

  it('degrades to "untitled recipe" / "no tools" for a tool-free, comment-free script', () => {
    const r = deriveTitleDescription('return 1;', [], {});
    expect(r.title).toBe('untitled recipe');
    expect(r.description).toBe('auto-captured recipe: calls no tools');
    expect(recipeSlug(r.title)).toBe('untitled-recipe'); // still produces a valid slug
  });
});

describe('selectRecipeCaptureTarget (P-014)', () => {
  it('prefers an exact structural-fingerprint match over stronger advisory candidates', () => {
    expect(selectRecipeCaptureTarget({
      proposedId: 'new-candidate',
      exactRecipeId: 'exact-candidate',
      similarRecipes: [{ id: 'near-candidate', similarity: 0.99 }],
    })).toEqual({
      id: 'exact-candidate',
      disposition: 'exact-fingerprint-reuse',
      matchedSimilarity: null,
    });
  });

  it('reuses the strongest certified near match at the existing 0.8 threshold', () => {
    const matchingEvidence = { domain: { verdict: 'equivalent' as const, basis: 'exact-source-and-contract' } };
    expect(selectRecipeCaptureTarget({
      proposedId: 'new-candidate',
      similarRecipes: [
        { id: 'z-candidate', similarity: 0.8, matchingEvidence },
        { id: 'a-candidate', similarity: 0.8, matchingEvidence },
        { id: 'below', similarity: 0.799, matchingEvidence },
      ],
    })).toEqual({
      id: 'a-candidate',
      disposition: 'near-similarity-reuse',
      matchedSimilarity: 0.8,
    });
  });

  it('does not merge a perfect clone or semantic neighbor without domain equivalence', () => {
    for (const verdict of ['unknown', 'different'] as const) {
      expect(selectRecipeCaptureTarget({ proposedId: 'new', similarRecipes: [{ id: 'neighbor', similarity: 1,
        matchingEvidence: { domain: { verdict, basis: 'domain-adapter-required' } } }] })).toEqual({
        id: 'new', disposition: 'created', matchedSimilarity: null,
      });
    }
    expect(selectRecipeCaptureTarget({ proposedId: 'new', similarRecipes: [{ id: 'legacy', similarity: 1 }] }).id).toBe('new');
  });

  it('creates the proposed candidate when no exact or qualifying near match exists', () => {
    const similarRecipes = [{
      id: 'below',
      similarity: 0.799,
      matchingEvidence: { domain: { verdict: 'equivalent' as const, basis: 'exact-source-and-contract' } },
    }];
    expect(selectRecipeCaptureTarget({
      proposedId: 'new-candidate',
      similarRecipes,
    })).toEqual({
      id: 'new-candidate',
      disposition: 'created',
      matchedSimilarity: null,
    });
    expect(selectRecipeCaptureTarget({
      proposedId: 'new-candidate',
      similarRecipes,
      nearDuplicateThreshold: 0.799,
    })).toEqual({
      id: 'below',
      disposition: 'near-similarity-reuse',
      matchedSimilarity: 0.799,
    });
  });
});

describe('P008 capture target revision guard', () => {
  it('creates a separate candidate when a certified neighbor changed after the search read', async () => {
    captureStore.rows.clear(); vi.clearAllMocks();
    captureStore.rows.set('stale-neighbor', { id: 'stale-neighbor', title: 'Old candidate', script: 'return 2;',
      status: 'active', bindingSchema: null, capabilityManifest: null } as CodeRecipeRow);
    captureStore.similar.mockResolvedValueOnce([{ id: 'stale-neighbor', similarity: 1, toolsUsed: [],
      matchingEvidence: { domain: { verdict: 'equivalent', basis: 'exact-source-and-contract' } } }] as never);
    const result = await captureRecipe({ sql: {} as never, embed: async () => null, resolveHive: async () => null }, {
      script: 'return 1;', title: 'P008 current source', workspaceId: 'p008-guard', harness: 'alpha',
      ownerId: 'agent-a', role: 'operator', tools: [],
    });
    expect(result?.disposition).toBe('created');
    expect(result?.row.id).not.toBe('stale-neighbor');
    expect(result?.row.script).toBe('return 1;');
    expect(captureStore.rows.get('stale-neighbor')?.script).toBe('return 2;');
  });
});
