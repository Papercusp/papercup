import { describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ToolResult } from '@papercusp/tooldef';
import { deriveLegacyForegroundManifest } from '../../recipe-contract';
import { inspectOrchestration } from './inspect';
import type { SavedRecipeAdapter } from './saved-recipe-adapter';

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
          durableExecutionAvailable: false,
          steps: [
            { tool: 'coord:presence', effect: 'read', replay: 'read-only' },
            { tool: 'mail:send', effect: 'write', replay: 'uncertain' },
          ],
          diagnostics: [{ code: 'uncertain-effect' }],
        },
      },
    });
  });
});
