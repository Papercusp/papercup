import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listAllProjectedTools } from '@papercusp/agent-mcp';

// ── Mocks for the CAPTURE wiring (code-recipes-2026-06-21 P-003) ─────────────
// maybeCaptureRecipe lazy-imports these; replace them so no PG / embedder /
// registry is touched and we can assert captureRecipe was invoked on success.
const { captureRecipeMock } = vi.hoisted(() => ({
  captureRecipeMock: vi.fn<typeof import('./capture-recipe').captureRecipe>(async () => null),
}));
vi.mock('./capture-recipe', () => ({
  captureRecipe: captureRecipeMock,
}));
// ── Mocks for the WI-1411 per-inner-call rebinding wiring ────────────────────
// withWorkspace/synthesizeDispatchPrincipal/runWithWorkspaceIfConcrete would
// otherwise open a real PG transaction — replace them with spies so
// bindInnerDispatch's own branch logic (crossWorkspace / hop / fast-path) is
// what's under test, not a live database.
const { withWorkspaceMock, synthesizeDispatchPrincipalMock, runWithWorkspaceIfConcreteMock } = vi.hoisted(() => ({
  withWorkspaceMock: vi.fn(async (workspaceId: string, fn: (tx: unknown) => unknown) => fn({ __tx: workspaceId })),
  synthesizeDispatchPrincipalMock: vi.fn(async (tx: unknown, spawnCtx: { workspaceId: string; role: string }) => ({
    slug: `system:${spawnCtx.role}`,
    workspaceId: spawnCtx.workspaceId,
    capabilities: new Set<string>(),
    __tx: tx,
  })),
  runWithWorkspaceIfConcreteMock: vi.fn(async (_workspaceId: string | undefined, fn: () => unknown) => fn()),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: { __admin: true } }),
  withWorkspace: withWorkspaceMock,
}));
vi.mock('../../workspace-als', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runWithWorkspaceIfConcrete: runWithWorkspaceIfConcreteMock,
}));
vi.mock('../../endpoint-route/routes/transport/role-principal-caps', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  synthesizeDispatchPrincipal: synthesizeDispatchPrincipalMock,
}));
vi.mock('../search/embedder', () => ({
  buildQueryEmbedder: async () => null,
  interactiveEmbedAcquireBudgetMs: () => 4000,
}));
vi.mock('../../hive-federation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  potHomeSlugForHarness: async () => 'alpha',
}));
vi.mock('../coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveAgentIdentity: () => ({ ownerId: 'owner-x' }),
}));

import {
  shapeCodeRunLogs,
  shapeCodeRunSummary,
  shapeMutationEcho,
  annotateChildFailureWarning,
  bindInnerDispatch,
  buildFacadeHelp,
  shapeCodeRunSimilarRecipes,
  isRecipeCaptureEligible,
} from './run'; // named import ALSO runs the side-effect: registers code:run (AFTER the mocks are hoisted)

/**
 * B-CX-2A: the code:run tool registers into the projected registry, is marked write-effect
 * (so it's itself dry-run-gateable), and is open to ALL roles (owner directive 2026-06-25 — the
 * facade stays role-scoped per inner call, so the grant is privilege-preserving).
 */
describe('code:run registration (B-CX-2A)', () => {
  it('registers code:run as a write-effect tool open to every role', () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    expect(tool).toBeDefined();
    expect(tool?.effect).toBe('write');
    expect(tool?.skipWorkspaceTx).toBe(true);
    expect((tool?.agentRoles?.length ?? 0)).toBeGreaterThan(0);
    // All-roles widening: roles excluded under the old [...SU_ROLES,'cup'] gate now qualify.
    for (const role of ['worker', 'cup', 'papercup', 'kettle', 'reviewer']) {
      expect(tool?.agentRoles).toContain(role);
    }
  });

  it('documents JavaScript escaping for shell backslash-zero commands', () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    const scriptDescription =
      (tool?.inputSchema as { properties?: { script?: { description?: string } } })?.properties?.script?.description ?? '';
    expect(scriptDescription).toContain("tr '\\\\0' ' '");
    expect(scriptDescription).toContain('two backslashes in the script source');
    expect(scriptDescription).toContain('a NUL and is rejected before bash runs');
  });
});

/**
 * code-recipes-2026-06-21 P-003: a SUCCESSFUL, non-dry-run code:run captures the
 * script as a reusable recipe; a dry-run preview does NOT.
 */
