/**
 * Recurrence guard for the harness-scope band-aid family
 * (workspace-data-isolation-leaks-2026-06-17 P-004 / WI-373).
 *
 * Each of these tools used `args.x ?? ctx.harnessSlug ?? ''` guarded only by an
 * `if (!slug)` throw or a `truthy:` requires-precondition — which catches the
 * EMPTY string but NOT the operator/superuser `'*'` auto-default (set by
 * http-projection for every operator-scope call). So under operator scope they
 * silently read/wrote a nonexistent `'*'` bucket (empty results / no-op success)
 * instead of failing. They now route through the fail-loud
 * `resolveConcreteHarnessSlug` and return a `harness_required` error.
 *
 * The gate is the FIRST statement in each handler and short-circuits BEFORE any
 * data-lib call, so these tests need no DB / data mocks — a `'*'` (or unset) ctx
 * must produce the error envelope, full stop.
 */

import { describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  }) as never;

interface HandlerResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

function payloadOf(result: HandlerResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

/** Every tool that requires a single CONCRETE harness (operator `'*'` is rejected). */
const CONCRETE_HARNESS_TOOLS: Array<{
  name: string;
  importTool: () => Promise<{ default: { handler: (a: never, c: never) => Promise<unknown> } }>;
  args: Record<string, unknown>;
}> = [
  { name: 'harness:phase_path', importTool: () => import('../harness/phase_path'), args: { phase: 'staging' } },
  { name: 'autoloop:status', importTool: () => import('../autoloop/status'), args: {} },
  { name: 'autoloop:control', importTool: () => import('../autoloop/control'), args: { op: 'pause' } },
  { name: 'cross_harness:inbox', importTool: () => import('../cross_harness/inbox'), args: {} },
  { name: 'cross_harness:outbox', importTool: () => import('../cross_harness/outbox'), args: {} },
  { name: 'cross_harness:supervisor_notes', importTool: () => import('../cross_harness/supervisor_notes'), args: {} },
  { name: 'projects:list', importTool: () => import('../projects/list'), args: {} },
  { name: 'projects:get', importTool: () => import('../projects/get'), args: { id: 'P-1' } },
  { name: 'projects:spec_revision', importTool: () => import('../projects/spec_revision'), args: { projectId: 'P-1', revId: 1 } },
  { name: 'projects:spec_revisions', importTool: () => import('../projects/spec_revisions'), args: { projectId: 'P-1' } },
  { name: 'operator:notes', importTool: () => import('../operator/notes'), args: { op: 'read', featureId: 'F-1' } },
];

describe('harness-scope gate — operator "*" / no scope fails loud, never silently swallowed', () => {
  for (const tool of CONCRETE_HARNESS_TOOLS) {
    it(`${tool.name} returns harness_required for the operator '*' auto-default`, async () => {
      const { default: def } = await tool.importTool();
      const result = await def.handler(tool.args as never, MAKE_CTX({ harnessSlug: '*' }));
      expect(result.isError).toBe(true);
      expect(payloadOf(result).error).toBe('harness_required');
    });

    it(`${tool.name} returns harness_required when neither arg nor ctx carries a slug`, async () => {
      const { default: def } = await tool.importTool();
      const result = await def.handler(tool.args as never, MAKE_CTX({ harnessSlug: undefined }));
      expect(result.isError).toBe(true);
      expect(payloadOf(result).error).toBe('harness_required');
    });

    it(`${tool.name} returns harness_required for an explicit 'all' arg (cross-harness is not a single harness)`, async () => {
      const { default: def } = await tool.importTool();
      // The arg name differs per tool (harnessSlug | harness | slug); set all the
      // ones any of these tools read so 'all' is the effective scope everywhere.
      const result = await def.handler(
        { ...tool.args, harnessSlug: 'all', harness: 'all', slug: 'all' } as never,
        MAKE_CTX({ harnessSlug: '*' }),
      );
      expect(result.isError).toBe(true);
      expect(payloadOf(result).error).toBe('harness_required');
    });
  }
});
