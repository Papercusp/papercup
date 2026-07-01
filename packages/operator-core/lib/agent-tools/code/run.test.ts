import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listAllProjectedTools } from '@papercusp/agent-mcp';

// ── Mocks for the CAPTURE wiring (code-recipes-2026-06-21 P-003) ─────────────
// maybeCaptureRecipe lazy-imports these; replace them so no PG / embedder /
// registry is touched and we can assert captureRecipe was invoked on success.
const { captureRecipeMock } = vi.hoisted(() => ({
  captureRecipeMock: vi.fn(async () => null),
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
}));
vi.mock('../../hive-federation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hiveHomeSlugForHarness: async () => 'alpha',
}));
vi.mock('../coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveAgentIdentity: () => ({ ownerId: 'owner-x' }),
}));

import { shapeMutationEcho, bindInnerDispatch } from './run'; // named import ALSO runs the side-effect: registers code:run (AFTER the mocks are hoisted)

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
    expect((tool?.agentRoles?.length ?? 0)).toBeGreaterThan(0);
    // All-roles widening: roles excluded under the old [...SU_ROLES,'bee'] gate now qualify.
    for (const role of ['worker', 'bee', 'sentinel', 'overwatch', 'reviewer']) {
      expect(tool?.agentRoles).toContain(role);
    }
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

  it('returns facadeHelp + the namespace index when a referenced namespace does not exist', async () => {
    const tool = codeRun();
    const res = await tool.fn({ script: 'return await tools.nope.doStuff();' }, mkCtx());
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.unknownRefs).toContain('nope.doStuff');
    expect(payload.facadeHelp).toBeDefined();
    // the note tells the agent it never needed code:tools first
    expect(payload.facadeHelp.note).toContain('no code:tools pre-call required');
    // an unknown namespace ⇒ the cheap index is included so the agent can find the right one
    expect(Array.isArray(payload.facadeHelp.namespaces)).toBe(true);
    // nothing captured on a failed run
    expect(captureRecipeMock).not.toHaveBeenCalled();
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

  it('fast path: a concrete-workspace (bee) ctx with no per-call override dispatches under the SAME ctx — zero extra tx', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'bee', isSuperuser: false, tx: 'OUTER_TX', principal: 'OUTER_PRINCIPAL' };
    const result = await bindInnerDispatch(readTool, 'fleet:assignments', {}, outerCtx as never, echoNext);
    expect(result).toBe(outerCtx); // reused verbatim — no rebind
    expect(withWorkspaceMock).not.toHaveBeenCalled();
    expect(synthesizeDispatchPrincipalMock).not.toHaveBeenCalled();
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
    const result = await bindInnerDispatch(readTool, 'fleet:assignments', {}, outerCtx as never, echoNext);
    expect(result).toBe(outerCtx); // nothing to hop to — fast path
    expect(withWorkspaceMock).not.toHaveBeenCalled();
  });

  it('a crossWorkspace inner tool always gets the admin tx, regardless of role', async () => {
    const outerCtx = { workspaceId: 'ws-bee', role: 'bee', isSuperuser: false };
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

  it('keeps the full plannedMutations echo under dryRun (it IS the preview the agent inspects)', () => {
    const pm = [{ tool: 'plans:set-now', args: { slug: 's', state: 'x' } }];
    const shaped = shapeMutationEcho({ ...base, dryRun: true, plannedMutations: pm }) as Record<string, unknown>;
    expect(shaped.plannedMutations).toEqual(pm);
    expect(shaped.mutations).toBeUndefined();
  });

  it('leaves a read-only (no-write) committing run unchanged (already tiny)', () => {
    const r = { ...base, dryRun: false, plannedMutations: [] as { tool: string; args: unknown }[] };
    const shaped = shapeMutationEcho(r);
    expect(shaped).toBe(r); // same reference — nothing to summarize
    expect((shaped as Record<string, unknown>).mutations).toBeUndefined();
  });
});
