import { describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ToolResult } from '@papercusp/tooldef';
import { deriveLegacyForegroundManifest } from '../../recipe-contract';
import { inspectOrchestration } from './inspect';
import type { SavedRecipeAdapter } from './saved-recipe-adapter';
import * as durableWorkflow from '../../dbos/durable-orchestration-workflow';
import * as sensitiveText from '../../sensitive-text';

function payload(result: ToolResult): Record<string, unknown> {
  const data = (result as ToolResult & { data?: unknown }).data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  const text = result.content.find((item) => item.type === 'text');
  if (!text || !('text' in text)) throw new Error('missing text result');
  return JSON.parse(text.text) as Record<string, unknown>;
}

const manifest = deriveLegacyForegroundManifest(['coord:presence']);
const bindingSchema = {
  version: 1 as const,
  properties: {
    fleet: {
      type: 'string' as const,
      required: true,
      lifetime: { kind: 'stable' as const },
    },
  },
  additionalProperties: false as const,
};

const checked = {
  ok: true as const,
  staticToolNames: ['coord:presence'],
  staticCalls: [{ ref: 'coord.presence' }],
  manifest,
  bindingSchema,
  contract: {
    manifest,
    bindingSchema,
    bindings: {
      inputs: { fleet: 'orch-unify' },
      secretRefs: {},
      resourceRefs: {},
      replayClass: 'read-only' as const,
      portability: 'portable' as const,
    },
    requirements: manifest.requirements.map(({ capability }) => capability),
    replay: {
      asserted: 'non-replayable' as const,
      derived: 'read-only' as const,
      effective: 'non-replayable' as const,
      downgraded: false,
    },
    portability: 'topology-bound' as const,
  },
};