describe('code:run → recipe capture (P-003)', () => {
  const codeRun = () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    if (!tool) throw new Error('code:run not registered');
    return tool;
  };
  const mkCtx = () =>
    ({
      log: () => {},
      // minimal spawn-context identity the capture path reads
      workspaceId: 'ws-test',
      harnessSlug: 'alpha',
      role: 'su',
      isSuperuser: true,
      uiClientId: 'su-test',
    }) as never;

  beforeEach(() => {
    captureRecipeMock.mockClear();
  });

  it('captures a recipe after a successful run', async () => {
    const tool = codeRun();
    const res = await tool.fn({ script: 'return 1 + 1;', title: 'add', description: 'adds' }, mkCtx());
    // the tool returns the orchestration result as JSON text
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.ok).toBe(true);

    expect(captureRecipeMock).toHaveBeenCalledTimes(1);
    const [, input] = captureRecipeMock.mock.calls[0] as unknown as [unknown, { script: string; workspaceId: string; title?: string }];
    expect(input.script).toBe('return 1 + 1;');
    expect(input.workspaceId).toBe('ws-test');
    expect(input.title).toBe('add');
  });

  it('does NOT capture on a dry-run preview', async () => {
    const tool = codeRun();
    await tool.fn({ script: 'return 1;', dryRun: true }, mkCtx());
    expect(captureRecipeMock).not.toHaveBeenCalled();
  });

  it('does NOT capture when the run fails', async () => {
    const tool = codeRun();
    const res = await tool.fn({ script: 'throw new Error("boom");' }, mkCtx());
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.ok).toBe(false);
    expect(captureRecipeMock).not.toHaveBeenCalled();
  });

  describe('capture eligibility for nested child failures', () => {
    const read = { effect: 'read', expose: { mcp: { name: 'dev:pg-query' } } };
    const write = { effect: 'write', expose: { mcp: { name: 'work_items:set_state' } } };

    it('allows a semantic read diagnostic while the script completed', () => {
      expect(
        isRecipeCaptureEligible(
          {
            ok: true,
            childFailures: [{ tool: 'dev:pg-query', kind: 'semantic' }],
          },
          [read, write],
        ),
      ).toBe(true);
    });

    it('rejects a semantic write failure, a thrown child, and an unknown reference', () => {
      expect(
        isRecipeCaptureEligible(
          { ok: true, childFailures: [{ tool: 'work_items:set_state', kind: 'semantic' }] },
          [read, write],
        ),
      ).toBe(false);
      expect(
        isRecipeCaptureEligible(
          { ok: false, childFailures: [{ tool: 'dev:pg-query', kind: 'uncertain' }] },
          [read, write],
        ),
      ).toBe(false);
      expect(
        isRecipeCaptureEligible(
          { ok: true, unknownRefs: ['nope.doStuff'], childFailures: [] },
          [read, write],
        ),
      ).toBe(false);
    });
  });

  it('stamps effective error metadata when the script fails', async () => {
    const tool = codeRun();
    const metadata = vi.fn();
    const ctx = { ...mkCtx(), metadata } as never;
    await tool.fn({ script: 'throw new Error("boom");' }, ctx);
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      effectiveStatus: 'error',
      childFailureCount: 1,
    }));
  });

  it('shapes console logs before serializing the code:run payload and keeps a small summary unchanged', async () => {
    const tool = codeRun();
    const res = await tool.fn(
      {
        script:
          'console.log("raw \\u001b[31mred\\u001b[0m bell \\u0007 newline\\nnext");\n' +
          'return { kept: true };',
      },
      mkCtx(),
    );
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.summary).toEqual({ kept: true });
    expect(payload.logs).toEqual(['raw red bell  newline next']);
    expect(payload.logsNotice).toMatchObject({
      rawCount: 1,
      shownCount: 1,
      sanitizedLines: 1,
      droppedAfterLimit: 0,
    });
  });
});

describe('code:run → nested summary shaping (EI-20981474230843769)', () => {
  it('keeps a small summary byte-identical', () => {
    const result = { summary: { markerCount: 1, lines: ['first', 'second'] } };
    expect(shapeCodeRunSummary(result)).toBe(result);
  });

  it('bounds nested strings and arrays while preserving scalar marker fields', async () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    if (!tool) throw new Error('code:run not registered');

    const res = await tool.fn(
      {
        script:
          'return {' +
          'markerCount: 1,' +
          'lineCount: 81,' +
          'returnedChars: 54822,' +
          'lines: Array.from({ length: 81 }, (_, i) => `line-${i} ${"x".repeat(900)}`)' +
          '};',
      },
      {
        log: () => {},
        workspaceId: 'ws-test',
        harnessSlug: 'alpha',
        role: 'su',
        isSuperuser: true,
        uiClientId: 'su-test',
      } as never,
    );
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);

    expect(payload.ok).toBe(true);
    expect(payload.summary).toMatchObject({ markerCount: 1, lineCount: 81, returnedChars: 54822 });
    expect(payload.summary.lines.length).toBeLessThan(81);
    expect(payload.summary.lines.every((line: string) => line.length <= 360)).toBe(true);
    expect(payload.summaryNotice).toMatchObject({
      truncated: true,
      originalChars: expect.any(Number),
      returnedChars: expect.any(Number),
      arraysTruncated: expect.any(Number),
      stringsTruncated: expect.any(Number),
    });
    expect(payload.summaryNotice.paths).toContain('summary.lines');
    expect(JSON.stringify(payload).length).toBeLessThan(6_000);
  });
});

describe('code:run → similarRecipes result shaping', () => {
  const authority = {
    version: 1 as const,
    revision: 'revision-1',
    context: { workspace: 'ws-test', fleet: 'fleet-test', harness: 'alpha' },
  };
  const recipe = (index: number) => ({
    id: `recipe-${index}`,
    title: `Recipe ${index} ${'x'.repeat(140)}`,
    description: 'a description that is intentionally not part of the compact result',
    runCount: index,
    toolsUsed: ['coord:send', 'work_items:get'],
    similarity: 0.9 - index / 100,
    authority,
    authorityRefs: { workspaces: [], fleets: [], plans: [], harnesses: [], items: [], resources: [] },
    runArgs: { id: `recipe-${index}`, authority },
  });

  it('keeps the exact runArgs while omitting duplicate advisory fields and capping the list', () => {
    const shaped = shapeCodeRunSimilarRecipes([recipe(1), recipe(2), recipe(3), recipe(4), recipe(5)]);

    expect(shaped.similarRecipes).toHaveLength(3);
    expect(shaped.similarRecipes[0]).toEqual({
      id: 'recipe-1',
      title: `Recipe 1 ${'x'.repeat(110)}…`,
      runCount: 1,
      similarity: 0.89,
      authorityRefs: { workspaces: [], fleets: [], plans: [], harnesses: [], items: [], resources: [] },
      runArgs: { id: 'recipe-1', authority },
    });
    expect(shaped.similarRecipes[0]).not.toHaveProperty('description');
    expect(shaped.similarRecipes[0]).not.toHaveProperty('toolsUsed');
    expect(shaped.similarRecipes[0]).not.toHaveProperty('authority');
    expect(shaped.similarRecipesTruncated).toEqual({
      shown: 3,
      truncatedByLimit: true,
      limit: 3,
      more: 'recipes:search { query, limit } for more matches; recipes:get { id } for a full recipe',
    });
  });

  it('uses the bounded shape in the agent-facing code:run payload', async () => {
    captureRecipeMock.mockResolvedValueOnce({
      row: {
        id: 'captured-recipe',
        title: 'Captured recipe',
        description: 'Captured during the test',
        script: 'return { delivered: true };',
        potSlug: 'alpha',
        authorRole: 'su',
        toolsUsed: [],
        runCount: 1,
        successCount: 1,
        lastRunAt: null,
        status: 'active',
        promotedTool: null,
        mergedInto: null,
        tags: [],
        hasEmbedding: false,
        createdBy: 'owner-x',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
      },
      similarRecipes: [recipe(1), recipe(2), recipe(3), recipe(4)],
    });
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    if (!tool) throw new Error('code:run not registered');

    const res = await tool.fn({ script: 'return { delivered: true };' }, {
      log: () => {},
      workspaceId: 'ws-test',
      harnessSlug: 'alpha',
      role: 'su',
      isSuperuser: true,
      uiClientId: 'su-test',
    } as never);
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);

    expect(payload.summary).toEqual({ delivered: true });
    expect(payload.similarRecipes).toHaveLength(3);
    expect(payload.similarRecipesTruncated).toMatchObject({ shown: 3, limit: 3 });
  });
});

