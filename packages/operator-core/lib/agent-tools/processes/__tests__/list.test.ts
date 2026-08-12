/**
 * processes:list — structured output preserves large inventories for ptool.
 *
 * The text projection is intentionally model-friendly JSON and may pass through
 * the result door. Programmatic callers need the typed object result instead, or
 * a 20-row inventory becomes an unparseable JSON prefix.
 */

import { describe, expect, it, vi } from 'vitest';
import { mockResolvedTyped } from '../../../testing/typed-mock';

vi.mock('../../../task-manager/enabled', () => ({
  isTaskManagerEnabled: vi.fn(async () => true),
}));

vi.mock('../../../task-manager/store', () => ({
  listTasks: vi.fn(async () => []),
}));

await import('../list');
const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
const projected = lookupByMcpName('processes:list')!;

function makeTx() {
  return vi.fn(async () => []);
}

describe('processes:list structured output', () => {
  it('advertises an object result and preserves a large task inventory', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    mockResolvedTyped(
      vi.mocked(listTasks),
      Array.from({ length: 25 }, (_, i) => ({
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
});