describe('orchestrate:inspect', () => {
  it('rejects both and neither source before touching recipe or execution adapters', async () => {
    const inspect = vi.fn();
    const inspectScript = vi.fn();
    const deps = {
      recipes: { inspect } as unknown as SavedRecipeAdapter,
      inspectScript,
    };

    const both = await inspectOrchestration(
      { script: { source: 'return 1;' }, recipe: { id: 'also' } },
      {} as UnifiedToolContext,
      deps,
    );
    const neither = await inspectOrchestration({}, {} as UnifiedToolContext, deps);

    expect(inspect).not.toHaveBeenCalled();
    expect(inspectScript).not.toHaveBeenCalled();
    expect(payload(both)).toMatchObject({
      ok: false,
      phase: 'preflight',
      executed: false,
      error: { code: 'ambiguous_source' },
    });
    expect(payload(neither)).toMatchObject({ error: { code: 'source_missing' } });
  });

  it('resolves a saved recipe, repeats current preflight, and returns its exact continuation', async () => {
    const authority = {
      version: 1,
      revision: 'a'.repeat(64),
      refs: { workspaces: [], fleets: [], plans: [], harnesses: [], items: [], resources: [] },
      requiresContext: false,
      runnable: true,
    };
    const inspect = vi.fn().mockResolvedValue({
      ok: true,
      recipe: {
        id: 'fleet-presence',
        title: 'Fleet presence',
        description: 'Read current fleet presence',
        script: 'return tools.coord.presence({ fleet: inputs.fleet });',
        bindingSchema,
        capabilityManifest: manifest,
      },
      continuation: { id: 'fleet-presence', revision: 'a'.repeat(64), authority },
    });
    const inspectScript = vi.fn().mockResolvedValue(checked);

    const result = await inspectOrchestration(
      {
        recipe: { id: 'fleet-presence', revision: 'a'.repeat(64), authority },
        bindings: { values: { fleet: 'orch-unify' } },
        execution: { mode: 'auto' },
      },
      {} as UnifiedToolContext,
      {
        recipes: { inspect } as unknown as SavedRecipeAdapter,
        inspectScript,
      },
    );

    expect(inspect).toHaveBeenCalledWith({
      id: 'fleet-presence',
      revision: 'a'.repeat(64),
      authority,
    });
    expect(inspectScript).toHaveBeenCalledWith(expect.objectContaining({
      bindings: { values: { fleet: 'orch-unify' } },
      manifest,
    }));
    expect(payload(result)).toMatchObject({
      ok: true,
      source: {
        kind: 'recipe',
        continuation: {
          recipe: { id: 'fleet-presence', revision: 'a'.repeat(64), authority },
        },
      },
      normalized: {
        bindings: { values: { fleet: 'orch-unify' }, secretRefs: [], resourceRefs: {} },
        toolsUsed: ['coord:presence'],
        execution: { requestedMode: 'auto', mode: 'server', deprecatedAuto: true },
        capture: { mode: 'reuse' },
      },
      diagnostics: [{ code: 'execution_mode_deprecated' }],
    });
  });

  it('returns a missing-recipe diagnostic without running script preflight', async () => {
    const inspectScript = vi.fn();
    const result = await inspectOrchestration(
      { recipe: { id: 'gone' } },
      {} as UnifiedToolContext,
      {
        recipes: {
          inspect: vi.fn().mockResolvedValue({
            ok: false,
            phase: 'preflight',
            executed: false,
            error: { code: 'recipe_not_found', message: 'gone', path: 'recipe.id' },
          }),
        } as unknown as SavedRecipeAdapter,
        inspectScript,
      },
    );

    expect(inspectScript).not.toHaveBeenCalled();
    expect(payload(result)).toMatchObject({
      ok: false,
      phase: 'preflight',
      executed: false,
      error: { code: 'recipe_not_found', path: 'recipe.id' },
    });
  });

  it('reports pinned read steps separately from uncertain writes and foreground lifecycle', async () => {
    const readTool = {
      expose: { mcp: { name: 'coord:presence' } }, effect: 'read',
    };
    const writeTool = {
      expose: { mcp: { name: 'mail:send' } }, effect: 'write', idempotent: false,
    };
    const inspected = {
      ...checked,
      staticCalls: [
        { tool: 'coord:presence', args: { fleet: 'orch-unify' }, dynamicArgs: false },
        { tool: 'mail:send', args: { body: 'hello' }, dynamicArgs: false },
      ],
    };
    const result = await inspectOrchestration(
      { script: { source: 'await tools.coord.presence({ fleet: "orch-unify" }); await tools.mail.send({ body: "hello" });' } },
      {} as UnifiedToolContext,
      {
        inspectScript: vi.fn().mockResolvedValue(inspected),
        projectedTools: [readTool, writeTool] as never,
      },
    );
    expect(payload(result)).toMatchObject({
      ok: true,
      normalized: {
        execution: { lifecycle: 'foreground' },
        durability: {
          replayCandidate: false,
          durableExecutionAvailable: true,
          steps: [
            { tool: 'coord:presence', effect: 'read', replay: 'read-only' },
            { tool: 'mail:send', effect: 'write', replay: 'uncertain' },
          ],
          diagnostics: [{ code: 'uncertain-effect' }],
        },
      },
    });
  });

  it('inspects an explicit durable background script and returns its admission pin', async () => {
    const result = await inspectOrchestration(
      {
        script: { source: 'return await tools.runtime.now({});' },
        execution: { lifecycle: 'background', durability: 'durable' },
        timeoutSec: 120,
      },
      { workspaceId: 'ws-durable', role: 'su' } as UnifiedToolContext,
    );

    expect(payload(result)).toMatchObject({
      ok: true,
      normalized: {
        execution: {
          lifecycle: 'background',
          durability: 'durable',
          timeoutSec: 120,
        },
        durability: {
          pin: { sourceSha256: expect.any(String), bindingsSha256: expect.any(String) },
          durableExecutionAvailable: true,
          steps: [{ tool: 'runtime:now', replay: 'read-only' }],
        },
      },
    });
  });

  it('reads durable DBOS status only inside the current workspace', async () => {
    const workflowId = 'orchestrate-durable:ws-durable:run-1';
    const durableStatus = vi.fn().mockResolvedValue({
      workflowId,
      runKey: 'run-1',
      caller: { ownerId: 'original-owner', workspaceId: 'ws-durable', role: 'operator' },
      status: 'SUCCESS',
      outcome: { status: 'succeeded', summary: 'done', steps: [] },
      steps: [],
    });
    const ctx = { workspaceId: 'ws-durable', uiClientId: 'original-owner', role: 'operator' } as UnifiedToolContext;

    const result = await inspectOrchestration(
      { durableRun: { workflowId } },
      ctx,
      { durableStatus },
    );
    expect(durableStatus).toHaveBeenCalledWith(workflowId);
    expect(payload(result)).toMatchObject({
      ok: true,
      durableRun: { workflowId, status: 'SUCCESS', outcome: { status: 'succeeded' } },
    });

    durableStatus.mockClear();
    const denied = await inspectOrchestration(
      { durableRun: { workflowId: 'orchestrate-durable:other-workspace:run-1' } },
      ctx,
      { durableStatus },
    );
    expect(durableStatus).not.toHaveBeenCalled();
    expect(payload(denied)).toMatchObject({ error: { code: 'capability_denied' } });
  });
});