/**
 * EI-9239: a `timeoutSec` above the ~55s papercusp-su MCP transport cap used to fly straight
 * through to `runToolOrchestration` unclamped — the transport would then hard-kill the whole
 * call with an opaque `request_timeout` before the tool's own graceful script_timeout could ever
 * fire (repro: `timeoutSec: 90` on a multi-call script). Fixed by clamping the effective
 * timeoutMs below the cap (mirrors capability:inspect's identical EI-6073 fix) — the schema still
 * ACCEPTS up to 120s (so a caller isn't rejected for asking), it's just honored only up to the
 * clamped ceiling. A fast script well under the ceiling must behave identically either way.
 */
describe('code:run → timeoutSec clamped below MCP transport cap (EI-9239)', () => {
  const codeRun = () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    if (!tool) throw new Error('code:run not registered');
    return tool;
  };
  const mkCtx = () =>
    ({
      log: () => {},
      workspaceId: 'ws-test',
      harnessSlug: 'alpha',
      role: 'su',
      isSuperuser: true,
      uiClientId: 'su-test',
    }) as never;

  it('accepts a timeoutSec above the foreground ceiling without a schema error, and still runs to completion', async () => {
    const tool = codeRun();
    const res = await tool.fn({ script: 'return 42;', timeoutSec: 90 }, mkCtx());
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.summary).toBe(42);
  });
});

/**
 * P-007 (agent-tooling-token-efficiency): a script that references an unknown tool fails the
 * parse-check AND gets the typed signatures handed back inline — so the agent fixes the name and
 * re-runs WITHOUT a separate code:tools discovery round-trip. Capture never fires on this path.
 */
describe('code:run → inline facade help on unknown refs (P-007)', () => {
  const codeRun = () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    if (!tool) throw new Error('code:run not registered');
    return tool;
  };
  const mkCtx = () =>
    ({ log: () => {}, workspaceId: 'ws-test', harnessSlug: 'alpha', role: 'su', isSuperuser: true, uiClientId: 'su-test' }) as never;

  beforeEach(() => captureRecipeMock.mockClear());

  it('returns facadeHelp + a BOUNDED closest-namespace suggestion (not the full index) when a referenced namespace does not exist', async () => {
    const tool = codeRun();
    const res = await tool.fn({ script: 'return await tools.nope.doStuff();' }, mkCtx());
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.unknownRefs).toContain('nope.doStuff');
    expect(payload.facadeHelp).toBeDefined();
    // the note tells the agent it never needed code:tools first
    expect(payload.facadeHelp.note).toContain('no code:tools pre-call required');
    expect(payload.facadeHelp.note).toContain('code:tools {}');
    // an unknown namespace ⇒ a SUGGESTION is included, capped well below the full facade
    // (EI-7677: the full index was ~15k tokens and blew a session to 157% context on one typo)
    expect(Array.isArray(payload.facadeHelp.namespaces)).toBe(true);
    expect(payload.facadeHelp.namespaces.length).toBeGreaterThan(0);
    expect(payload.facadeHelp.namespaces.length).toBeLessThanOrEqual(3);
    // sanity: the full allowed facade for this role is much larger than the 3-item suggestion —
    // proves this is a bounded suggestion, not the whole catalog
    const allNamespaceCount = new Set(
      listAllProjectedTools()
        .map((t) => t.expose?.mcp?.name)
        .filter((n): n is string => !!n && n.includes(':'))
        .map((n) => n.split(':')[0]),
    ).size;
    expect(allNamespaceCount).toBeGreaterThan(payload.facadeHelp.namespaces.length);
    // nothing captured on a failed run
    expect(captureRecipeMock).not.toHaveBeenCalled();
  });

  it.each([
    'workItems.notARealMethod',
    'work_items.notARealMethod',
    'work_items:notARealMethod',
  ])('returns typed signatures for an unknown member under the %s namespace spelling', (unknownRef) => {
    const tools = [
      {
        expose: { mcp: { name: 'work_items:list' } },
        description: 'List work items',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ] as never;
    const help = buildFacadeHelp([unknownRef], tools, new Set(['work_items:list']));

    expect(help.note).toContain('Typed signatures for the namespaces you referenced');
    expect(help.signatures).toContain('workItems: {');
    expect(help.namespaces).toBeUndefined();
  });
});

