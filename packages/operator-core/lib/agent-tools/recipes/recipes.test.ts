/**
 * recipes.test.ts — the recipes:* verbs (code-recipes-2026-06-21 Phase 2):
 *   1. registration: recipes:list/get/search/run self-register, role-gated.
 *   2. THE SECURITY INVARIANT (P-006 / D-004): recipes:run executes the recipe's
 *      script under the REUSER's role-scoped envelope (ctx.role), NEVER the
 *      author's — a recipe authored by an operator, run by a worker, can only
 *      touch worker-allowed tools. We assert the `allowed` set handed to
 *      runToolOrchestration is exactly roleScopedToolNames(all, ctx.role, …) and
 *      that an operator-only tool an operator-authored recipe could call is ABSENT
 *      when the reuser is a worker.
 *
 * No PG / embedder: getRecipe + recordRecipeRun + runToolOrchestration are mocked
 * so the test pins the role-scoping decision, not the orchestration internals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listAllProjectedTools,
  roleScopedToolNames,
} from '@papercusp/agent-mcp';

// ── Mocks ────────────────────────────────────────────────────────────────────
// recipes:run lazy/eagerly imports these; replace so no PG/orchestration runs and
// we can capture the `allowed` set the handler builds for the facade.
const { getRecipeMock, recordRecipeRunMock, runOrchestrationMock } = vi.hoisted(() => ({
  getRecipeMock: vi.fn(),
  recordRecipeRunMock: vi.fn(async () => {}),
  runOrchestrationMock: vi.fn(async () => ({ ok: true, summary: { done: true }, logs: [], dryRun: false, plannedMutations: [] })),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../code-recipes-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRecipe: getRecipeMock,
  recordRecipeRun: recordRecipeRunMock,
}));
vi.mock('../../hive-federation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hiveHomeSlugForHarness: async () => 'alpha',
}));
vi.mock('../coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveAgentIdentity: () => ({ ownerId: 'owner-reuser' }),
}));
// Capture the orchestration options (we read `allowed` from them).
vi.mock('@papercusp/agent-mcp', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runToolOrchestration: runOrchestrationMock };
});

// Side-effect: register the recipes:* tools AFTER the mocks are hoisted.
import './list';
import './get';
import './search';
import './run';
import './candidates';
import './merge';
import './sweep';

const findTool = (name: string) => {
  const t = listAllProjectedTools().find((x) => x.expose.mcp?.name === name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
};

describe('recipes:* registration (P-005, P-013)', () => {
  for (const name of ['recipes:list', 'recipes:get', 'recipes:search', 'recipes:run', 'recipes:candidates']) {
    it(`registers ${name} as a role-gated tool`, () => {
      const tool = findTool(name);
      expect(tool).toBeDefined();
      expect((tool.agentRoles?.length ?? 0)).toBeGreaterThan(0);
      // bee is in the envelope (mirrors code:run's [...SU_ROLES,'cup'])
      expect(tool.agentRoles).toContain('cup');
    });
  }

  it('recipes:run is write-effect (capability:bash) — itself dry-run-gateable', () => {
    expect(findTool('recipes:run').effect).toBe('write');
  });

  it('recipes:candidates is a READ-only graduation worklist (P-013 / D-017)', () => {
    const tool = findTool('recipes:candidates');
    expect(tool.effect).toBe('read');
    expect(tool.capabilities).toContain('intel:read');
  });

  // Phase 4 hygiene tools (P-010 / D-015): curation actions, SU-only (no bee), write-effect.
  for (const name of ['recipes:merge', 'recipes:sweep']) {
    it(`registers ${name} as an SU-only write-effect curation tool`, () => {
      const tool = findTool(name);
      expect(tool).toBeDefined();
      expect((tool.agentRoles?.length ?? 0)).toBeGreaterThan(0);
      // A review/curation action — NOT bee-authored (unlike recipes:run/get/list).
      expect(tool.agentRoles).not.toContain('cup');
      // Mutates the recipe corpus.
      expect(tool.effect).toBe('write');
      expect(tool.capabilities).toContain('intel:write');
    });
  }
});

describe('recipes:run REUSE ENVELOPE invariant (P-006 / D-004)', () => {
  beforeEach(() => {
    getRecipeMock.mockReset();
    recordRecipeRunMock.mockClear();
    runOrchestrationMock.mockClear();
  });

  const mkCtx = (role: string) =>
    ({
      log: () => {},
      workspaceId: 'ws-test',
      harnessSlug: 'alpha',
      role,
      isSuperuser: false,
      uiClientId: 'reuser-test',
    }) as never;

  it('runs the AUTHOR\'s recipe under the REUSER\'s role-scoped envelope, not the author\'s', async () => {
    // A recipe AUTHORED by an operator (privileged), referencing whatever tools.
    getRecipeMock.mockResolvedValue({
      id: 'r1',
      workspaceId: 'ws-test',
      potSlug: 'alpha',
      title: 'op recipe',
      description: 'authored by operator',
      script: 'return 1;',
      authorRole: 'operator', // ← the AUTHOR's role
      toolsUsed: [],
      runCount: 3,
      successCount: 3,
      status: 'active',
      tags: [],
    });

    // RUN it as a WORKER.
    await findTool('recipes:run').fn({ id: 'r1' }, mkCtx('worker'));

    expect(runOrchestrationMock).toHaveBeenCalledTimes(1);
    const [, opts] = runOrchestrationMock.mock.calls[0] as unknown as [
      string,
      { allowed: ReadonlySet<string>; tools: unknown[] },
    ];
    const allowed = opts.allowed;

    // The allow-set must EQUAL the WORKER's role-scoped set (exclude code:run),
    // NOT the operator author's. Compute both reference sets from the real registry.
    const all = listAllProjectedTools();
    const workerSet = roleScopedToolNames(all, 'worker', new Set(['code:run']));
    const operatorSet = roleScopedToolNames(all, 'operator', new Set(['code:run']));

    // Same membership as the worker envelope.
    expect(allowed.size).toBe(workerSet.size);
    for (const n of workerSet) expect(allowed.has(n)).toBe(true);

    // And NOT the author's: any operator-only tool (in operatorSet, absent from
    // workerSet) must be ABSENT from the reuse envelope — no privilege escalation.
    const operatorOnly = [...operatorSet].filter((n) => !workerSet.has(n));
    expect(operatorOnly.length).toBeGreaterThan(0); // sanity: there IS a privilege gap to test
    for (const n of operatorOnly) expect(allowed.has(n)).toBe(false);

    // code:run is excluded (no recursive code-mode nesting).
    expect(allowed.has('code:run')).toBe(false);
  });

  it('records the run with reused:true on a successful committing run', async () => {
    getRecipeMock.mockResolvedValue({
      id: 'r2',
      workspaceId: 'ws-test',
      potSlug: 'alpha',
      title: 't',
      description: 'd',
      script: 'return 1;',
      authorRole: 'operator',
      toolsUsed: [],
      runCount: 0,
      successCount: 0,
      status: 'active',
      tags: [],
    });
    await findTool('recipes:run').fn({ id: 'r2' }, mkCtx('worker'));
    expect(recordRecipeRunMock).toHaveBeenCalledTimes(1);
    const [, input] = recordRecipeRunMock.mock.calls[0] as unknown as [unknown, { reused: boolean; recipeId: string; agentRole: string }];
    expect(input.reused).toBe(true);
    expect(input.recipeId).toBe('r2');
    expect(input.agentRole).toBe('worker'); // the REUSER's role, recorded
  });

  it('does NOT record a run on a dry-run preview', async () => {
    getRecipeMock.mockResolvedValue({
      id: 'r3', workspaceId: 'ws-test', potSlug: 'alpha', title: 't', description: 'd',
      script: 'return 1;', authorRole: 'operator', toolsUsed: [], runCount: 0, successCount: 0, status: 'active', tags: [],
    });
    await findTool('recipes:run').fn({ id: 'r3', dryRun: true }, mkCtx('worker'));
    expect(recordRecipeRunMock).not.toHaveBeenCalled();
  });

  it('returns not_found for a missing recipe per item (no orchestration) — bulk envelope', async () => {
    getRecipeMock.mockResolvedValue(null);
    const res = await findTool('recipes:run').fn({ id: 'nope' }, mkCtx('worker'));
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    // The BATCH ran (top-level ok:true); the missing recipe is that item's failure.
    expect(payload.ok).toBe(true);
    expect(payload.counts).toEqual({ ok: 0, failed: 1 });
    expect(payload.results[0]).toMatchObject({ ok: false, id: 'nope', error: 'not_found' });
    expect(runOrchestrationMock).not.toHaveBeenCalled();
  });

  it('ids:[…] runs MANY recipes; a missing one fails only itself (keyed by id)', async () => {
    getRecipeMock.mockImplementation(async (_sql: unknown, id: string) =>
      id === 'gone'
        ? null
        : {
            id, workspaceId: 'ws-test', potSlug: 'alpha', title: 't', description: 'd',
            script: 'return 1;', authorRole: 'operator', toolsUsed: [], runCount: 0, successCount: 0, status: 'active', tags: [],
          },
    );
    const res = await findTool('recipes:run').fn({ ids: ['r1', 'gone', 'r2'] }, mkCtx('worker'));
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.counts).toEqual({ ok: 2, failed: 1 });
    expect(payload.results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
      ['r1', true],
      ['gone', false],
      ['r2', true],
    ]);
    // The two present recipes were each orchestrated; the missing one was not.
    expect(runOrchestrationMock).toHaveBeenCalledTimes(2);
  });
});

describe('recipes:get HANDLER (bulk keyed-array)', () => {
  beforeEach(() => {
    getRecipeMock.mockReset();
  });

  const ctx = { workspaceId: 'ws-test' } as never;
  const getBody = async (args: unknown) => {
    const res = await findTool('recipes:get').fn(args as never, ctx);
    return JSON.parse((res as { content: { text: string }[] }).content[0].text);
  };

  it('inline { id } → one result with the recipe (script included)', async () => {
    getRecipeMock.mockResolvedValue({
      id: 'r1', workspaceId: 'ws-test', potSlug: 'alpha', title: 't', description: 'd',
      script: 'return 1;', authorRole: 'operator', toolsUsed: [], runCount: 0, successCount: 0,
      lastRunAt: null, status: 'active', tags: [],
    });
    const b = await getBody({ id: 'r1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'r1', recipe: { id: 'r1', script: 'return 1;' } });
  });

  it('ids:[…] → many; a not-found id fails only itself', async () => {
    getRecipeMock.mockImplementation(async (_sql: unknown, id: string) =>
      id === 'x' ? null : {
        id, workspaceId: 'ws-test', potSlug: 'alpha', title: 't', description: 'd',
        script: 's', authorRole: 'operator', toolsUsed: [], runCount: 0, successCount: 0,
        lastRunAt: null, status: 'active', tags: [],
      },
    );
    const b = await getBody({ ids: ['r1', 'x', 'r2'] });
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'x', error: 'not_found' });
  });
});
