import { describe, it, expect } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { computeDedupId, serializeParent } from './reaction-id';
import type { DurableReactionInput } from './durable';
import type { ReactionRule, ToolInvocationEvent } from './types';

function input(over: Partial<DurableReactionInput> = {}): DurableReactionInput {
  const event: ToolInvocationEvent = {
    tool: 'coord:handoff',
    args: { item: 'WI-1' },
    result: { ok: true },
    ctx: { runId: 'run-9', workspaceId: 'w1' } as unknown as UnifiedToolContext,
  };
  const rule: ReactionRule = { id: 'r1', on: 'coord:handoff', fire: 'activity:report' };
  return {
    rule,
    fire: 'activity:report',
    args: {},
    event,
    cause: { depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'root-7' },
    ...over,
  };
}

describe('computeDedupId', () => {
  it('is deterministic over (rootRunId, ruleId)', () => {
    expect(computeDedupId(input())).toBe('reaction:root-7:r1');
    expect(computeDedupId(input())).toBe('reaction:root-7:r1');
  });

  it('falls back to the trigger runId when there is no rootRunId', () => {
    const i = input({ cause: { depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: null } });
    expect(computeDedupId(i)).toBe('reaction:run-9:r1');
  });

  it('appends a rule-supplied dedupKey', () => {
    const rule: ReactionRule = {
      id: 'r1',
      on: 'coord:handoff',
      fire: 'activity:report',
      dedupKey: (e) => String((e.args as { item: string }).item),
    };
    expect(computeDedupId(input({ rule }))).toBe('reaction:root-7:r1:WI-1');
  });
});

describe('serializeParent', () => {
  it('extracts only the JSON-serializable identity fields', () => {
    const ctx = {
      workspaceId: 'w1',
      harnessSlug: 'h1',
      role: 'worker',
      featureId: 'F-1',
      chunkId: 'C-1',
      spawnId: 'sp-1',
      uiClientId: 'agent-1',
      // non-serializable bits that must be dropped:
      log: () => {},
      emit: () => {},
      signal: new AbortController().signal,
    } as unknown as UnifiedToolContext;
    expect(serializeParent(ctx)).toEqual({
      workspaceId: 'w1',
      harnessSlug: 'h1',
      role: 'worker',
      featureId: 'F-1',
      chunkId: 'C-1',
      spawnId: 'sp-1',
      uiClientId: 'agent-1',
    });
  });

  it('falls back to principal.workspaceId when ctx.workspaceId is unset', () => {
    const ctx = { principal: { workspaceId: 'wp', slug: 's', capabilities: new Set() } } as unknown as UnifiedToolContext;
    expect(serializeParent(ctx).workspaceId).toBe('wp');
  });
});
