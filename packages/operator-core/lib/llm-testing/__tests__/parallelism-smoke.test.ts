/**
 * Parallelism smoke test — plan §9.3.
 *
 * Verifies two invariants the framework needs for `pnpm llm-test
 * --parallel <n>`:
 *
 *   1. Distinct uiClientIds produce non-overlapping telemetry. Two
 *      runners filtering `metadata_json @> '{"uiClientId": A}'` and
 *      `B` see disjoint rows.
 *
 *   2. The dispatcher-auto-fill threading is concurrency-safe — the
 *      auto-fill grabs from `ctx.uiClientId` per call, not a shared
 *      module-level slot, so parallel dispatches with different
 *      contexts don't cross-contaminate.
 *
 * The test runs the dispatcher directly against synthetic tools. It
 * does NOT need the dev server or a real PG — telemetry rows are
 * captured via a stub `recordInvocation` hook. That's narrower than
 * the plan's "4 parallel runs against operator-converse" check, but
 * it isolates the concurrency invariant from network flake.
 *
 * A full "4 parallel runs through real operator-converse" smoke
 * belongs in the e2e suite (out of scope for unit tests). This is the
 * unit-level guard.
 */

import { describe, expect, it } from 'vitest';

import { dispatchProjectedTool } from '@papercusp/agent-mcp';
import type { ProjectedTool, UnifiedToolContext } from '@papercusp/agent-mcp';

function makeTool(name: string): ProjectedTool {
  return {
    pluginName: 'fixture',
    description: 'parallel smoke fixture',
    inputSchema: { type: 'object' },
    capabilities: [],
    expose: { mcp: { name } },
    fn: async () => {
      // Yield to the scheduler so concurrent dispatches actually
      // interleave on the event loop.
      await new Promise((r) => setImmediate(r));
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

function makeCtx(uiClientId: string): UnifiedToolContext {
  return {
    log: () => {},
    signal: new AbortController().signal,
    progress: () => {},
    emit: () => {},
    metadata: () => {},
    workspaceId: 'ws-fixture',
    role: 'operator',
    runId: `run_${uiClientId}`,
    spawnId: `spw_${uiClientId}`,
    parentSpawnId: null,
    transport: 'in_process',
    uiClientId,
  };
}

describe('parallelism smoke (plan §9.3)', () => {
  it('distinct uiClientIds tag recorded invocations independently', async () => {
    const tool = makeTool('parallel.tag');
    const recorded: Array<{ uiClientId: unknown; spawn: string }> = [];

    const deps = {
      recordInvocation: async (input: { metadataJson: Record<string, unknown> | null; ctx: UnifiedToolContext }) => {
        recorded.push({
          uiClientId: input.metadataJson?.uiClientId,
          spawn: input.ctx.spawnId,
        });
      },
    };

    const ids = ['llm-testing/A', 'llm-testing/B', 'llm-testing/C', 'llm-testing/D'];
    await Promise.all(
      ids.map((id) =>
        dispatchProjectedTool(tool, 'parallel.tag', {}, makeCtx(id), deps),
      ),
    );

    expect(recorded).toHaveLength(4);
    const tagged = new Set(recorded.map((r) => r.uiClientId));
    expect(tagged).toEqual(new Set(ids));
  });

  it('concurrent dispatches do not cross-contaminate ctx.uiClientId', async () => {
    const tool = makeTool('parallel.crosscheck');
    const checked: Array<{ wantId: string; sawId: unknown }> = [];

    const deps = {
      recordInvocation: async (input: { metadataJson: Record<string, unknown> | null; ctx: UnifiedToolContext }) => {
        checked.push({
          wantId: input.ctx.uiClientId ?? '',
          sawId: input.metadataJson?.uiClientId,
        });
      },
    };

    // Higher fan-out to make any shared-state bug visible.
    const N = 20;
    const ids = Array.from({ length: N }, (_, i) => `llm-testing/parallel-${i}`);
    await Promise.all(
      ids.map((id) =>
        dispatchProjectedTool(tool, 'parallel.crosscheck', {}, makeCtx(id), deps),
      ),
    );

    expect(checked).toHaveLength(N);
    for (const row of checked) {
      expect(row.sawId).toBe(row.wantId);
    }
  });
});