/**
 * WI-1377: on a REAL (non-dryRun) code:run the effect:write calls already executed, so the full
 * `plannedMutations` args-echo is pure waste that overflows the 100k result cap on a large batch.
 * shapeMutationEcho swaps it for a compact { count, byTool } summary on a committing run, while
 * keeping the full preview under dryRun.
 */
/**
 * WI-1411 (fleet-backlog-lessons-2026-07-01 — THE ANCHOR): `dispatch-binding.ts`'s
 * `realDispatch(ctx, deps)` reuses ONE fixed ctx for every inner call a code:run
 * script makes, so a batch never got the per-call EI-30 workspace hop / tx /
 * principal / ALS binding a DIRECT (non-batch) MCP dispatch of the same tool
 * receives from `_mcp-handler.ts` — the reported "pgQuery / fleet:assignments
 * return EMPTY inside a code:run batch" symptom for an unscoped superuser
 * passing a per-call `{ workspace: 'X' }`. `bindInnerDispatch` closes that gap;
 * these pin its three branches directly (no live DB — the tx/principal/ALS
 * calls are spied per the mocks above).
 */
describe('code:run → per-inner-call workspace/identity rebinding (WI-1411)', () => {
  const readTool = { effect: 'read', expose: { mcp: { name: 'fleet:assignments' } } } as never;
  const crossWorkspaceTool = {
    effect: 'read',
    crossWorkspace: true,
    expose: { mcp: { name: 'papercusp:list_workspaces' } },
  } as never;
  const echoNext = async (callCtx: unknown) => callCtx;

  beforeEach(() => {
    withWorkspaceMock.mockClear();
    synthesizeDispatchPrincipalMock.mockClear();
    runWithWorkspaceIfConcreteMock.mockClear();
  });

  it('fast path: a concrete-workspace (bee) ctx with no per-call override dispatches under the SAME binding — zero extra tx', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false, tx: 'OUTER_TX', principal: 'OUTER_PRINCIPAL' };
    const result = (await bindInnerDispatch(readTool, 'fleet:assignments', {}, outerCtx as never, echoNext)) as Record<
      string,
      unknown
    >;
    // The invariant is "no REBIND work" — the same tx/principal/workspace, and no
    // extra transaction or principal synthesis. It is deliberately NOT object
    // identity: EI-18719561823587590 makes every inner ctx a copy carrying
    // `transportCapExempt`, so an identity assertion here would pin the
    // allocation rather than the binding it stands for.
    expect(result.tx).toBe('OUTER_TX');
    expect(result.principal).toBe('OUTER_PRINCIPAL');
    expect(result.workspaceId).toBe('ws-bee');
    expect(withWorkspaceMock).not.toHaveBeenCalled();
    expect(synthesizeDispatchPrincipalMock).not.toHaveBeenCalled();
  });

  it('creates a per-inner transaction when code:run has opted out of its outer workspace tx', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false };
    const result = (await bindInnerDispatch(readTool, 'fleet:assignments', {}, outerCtx as never, echoNext)) as {
      workspaceId: string;
      tx: unknown;
      principal: unknown;
    };
    expect(withWorkspaceMock).toHaveBeenCalledWith('ws-bee', expect.any(Function));
    expect(runWithWorkspaceIfConcreteMock).toHaveBeenCalledWith('ws-bee', expect.any(Function));
    expect(result.workspaceId).toBe('ws-bee');
    expect(result.tx).toEqual({ __tx: 'ws-bee' });
    expect(result.principal).toMatchObject({ workspaceId: 'ws-bee' });
  });

  it('synthesizes a principal but does not retain tx for an inner skipWorkspaceTx tool', async () => {
    const childTool = {
      effect: 'read',
      skipWorkspaceTx: true,
      expose: { mcp: { name: 'capability:bash' } },
    };
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false };
    const result = (await bindInnerDispatch(
      childTool as never,
      'capability:bash',
      {},
      outerCtx as never,
      echoNext,
    )) as { workspaceId: string; tx?: unknown; principal: unknown };
    expect(result.workspaceId).toBe('ws-bee');
    expect(result.tx).toBeUndefined();
    expect(result.principal).toMatchObject({ workspaceId: 'ws-bee' });
  });

  it('EI-30 hop: an unscoped superuser ctx + a per-call { workspace } rebinds tx/principal/workspaceId to it', async () => {
    const outerCtx = { workspaceId: '*', role: 'su', isSuperuser: true };
    const result = (await bindInnerDispatch(
      readTool,
      'fleet:assignments',
      { workspace: 'ws-target' },
      outerCtx as never,
      echoNext,
    )) as { workspaceId: string; tx: unknown; principal: unknown };
    expect(withWorkspaceMock).toHaveBeenCalledWith('ws-target', expect.any(Function));
    expect(runWithWorkspaceIfConcreteMock).toHaveBeenCalledWith('ws-target', expect.any(Function));
    expect(result.workspaceId).toBe('ws-target'); // the empty-result bug: this used to stay '*'
    expect(result.tx).toEqual({ __tx: 'ws-target' });
    expect(synthesizeDispatchPrincipalMock).toHaveBeenCalledWith(
      { __tx: 'ws-target' },
      expect.objectContaining({ workspaceId: 'ws-target', role: 'su' }),
    );
  });

  it('an unscoped superuser ctx with NO per-call override stays unbound (documented EI-30 boundary, not this bug)', async () => {
    const outerCtx = { workspaceId: '*', role: 'su', isSuperuser: true };
    const result = (await bindInnerDispatch(readTool, 'fleet:assignments', {}, outerCtx as never, echoNext)) as {
      workspaceId: string;
    };
    expect(result.workspaceId).toBe('*'); // nothing to hop to — fast path, still unscoped
    expect(withWorkspaceMock).not.toHaveBeenCalled();
  });

  it('a crossWorkspace inner tool always gets the admin tx, regardless of role', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false };
    const result = (await bindInnerDispatch(
      crossWorkspaceTool,
      'papercusp:list_workspaces',
      {},
      outerCtx as never,
      echoNext,
    )) as { workspaceId: string; tx: unknown };
    expect(result.tx).toEqual({ __admin: true });
    expect(result.workspaceId).toBe('ws-bee');
    expect(withWorkspaceMock).not.toHaveBeenCalled(); // admin path bypasses the app-role tx
  });
});

