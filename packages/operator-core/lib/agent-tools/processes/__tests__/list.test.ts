/**
 * processes:list — structured output preserves large inventories for ptool.
 *
 * The text projection is intentionally model-friendly JSON and may pass through
 * the result door. Programmatic callers need the typed object result instead, or
 * a 20-row inventory becomes an unparseable JSON prefix.
 */

import { describe, expect, it, vi } from 'vitest';
import { mockResolvedTyped } from '../../../testing/typed-mock';
import type { TaskRow } from '../../../task-manager/types';

vi.mock('../../../task-manager/enabled', () => ({
  isTaskManagerEnabled: vi.fn(async () => true),
}));

vi.mock('../../../task-manager/store', () => ({
  listTasks: vi.fn(async () => []),
}));

vi.mock('../../../task-manager/reconcile-tick', () => ({
  reconcileTick: vi.fn(),
}));

await import('../list');
const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
const projected = lookupByMcpName('processes:list')!;

function makeTx() {
  return vi.fn(async () => []);
}

describe('processes:list structured output', () => {
  it('accepts the singular state filter used by sibling task surfaces', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    vi.mocked(listTasks).mockClear();

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { state: 'running' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-singular-state-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(vi.mocked(listTasks)).toHaveBeenCalledWith(
      expect.objectContaining({ states: ['running'] }),
    );
  });

  it('advertises an object result and preserves a large task inventory', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    mockResolvedTyped(
      vi.mocked(listTasks),
      // Annotated `: TaskRow` rather than cast `as never`: the annotation gives each object
      // literal CONTEXTUAL typing (so `class` / `state` narrow to their real unions instead
      // of widening to string) AND makes a new required field on TaskRow a compile error
      // here — which the old cast silently swallowed.
      Array.from({ length: 25 }, (_, i): TaskRow => ({
        taskId: `task-${i}`,
        workspaceId: 'default',
        rootTaskId: `root-${i}`,
        class: 'bash-job',
        title: `task-${i}-${'x'.repeat(220)}`,
        argv: [],
        launchedBy: 'su-test',
        workItemId: null,
        planSlug: null,
        parentTaskId: null,
        confined: true,
        state: 'running' as const,
        startedAt: '2026-08-12T09:00:00.000Z',
        lastSeenAt: '2026-08-12T09:00:00.000Z',
        lastMemoryBytes: 1024,
        peakMemoryBytes: 2048,
        cpuUsec: 3_000_000,
        pidsCurrent: 1,
        scopeUnit: `pc-${i}.scope`,
        memoryMaxBytes: null,
        deadlineAt: null,
        exitCode: null,
        exitReason: null,
        logPath: null,
        detail: {},
      })),
    );

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { limit: 2000 },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(projected.outputJsonSchema?.type).toBe('object');
    expect(dispatched.result?.structuredContent).toMatchObject({
      ok: true,
      counts: { total: 25 },
    });
    const structured = dispatched.result?.structuredContent as { tasks: unknown[] };
    expect(structured.tasks).toHaveLength(25);
  });

  it('surfaces the validated scopeUnit for a live unaccounted group', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    const { reconcileTick } = await import('../../../task-manager/reconcile-tick');
    vi.mocked(listTasks).mockResolvedValueOnce([]);
    vi.mocked(reconcileTick).mockResolvedValueOnce({
      summary: { unaccounted: 1, unaccountedPids: 2 },
      result: {
        unaccounted: [
          {
            cgroupPath: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-orphan123.scope',
            scopeUnit: 'pc-orphan123.scope',
            pids: [11, 12],
            sampleCmdline: 'node orphan',
          },
        ],
        foreign: [],
      },
      scan: { processes: 2, foreignTruncated: false },
      degraded: false,
      touched: 0,
      strandedCount: 0,
      endedUnobservedCount: 0,
      unaccountedPersisted: 1,
      residueCleared: 0,
    } as never);

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { live: true, limit: 2000 },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-live-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const structured = dispatched.result?.structuredContent as {
      live: { unaccountedGroups: Array<{ scopeUnit: string; cgroupPath: string; pids: number[] }> };
    };
    expect(structured.live.unaccountedGroups[0]).toMatchObject({
      scopeUnit: 'pc-orphan123.scope',
      cgroupPath: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-orphan123.scope',
      pids: [11, 12],
    });
  });
});
