import { describe, it, expect } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { buildReactionCtx } from './dispatch-reaction';
import type { ReactionCause } from './types';

const parent = {
  workspaceId: 'w1',
  harnessSlug: 'h9',
  role: 'worker',
  featureId: 'F-1',
  chunkId: 'C-1',
  spawnId: 'sp-parent',
  uiClientId: 'agent-1',
} as unknown as UnifiedToolContext;

const cause: ReactionCause = { depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'root' };

describe('buildReactionCtx', () => {
  it('inherits the trigger scope + stamps reaction provenance', () => {
    const c = buildReactionCtx(parent, 'w1', cause);
    expect(c.workspaceId).toBe('w1');
    expect(c.harnessSlug).toBe('h9');
    expect(c.role).toBe('worker');
    expect(c.uiClientId).toBe('agent-1');
    expect(c.spawnId).toBe('event-reaction');
    expect(c.parentSpawnId).toBe('sp-parent');
    expect(c.transport).toBe('in_process');
    expect(c.reactionCause).toEqual(cause);
    expect(typeof c.runId).toBe('string');
  });

  it('first-party (no capability) runs with full system trust', () => {
    const c = buildReactionCtx(parent, 'w1', cause);
    expect(c.gateBypass).toEqual({ capability: true, quota: true, role: true });
    expect(c.principal?.slug).toBe('system:event-reaction');
    expect(c.principal?.capabilities.has('*')).toBe(true);
  });

  it('scoped (capability) sandboxes to that one capability (D-012)', () => {
    const c = buildReactionCtx(parent, 'w1', cause, 'plugin:foo:emit');
    // capability bypass is OFF → the capability gate enforces against the principal
    expect(c.gateBypass).toEqual({ quota: true, role: true });
    expect(c.principal?.capabilities.has('*')).toBe(false);
    expect(c.principal?.capabilities.has('plugin:foo:emit')).toBe(true);
    expect(c.principal?.slug).toContain('plugin:event-reaction:plugin:foo:emit');
  });

  it('falls back to operator role + wildcard harness when the parent lacks them', () => {
    const c = buildReactionCtx({} as UnifiedToolContext, 'w2', cause);
    expect(c.role).toBe('operator');
    expect(c.harnessSlug).toBe('*');
    expect(c.uiClientId).toBeNull();
  });
});