/**
 * EI-18699443874201617: an inner call a code:run script makes used to silently
 * inherit the OUTER session's `ctx.contextTier` (e.g. a trimmed/standard MCP
 * session), so a large nested field on an intermediate result (rubrics:get's
 * `criteria[]`) got shaped/truncated by applyPayloadTier with no error signal —
 * indistinguishable from a genuinely small result to the script's own `.length` /
 * `.filter()` read. bindInnerDispatch now strips `contextTier` off every inner
 * call's ctx so it defaults to 'full' (a script can still opt into a narrower
 * tier for one call via that call's own `payloadTier` arg — resolved
 * independently downstream, unaffected by this ctx-level default).
 */
describe('code:run → inner calls default to full payload tier (EI-18699443874201617)', () => {
  const readTool = { effect: 'read', expose: { mcp: { name: 'fleet:assignments' } } } as never;
  const crossWorkspaceTool = {
    effect: 'read',
    crossWorkspace: true,
    expose: { mcp: { name: 'papercusp:list_workspaces' } },
  } as never;
  const echoNext = async (callCtx: unknown) => callCtx;

  beforeEach(() => {
    withWorkspaceMock.mockClear();
    synthesizeDispatchPrincipalMock.mockClear();
    runWithWorkspaceIfConcreteMock.mockClear();
  });

  it('fast path: strips a trimmed outer contextTier before dispatching the inner call', async () => {
    const outerCtx = {
      workspaceId: 'ws-bee',
      role: 'cup',
      isSuperuser: false,
      tx: 'OUTER_TX',
      principal: 'OUTER_PRINCIPAL',
      contextTier: 'trimmed',
    };
    const result = (await bindInnerDispatch(readTool, 'fleet:assignments', {}, outerCtx as never, echoNext)) as {
      contextTier?: string;
    };
    expect(result).not.toBe(outerCtx); // a new ctx object — the tier was overridden
    expect(result.contextTier).toBeUndefined();
  });

  it('fast path: a ctx with no contextTier at all still dispatches under the same binding (no needless rebind)', async () => {
    const outerCtx = {
      workspaceId: 'ws-bee',
      role: 'cup',
      isSuperuser: false,
      tx: 'OUTER_TX',
      principal: 'OUTER_PRINCIPAL',
    };
    const result = (await bindInnerDispatch(readTool, 'fleet:assignments', {}, outerCtx as never, echoNext)) as {
      workspaceId: string;
      contextTier?: string;
    };
    expect(result.workspaceId).toBe('ws-bee');
    expect(result.contextTier).toBeUndefined();
    expect(withWorkspaceMock).not.toHaveBeenCalled();
    expect(synthesizeDispatchPrincipalMock).not.toHaveBeenCalled();
  });

  it('EI-30 hop: strips contextTier on the rebound ctx too', async () => {
    const outerCtx = { workspaceId: '*', role: 'su', isSuperuser: true, contextTier: 'standard' };
    const result = (await bindInnerDispatch(
      readTool,
      'fleet:assignments',
      { workspace: 'ws-target' },
      outerCtx as never,
      echoNext,
    )) as { contextTier?: string; workspaceId: string };
    expect(result.workspaceId).toBe('ws-target');
    expect(result.contextTier).toBeUndefined();
  });

  it('crossWorkspace path: strips contextTier on the admin-tx ctx too', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false, contextTier: 'trimmed' };
    const result = (await bindInnerDispatch(
      crossWorkspaceTool,
      'papercusp:list_workspaces',
      {},
      outerCtx as never,
      echoNext,
    )) as { contextTier?: string };
    expect(result.contextTier).toBeUndefined();
  });
});

/**
 * EI-18719561823587590: clearing `contextTier` (the EI-18699443874201617 fix above)
 * only skips applyPayloadTier's STEP 1 tier shaping. Its STEP 2 HARD CEILING
 * force-shapes any result over PAYLOAD_TIER_HARD_CEILING_CHARS regardless of the
 * resolved tier, and its only exit is `explicitFullRequest`. So an inner result
 * that merely ran LARGE was still silently row-truncated, and a script's
 * `.filter()`/`.find()` over it searched a subset — a miss indistinguishable from
 * real absence (measured on facts:list: 40 rows in, 8 rows visible to the script,
 * the searched-for key among the 32 dropped). Because survival depends on ROW
 * SIZE, the same script was correct on small data and silently wrong on large.
 *
 * bindInnerDispatch now marks every inner ctx `transportCapExempt` — the inner
 * result never crosses the agent-facing transport (only the script's own returned
 * value does, and that is shaped by the OUTER code:run call).
 */
