import { describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ToolResult } from '@papercusp/tooldef';
import { searchOrchestrations } from './search';
import type { SavedRecipeAdapter } from './saved-recipe-adapter';

function payload(result: ToolResult): Record<string, unknown> {
  const text = result.content.find((item) => item.type === 'text');
  if (!text || !('text' in text)) throw new Error('missing text result');
  return JSON.parse(text.text) as Record<string, unknown>;
}

describe('orchestrate:search', () => {
  it('delegates to the canonical search rail and preserves an exact runnable continuation', async () => {
    const authority = {
      version: 1,
      revision: 'a'.repeat(64),
      context: { harness: 'papercusp' },
    };
    const bindingSchema = {
      version: 1,
      properties: {
        ageDays: { type: 'integer', required: true, lifetime: { kind: 'stable' } },
      },
      additionalProperties: false,
    };
    const search = vi.fn().mockResolvedValue({
      ok: true,
      query: 'triage stale work',
      recipes: [{
        id: 'triage-stale',
        title: 'Triage stale work',
        description: 'Find and classify old queue entries',
        similarity: 0.91,
        toolsUsed: ['work_items:list'],
        bindingSchema,
        capabilityManifest: {
          requirements: [{ capability: 'tools:work_items:list' }],
        },
        runArgs: { id: 'triage-stale', authority },
      }],
    });

    const result = await searchOrchestrations(
      {
        query: 'triage stale work',
        limit: 3,
        context: { harness: 'papercusp', items: ['P-016'] },
      },
      {} as UnifiedToolContext,
      { search } as unknown as SavedRecipeAdapter,
    );

    expect(search).toHaveBeenCalledWith({
      query: 'triage stale work',
      limit: 3,
      context: { harness: 'papercusp', items: ['P-016'] },
    });
    expect(payload(result)).toEqual({
      ok: true,
      query: 'triage stale work',
      matches: [{
        id: 'triage-stale',
        title: 'Triage stale work',
        description: 'Find and classify old queue entries',
        score: 0.91,
        toolsUsed: ['work_items:list'],
        requirements: [{ capability: 'tools:work_items:list' }],
        bindings: bindingSchema,
        run: {
          recipe: {
            id: 'triage-stale',
            revision: 'a'.repeat(64),
            authority,
          },
        },
      }],
    });
  });

  it('rejects a malformed canonical search envelope instead of inventing matches', async () => {
    const adapter = {
      search: vi.fn().mockResolvedValue({ ok: true, results: [] }),
    } as unknown as SavedRecipeAdapter;
    await expect(
      searchOrchestrations({ query: 'anything' }, {} as UnifiedToolContext, adapter),
    ).rejects.toThrow('recipes:search returned an invalid envelope');
  });
});