describe('durable inspection original audience and redaction', () => {
  function fixture() {
    const ctx: UnifiedToolContext = {
      workspaceId: 'ws-inspection', harnessSlug: 'original-harness', uiClientId: 'original-owner', role: 'operator',
      signal: new AbortController().signal, log: () => {}, progress: () => {}, emit: () => {},
      principal: { slug: 'original-principal', kind: 'system', workspaceId: 'ws-inspection',
        authMethod: 'process-internal', trust: 'trusted', capabilities: new Set(['recipes:read']) },
    };
    const row: durableWorkflow.DurableOrchestrationStatus = {
      workflowId: 'orchestrate-durable:ws-inspection:original-run', runKey: 'original-run',
      caller: { ownerId: ctx.uiClientId!, workspaceId: ctx.workspaceId!, harnessSlug: ctx.harnessSlug,
        role: ctx.role!, principal: { slug: ctx.principal!.slug, kind: ctx.principal!.kind,
          workspaceId: ctx.principal!.workspaceId } },
      status: 'SUCCESS', steps: [], outcome: { status: 'succeeded', summary: 'protected-original-result', steps: [] },
    };
    const durableStatus = vi.fn(async () => row);
    const read = (caller = ctx) => inspectOrchestration({ durableRun: { workflowId: row.workflowId } },
      caller, { durableStatus });
    return { ctx, row, read, durableStatus };
  }

  it.each(['owner', 'role', 'harness', 'missing-harness', 'principal', 'missing-principal',
    'principal-kind', 'principal-workspace'] as const)('refuses a foreign %s without disclosing result bytes', async edge => {
    const { ctx, row, read } = fixture();
    expect(payload(await read())).toMatchObject({ ok: true, durableRun: { workflowId: row.workflowId } });
    const caller = { ...ctx, principal: { ...ctx.principal! } };
    if (edge === 'owner') caller.uiClientId = 'foreign-owner';
    if (edge === 'role') caller.role = 'worker';
    if (edge === 'harness') caller.harnessSlug = 'foreign-harness';
    if (edge === 'missing-harness') delete caller.harnessSlug;
    if (edge === 'principal') caller.principal.slug = 'foreign-principal';
    if (edge === 'missing-principal') delete (caller as Partial<UnifiedToolContext>).principal;
    if (edge === 'principal-kind') caller.principal.kind = 'user';
    if (edge === 'principal-workspace') caller.principal.workspaceId = 'foreign-workspace';
    const denied = await read(caller);
    expect(payload(denied)).toMatchObject({ ok: false, error: { code: 'durable_run_not_found' } });
    expect(JSON.stringify(denied)).not.toContain('protected-original-result');
    expect(payload(await read())).toMatchObject({ ok: true });
  });

  it('detects only the audience-gate bypass and repairs the same read without executing work', async () => {
    const { ctx, row, read, durableStatus } = fixture();
    const before = structuredClone(row);
    expect(payload(await read())).toMatchObject({ ok: true });
    const foreign = { ...ctx, uiClientId: 'foreign-owner' };
    const protectedRead = async () => {
      const result = await read(foreign);
      expect(JSON.stringify(result)).not.toContain('protected-original-result');
      expect(payload(result)).toMatchObject({ ok: false });
    };
    await protectedRead();
    const bypass = vi.spyOn(durableWorkflow, 'durableOrchestrationStatusOwnedBy').mockReturnValue(true);
    try { await expect(protectedRead()).rejects.toThrow(); }
    finally { bypass.mockRestore(); }
    await protectedRead();
    expect(row).toEqual(before);
    expect(durableStatus.mock.calls).toHaveLength(4);
  });

  it('redacts result and error at the consumer and detects only the redaction bypass', async () => {
    // Low-entropy, role-named stand-in (the in-tree NEVER_EMIT_MARKER convention), never a
    // credential-shaped literal. Keep it >= 16 chars: sensitiveEnvironmentValues() only scrubs
    // environment values at least that long, so a shorter marker would silently skip redaction.
    const NEVER_EMIT_MARKER = 'never-emit-me-never-emit-me';
    vi.stubEnv('P003_INSPECTION_SECRET', NEVER_EMIT_MARKER);
    try {
      const { row, read } = fixture();
      row.error = 'child failed with ' + NEVER_EMIT_MARKER;
      row.outcome = { status: 'succeeded', summary: { text: NEVER_EMIT_MARKER, accessToken: 'private-key-value',
        credentialRef: 'credential:original', detail: 'x'.repeat(2001) + ':decisive-tail' }, steps: [] };
      const before = structuredClone(row);
      const protectedRead = async () => {
        const result = await read(); const bytes = JSON.stringify(result);
        expect(payload(result)).toMatchObject({ ok: true });
        expect(bytes).not.toContain(NEVER_EMIT_MARKER);
        expect(bytes).not.toContain('private-key-value');
        expect(bytes).toContain('credential:original');
        expect(bytes).toContain('x'.repeat(2001) + ':decisive-tail');
      };
      await protectedRead();
      const bypass = vi.spyOn(sensitiveText, 'redactStructuredSensitiveValue').mockImplementation(value => value);
      try { await expect(protectedRead()).rejects.toThrow(); }
      finally { bypass.mockRestore(); }
      await protectedRead();
      expect(row).toEqual(before);
    } finally { vi.unstubAllEnvs(); }
  });
});