describe('code:run → inner calls are exempt from the transport hard ceiling (EI-18719561823587590)', () => {
  const readTool = { effect: 'read', expose: { mcp: { name: 'facts:list' } } } as never;
  const crossWorkspaceTool = {
    effect: 'read',
    crossWorkspace: true,
    expose: { mcp: { name: 'papercusp:list_workspaces' } },
  } as never;
  const echoNext = async (callCtx: unknown) => callCtx;

  it('fast path: marks the inner ctx transportCapExempt', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false, tx: 'OUTER_TX' };
    const result = (await bindInnerDispatch(readTool, 'facts:list', {}, outerCtx as never, echoNext)) as {
      transportCapExempt?: boolean;
    };
    expect(result.transportCapExempt).toBe(true);
  });

  it('EI-30 hop: marks the rebound ctx transportCapExempt too', async () => {
    const outerCtx = { workspaceId: '*', role: 'su', isSuperuser: true };
    const result = (await bindInnerDispatch(
      readTool,
      'facts:list',
      { workspace: 'ws-target' },
      outerCtx as never,
      echoNext,
    )) as { transportCapExempt?: boolean; workspaceId: string };
    expect(result.workspaceId).toBe('ws-target');
    expect(result.transportCapExempt).toBe(true);
  });

  it('crossWorkspace path: marks the admin-tx ctx transportCapExempt too', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false };
    const result = (await bindInnerDispatch(
      crossWorkspaceTool,
      'papercusp:list_workspaces',
      {},
      outerCtx as never,
      echoNext,
    )) as { transportCapExempt?: boolean };
    expect(result.transportCapExempt).toBe(true);
  });

  /**
   * The containment half, and the reason this is safe: the exemption must ride
   * ONLY the inner call. The OUTER code:run result DOES cross the transport, so
   * leaking the flag onto the caller's own ctx would uncap it — turning a
   * silent-truncation bug into an over-cap transport failure. Pinned because the
   * pre-fix code reused the outer ctx object verbatim on the fast path, where an
   * in-place mutation would have been the obvious (and wrong) way to set this.
   */
  it('never mutates the OUTER ctx — the caller-facing result stays capped', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'cup', isSuperuser: false, contextTier: 'trimmed' };
    await bindInnerDispatch(readTool, 'facts:list', {}, outerCtx as never, echoNext);
    expect((outerCtx as Record<string, unknown>).transportCapExempt).toBeUndefined();
    expect(outerCtx.contextTier).toBe('trimmed'); // the outer session's own tier is untouched
  });
});

describe('code:run → mutation echo shaping (WI-1377)', () => {
  const base = { ok: true as const, summary: { done: true }, logs: [] as string[] };

  it('summarizes plannedMutations on a committing run (no full-args echo, so a big batch fits the cap)', () => {
    const shaped = shapeMutationEcho({
      ...base,
      dryRun: false,
      plannedMutations: [
        { tool: 'work_items:set_priority', args: { id: 'WI-1', priority: 1 } },
        { tool: 'work_items:set_priority', args: { id: 'WI-2', priority: 2 } },
        { tool: 'plans:set-now', args: { slug: 's', state: 'x' } },
      ],
    }) as Record<string, unknown>;
    // the full args echo is GONE (it is what overflowed the result cap)
    expect(shaped.plannedMutations).toBeUndefined();
    // replaced by a compact, bounded summary
    expect(shaped.mutations).toEqual({
      count: 3,
      byTool: { 'work_items:set_priority': 2, 'plans:set-now': 1 },
      note: expect.stringContaining('dryRun:true'),
    });
    // the script's own return value + ok survive untouched
    expect(shaped.ok).toBe(true);
    expect(shaped.summary).toEqual({ done: true });
  });

  it('keeps the full plannedMutations echo under dryRun when the preview is still bounded', () => {
    const pm = [{ tool: 'plans:set-now', args: { slug: 's', state: 'x' } }];
    const shaped = shapeMutationEcho({ ...base, dryRun: true, plannedMutations: pm }) as Record<string, unknown>;
    expect(shaped.plannedMutations).toEqual(pm);
    expect(shaped.mutations).toBeUndefined();
  });

  it('summarizes a large dryRun preview so the plan stays reviewable instead of truncating', () => {
    const pm = Array.from({ length: 160 }, (_, i) => ({
      tool: i % 2 === 0 ? 'work_items:set_priority' : 'plans:set-now',
      args: {
        id: `WI-${i}`,
        priority: i,
        detail: 'x'.repeat(220),
      },
    }));
    const shaped = shapeMutationEcho({ ...base, dryRun: true, plannedMutations: pm }) as Record<string, unknown>;
    expect(shaped.plannedMutations).toBeUndefined();
    expect(shaped.mutations).toEqual({
      dryRunPreview: true,
      count: 160,
      byTool: { 'work_items:set_priority': 80, 'plans:set-now': 80 },
      sample: expect.arrayContaining([
        expect.objectContaining({ tool: 'work_items:set_priority' }),
        expect.objectContaining({ tool: 'plans:set-now' }),
      ]),
      sampleOmittedCount: expect.any(Number),
      note: expect.stringContaining('reviewable'),
    });
    expect((shaped.mutations as { sample: unknown[] }).sample.length).toBeLessThan(pm.length);
  });

  it('leaves a read-only (no-write) committing run unchanged (already tiny)', () => {
    const r = { ...base, dryRun: false, plannedMutations: [] as { tool: string; args: unknown }[] };
    const shaped = shapeMutationEcho(r);
    expect(shaped).toBe(r); // same reference — nothing to summarize
    expect((shaped as Record<string, unknown>).mutations).toBeUndefined();
  });

  // EI-7174: a script_timeout (or any other ok:false) does not undo write-effect calls the
  // script already dispatched — dispatch() invokes the real tool immediately, timeout or not.
  // A prominent top-level `warning` (not just the easy-to-miss mutations.note) stops an agent
  // from blindly retrying the whole script and double-writing.
  it('ok:false with mutations already dispatched (e.g. script_timeout) surfaces a prominent top-level warning', () => {
    const shaped = shapeMutationEcho({
      ok: false,
      error: 'script_timeout after 30000ms',
      logs: [],
      dryRun: false,
      plannedMutations: [
        { tool: 'work_items:claim', args: { id: 'WI-1' } },
        { tool: 'work_items:set_state', args: { id: 'WI-1', state: 'in_progress' } },
      ],
    }) as Record<string, unknown>;
    expect(shaped.ok).toBe(false);
    expect(shaped.error).toBe('script_timeout after 30000ms');
    expect(shaped.mutations).toMatchObject({ count: 2, byTool: { 'work_items:claim': 1, 'work_items:set_state': 1 } });
    expect(shaped.warning).toEqual(expect.stringContaining('2 write-effect call(s) already executed'));
    expect(shaped.warning).toEqual(expect.stringContaining('double-write'));
  });

  it('timeout accounting reports the exact settled prefix and never labels an in-flight write as landed', () => {
    const shaped = shapeMutationEcho({
      ok: false,
      error: 'script_timeout after 30000ms',
      logs: [],
      dryRun: false,
      plannedMutations: [
        { tool: 'coord:send', args: { to: ['agent-1'] } },
        { tool: 'coord:send', args: { to: ['agent-2'] } },
      ],
      writeAttempts: [
        { index: 0, tool: 'coord:send', disposition: 'settled' },
        { index: 1, tool: 'coord:send', disposition: 'in_flight' },
      ],
    }) as Record<string, unknown>;

    expect(shaped.mutations).toMatchObject({
      count: 1,
      byTool: { 'coord:send': 1 },
      attemptedCount: 2,
      settledPrefixCount: 1,
      inFlightCount: 1,
      dispositions: { settled: [0], in_flight: [1] },
    });
    expect(shaped.warning).toEqual(expect.stringContaining('1 write-effect call(s) already executed'));
    expect(shaped.warning).toEqual(expect.stringContaining('1 still IN FLIGHT'));
    expect(shaped.warning).toEqual(expect.stringContaining('may settle later'));
  });

  it('ok:false with NO mutations dispatched carries no warning (nothing to guard against)', () => {
    const shaped = shapeMutationEcho({
      ok: false,
      error: 'some thrown error',
      logs: [],
      dryRun: false,
      plannedMutations: [],
    }) as Record<string, unknown>;
    expect(shaped.warning).toBeUndefined();
  });

  it('ok:true (a normal successful run with mutations) carries no spurious warning', () => {
    const shaped = shapeMutationEcho({
      ...base,
      dryRun: false,
      plannedMutations: [{ tool: 'work_items:claim', args: { id: 'WI-1' } }],
    }) as Record<string, unknown>;
    expect(shaped.warning).toBeUndefined();
  });

  // EI-7784: `ok:true` alone is misleading when a write-effect call dispatched fine but reported
  // its OWN ok:false (EI-7669's okFalseMutations) — the top-level `partial` flag + the
  // okFalseWarning are the two structured/human-readable signals a caller must check alongside
  // `ok`, not instead of relying on `ok` meaning "nothing went wrong".
  it('ok:true with an okFalse mutation carries partial:true + a prominent okFalseWarning naming the tool', () => {
    const okFalseResult = { ok: false, error: 'completion_integrity_required' };
    const shaped = shapeMutationEcho({
      ...base,
      dryRun: false,
      partial: true,
      plannedMutations: [{ tool: 'work_items:set_state', args: { id: 'WI-1', state: 'resolved' } }],
      okFalseMutations: [{ tool: 'work_items:set_state', args: { id: 'WI-1', state: 'resolved' }, result: okFalseResult }],
    }) as Record<string, unknown>;
    expect(shaped.ok).toBe(true); // the script itself completed — this is exactly the misleading bit
    expect(shaped.partial).toBe(true);
    expect(shaped.okFalseWarning).toEqual(expect.stringContaining('work_items:set_state'));
    expect(shaped.okFalseWarning).toEqual(expect.stringContaining('did NOT take effect'));
    expect(shaped.okFalseMutations).toEqual([
      { tool: 'work_items:set_state', args: { id: 'WI-1', state: 'resolved' }, result: okFalseResult },
    ]);
  });

  it('a hand-built fixture predating okFalseMutations (field absent) never throws — defaults to no warning', () => {
    const shaped = shapeMutationEcho({
      ...base,
      dryRun: false,
      plannedMutations: [{ tool: 'work_items:claim', args: { id: 'WI-1' } }],
      // okFalseMutations deliberately omitted — pre-EI-7669 fixture shape.
    }) as Record<string, unknown>;
    expect(shaped.okFalseWarning).toBeUndefined();
    expect(shaped.okFalseMutations).toBeUndefined();
  });
});

