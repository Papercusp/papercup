// @vitest-environment node
/** Current projected registry, parser and caller policy feed the same inspect door. */
import { describe, expect, it } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ToolResult } from '@papercusp/tooldef';
import { inspectOrchestration } from './inspect';
import '../plans/set-status';
import '../work_items/create';

const ctx = {
  role: 'operator', workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', isSuperuser: true,
} as UnifiedToolContext;
function data(result: ToolResult): Record<string, unknown> {
  return (result as ToolResult & { data: Record<string, unknown> }).data;
}

describe('orchestrate:inspect durability policy over current registry', () => {
  it('pins a real idempotent status write but keeps execution foreground', async () => {
    const result = data(await inspectOrchestration({
      script: { source: 'return await tools.plans.setStatus({ slug: "fixture", item: "P-001", status: "done" });' },
    }, ctx));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      normalized: {
        // P-019 made the DBOS-backed durable path AVAILABLE; inspection must
        // still default the lifecycle to foreground (durable is opt-in).
        execution: { lifecycle: 'foreground' },
        durability: {
          replayCandidate: true,
          durableExecutionAvailable: true,
          steps: [{ tool: 'plans:set-status', effect: 'write', replay: 'idempotent', argsStatic: true }],
        },
      },
    });
  });

  it('reports a registered non-idempotent write and random branch before any dispatch', async () => {
    const result = data(await inspectOrchestration({
      script: { source: 'if (Math.random() > 0.5) return await tools.workItems.create({ title: "x", kind: "feature" });' },
    }, ctx));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      normalized: {
        durability: {
          replayCandidate: false,
          steps: [{ tool: 'work_items:create', effect: 'write', replay: 'uncertain' }],
        },
      },
    });
    const codes = ((result.normalized as { durability: { diagnostics: Array<{ code: string }> } })
      .durability.diagnostics).map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(['random-control', 'uncheckpointed-control-flow', 'uncertain-effect']));
  });
});