// WI-7061: `ok:true` on the envelope means "the script executed", but every caller reads it as
// "the work succeeded". EI-7669/EI-7784 closed that for WRITE-effect calls (okFalseMutations +
// okFalseWarning). A READ-effect call that reports its own `ok:false` was left with NO naming
// signal at all, for two compounding reasons:
//
//   1. the warning is built ONLY from okFalseMutations, and orchestrate.ts populates that list
//      `if (tool.effect === 'write')` — so a failed read is never in it; and
//   2. shapeMutationEcho early-returns on `plannedMutations.length === 0`, so a script that made
//      NO writes at all never even reaches the warning block.
//
// Detection itself was already general — orchestrate.ts pushes EVERY semantically-failed child
// (read or write) into `childFailures` and sets `partial: true` off it. So the caller was handed
// `ok:true, partial:true` and a childFailures array, with nothing saying WHAT failed in prose.
// That is the actual gap, and it is narrower than "code:run has no nested-failure detection":
// the signal existed, the human-readable pointer to it did not.
describe('annotateChildFailureWarning — a failed READ-effect child call is named too (WI-7061)', () => {
  const base = { ok: true as const, summary: { done: true }, logs: [] as string[], dryRun: false };

  it('⭐ names a failed read-effect call even when the script made NO writes at all', () => {
    // The exact shape that used to slip through: zero plannedMutations (so the mutation-echo
    // path early-returns) and a read tool that resolved with its own ok:false.
    const annotated = annotateChildFailureWarning({
      ...base,
      partial: true,
      plannedMutations: [],
      okFalseMutations: [],
      childFailures: [
        { tool: 'work_items:get', kind: 'semantic', result: { ok: false, error: 'not_found' } },
      ],
    }) as Record<string, unknown>;

    expect(annotated.ok).toBe(true); // still true — the script did run. This is the misleading bit.
    expect(annotated.partial).toBe(true);
    expect(annotated.childFailureWarning).toEqual(expect.stringContaining('work_items:get'));
    expect(annotated.childFailureWarning).toEqual(expect.stringContaining('ok:false'));

    // THE GAP, pinned permanently rather than as a transient red: the mutation-echo path alone
    // cannot produce this warning for the same input — `plannedMutations.length === 0` makes it
    // return untouched. If someone later "simplifies" by folding the annotation back into
    // shapeMutationEcho, this assertion fails and says why.
    const echoOnly = shapeMutationEcho({
      ...base,
      partial: true,
      plannedMutations: [],
      okFalseMutations: [],
      childFailures: [
        { tool: 'work_items:get', kind: 'semantic', result: { ok: false, error: 'not_found' } },
      ],
    }) as Record<string, unknown>;
    expect(echoOnly.childFailureWarning).toBeUndefined();
    expect(echoOnly.okFalseWarning).toBeUndefined();
  });

  it('does NOT duplicate a write failure okFalseWarning already names', () => {
    // The negative control that keeps the two fields complementary rather than redundant: a
    // write failure is already covered in prose by okFalseWarning, so naming it again here
    // would just add noise to the result an agent has to read.
    const annotated = annotateChildFailureWarning({
      ...base,
      partial: true,
      plannedMutations: [{ tool: 'coord:send', args: { to: ['nobody'] } }],
      okFalseMutations: [
        { tool: 'coord:send', args: { to: ['nobody'] }, result: { ok: false, error: 'unknown_recipient' } },
      ],
      childFailures: [
        { tool: 'coord:send', kind: 'semantic', result: { ok: false, error: 'unknown_recipient' } },
      ],
    }) as Record<string, unknown>;

    expect(annotated.childFailureWarning).toBeUndefined();
  });

  it('names ONLY the read failures when a script mixed a failed read with a failed write', () => {
    const annotated = annotateChildFailureWarning({
      ...base,
      partial: true,
      plannedMutations: [{ tool: 'coord:send', args: { to: ['nobody'] } }],
      okFalseMutations: [
        { tool: 'coord:send', args: { to: ['nobody'] }, result: { ok: false, error: 'unknown_recipient' } },
      ],
      childFailures: [
        { tool: 'coord:send', kind: 'semantic', result: { ok: false, error: 'unknown_recipient' } },
        { tool: 'plans:get', kind: 'semantic', result: { ok: false, error: 'not_found' } },
      ],
    }) as Record<string, unknown>;

    expect(annotated.childFailureWarning).toEqual(expect.stringContaining('plans:get'));
    expect(annotated.childFailureWarning).not.toEqual(expect.stringContaining('coord:send'));
  });

  it('is a no-op on a clean run, and on a fixture with no childFailures field at all', () => {
    const clean = annotateChildFailureWarning({
      ...base,
      plannedMutations: [],
      childFailures: [],
    }) as Record<string, unknown>;
    expect(clean.childFailureWarning).toBeUndefined();

    // Defensive: hand-built/older fixtures omit childFailures entirely — must not throw.
    const legacy = annotateChildFailureWarning({
      ...base,
      plannedMutations: [],
    } as never) as Record<string, unknown>;
    expect(legacy.childFailureWarning).toBeUndefined();
  });

  it('does not fire for a THROWN child (rejected/uncertain) — those have their own warnings', () => {
    // buildFailureWarning already covers the throw path with double-write semantics; naming
    // them here too would contradict it (a rejected call provably wrote nothing).
    const annotated = annotateChildFailureWarning({
      ...base,
      ok: false as unknown as true,
      plannedMutations: [],
      childFailures: [
        { tool: 'work_items:claim', kind: 'rejected', error: 'bad args' },
        { tool: 'work_items:claim', kind: 'uncertain', error: 'timeout' },
      ],
    }) as Record<string, unknown>;
    expect(annotated.childFailureWarning).toBeUndefined();
  });
});

describe('code:run → log shaping (WI-3127)', () => {
  const base = { ok: true as const, summary: { done: true }, dryRun: false, plannedMutations: [] as unknown[] };

  it('strips terminal escapes/control characters while preserving the script summary', () => {
    const shaped = shapeCodeRunLogs({
      ...base,
      logs: ['start \u001b[31mred\u001b[0m \u0007 \nnext'],
    }) as Record<string, unknown>;
    expect(shaped.summary).toEqual({ done: true });
    expect(shaped.logs).toEqual(['start red   next']);
    expect(shaped.logsNotice).toMatchObject({
      rawCount: 1,
      shownCount: 1,
      sanitizedLines: 1,
      truncatedLines: 0,
      droppedAfterLimit: 0,
    });
  });

  it('collapses adjacent duplicate lines, truncates oversized lines, and caps the shown log list', () => {
    const logs = ['same', 'same', 'x'.repeat(1_010), ...Array.from({ length: 90 }, (_, i) => `unique-${i}`)];
    const shaped = shapeCodeRunLogs({
      ...base,
      logs,
    }) as unknown as { logs: string[]; logsNotice: Record<string, unknown> };
    expect(shaped.logs).toContain('[previous code:run log line repeated 1 more time]');
    expect(shaped.logs.some((line) => line.includes('[truncated 10 chars]'))).toBe(true);
    expect(shaped.logs.length).toBe(80);
    expect(shaped.logsNotice).toMatchObject({
      rawCount: 93,
      shownCount: 80,
      adjacentDuplicatesCollapsed: 1,
      truncatedLines: 1,
      droppedAfterLimit: 13,
    });
  });

  it('leaves already-small clean logs unchanged', () => {
    const r = { ...base, logs: ['one', 'two'] };
    expect(shapeCodeRunLogs(r)).toBe(r);
  });
});
