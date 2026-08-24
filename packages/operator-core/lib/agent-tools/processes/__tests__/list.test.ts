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

const { LOCAL_SUPERUSER_BEARER } = vi.hoisted(() => ({
  LOCAL_SUPERUSER_BEARER: '8c91f74d2e6a4bbf90f44a71d142d095',
}));

vi.mock('../../../task-manager/enabled', () => ({
  isTaskManagerEnabled: vi.fn(async () => true),
}));

vi.mock('../../../task-manager/store', () => ({
  listTasks: vi.fn(async () => []),
}));

vi.mock('../../../task-manager/reconcile-tick', () => ({
  reconcileTick: vi.fn(),
}));

vi.mock('../../../superuser-token', () => ({
  readSuperuserToken: () => LOCAL_SUPERUSER_BEARER,
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

  it('surfaces the durable systemd reason and killed scope identity for a completed task', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    const row: TaskRow = {
      taskId: 'oom-task',
      workspaceId: 'default',
      rootTaskId: 'oom-task',
      class: 'bash-job',
      title: 'oom-task',
      argv: [],
      launchedBy: 'su-test',
      confined: true,
      state: 'killed',
      startedAt: '2026-08-24T09:00:00.000Z',
      endedAt: '2026-08-24T09:01:00.000Z',
      lastSeenAt: '2026-08-24T09:01:00.000Z',
      scopeUnit: 'pc-oom-task.service',
      cgroupPath: '/user.slice/papercusp.slice/pc-oom-task.service',
      memoryMaxBytes: 32 * 1024 * 1024,
      peakMemoryBytes: 32 * 1024 * 1024,
      exitCode: 137,
      exitReason: 'oom-kill',
      terminalProvenance: {
        capturedAt: '2026-08-24T09:01:00.000Z',
        scopeUnit: 'pc-oom-task.service',
        cgroupPath: '/user.slice/papercusp.slice/pc-oom-task.service',
        invocationId: 'oom-invocation',
        loadState: 'loaded',
        activeState: 'failed',
        serviceResult: 'oom-kill',
        execMainCode: 2,
        execMainStatus: 9,
        memoryMaxBytes: 32 * 1024 * 1024,
        peakMemoryBytes: 32 * 1024 * 1024,
        peakMemorySource: 'systemd',
      },
      detail: {},
    };
    vi.mocked(listTasks).mockResolvedValueOnce([row]);

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { includeEnded: true },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-terminal-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(
      (dispatched.result?.structuredContent as { tasks: Array<Record<string, unknown>> }).tasks[0],
    ).toMatchObject({
      state: 'killed',
      exitCode: 137,
      exitReason: 'oom-kill',
      termination: {
        reason: 'oom-kill',
        serviceResult: 'oom-kill',
        scopeUnit: 'pc-oom-task.service',
        invocationId: 'oom-invocation',
        memoryMaxMb: 32,
        peakRssMb: 32,
        peakMemorySource: 'systemd',
      },
    });
  });

  it('derives current CPU busy percentage from successive cumulative samples', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    const row = (cpuUsec: number): TaskRow => ({
      taskId: 'cpu-rate-task',
      workspaceId: 'default',
      rootTaskId: 'cpu-rate-task',
      class: 'bash-job',
      title: 'cpu-rate-task',
      argv: [],
      launchedBy: 'su-test',
      workItemId: null,
      planSlug: null,
      parentTaskId: null,
      confined: true,
      state: 'running',
      startedAt: '2026-08-24T09:00:00.000Z',
      lastSeenAt: '2026-08-24T09:00:00.000Z',
      lastMemoryBytes: 1024,
      peakMemoryBytes: 2048,
      cpuUsec,
      pidsCurrent: 1,
      scopeUnit: 'pc-cpu-rate-task.scope',
      memoryMaxBytes: null,
      deadlineAt: null,
      exitCode: null,
      exitReason: null,
      logPath: null,
      detail: {},
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T09:01:00.000Z'));
      vi.mocked(listTasks).mockResolvedValueOnce([row(0)]);
      const first = await dispatchProjectedTool(
        projected,
        'processes:list',
        {},
        {
          log: vi.fn(),
          signal: new AbortController().signal,
          progress: vi.fn(),
          emit: vi.fn(),
          workspaceId: 'default',
          runId: 'processes-list-cpu-first',
          role: 'operator',
          gateBypass: { role: true, capability: true, quota: true },
          transport: 'mcp',
          requestedFormat: 'json',
          requestedStructured: true,
          tx: makeTx(),
        },
        {},
      );
      vi.setSystemTime(new Date('2026-08-24T09:01:01.000Z'));
      vi.mocked(listTasks).mockResolvedValueOnce([row(1_000_000)]);
      const second = await dispatchProjectedTool(
        projected,
        'processes:list',
        {},
        {
          log: vi.fn(),
          signal: new AbortController().signal,
          progress: vi.fn(),
          emit: vi.fn(),
          workspaceId: 'default',
          runId: 'processes-list-cpu-second',
          role: 'operator',
          gateBypass: { role: true, capability: true, quota: true },
          transport: 'mcp',
          requestedFormat: 'json',
          requestedStructured: true,
          tx: makeTx(),
        },
        {},
      );

      expect(first.ok, JSON.stringify(first)).toBe(true);
      expect(second.ok, JSON.stringify(second)).toBe(true);
      expect(
        (first.result?.structuredContent as { tasks: Array<Record<string, unknown>> }).tasks[0],
      ).toMatchObject({ cpuSec: 0, cpuBusyPercent: null });
      expect(
        (second.result?.structuredContent as { tasks: Array<Record<string, unknown>> }).tasks[0],
      ).toMatchObject({ cpuSec: 1, cpuBusyPercent: 100 });
    } finally {
      vi.useRealTimers();
    }
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
        verifierScope: [
          {
            cgroupPath:
              '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/' +
              'papercup-tauri-verify-90-3416089-tauri-1.scope',
            scopeUnit: 'papercup-tauri-verify-90-3416089-tauri-1.scope',
            pids: [21, 22],
            sampleCmdline: 'npm run tauri dev',
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
      live: {
        unaccountedGroups: Array<{ scopeUnit: string; cgroupPath: string; pids: number[] }>;
        verifierGroups: Array<{ scopeUnit: string; cgroupPath: string; pids: number[] }>;
      };
    };
    expect(structured.live.unaccountedGroups[0]).toMatchObject({
      scopeUnit: 'pc-orphan123.scope',
      cgroupPath: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-orphan123.scope',
      pids: [11, 12],
    });
    expect(structured.live.verifierGroups).toEqual([
      expect.objectContaining({
        scopeUnit: 'papercup-tauri-verify-90-3416089-tauri-1.scope',
        pids: [21, 22],
      }),
    ]);
  });

  it('redacts credential assignments in live groups and persisted task titles', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    const { reconcileTick } = await import('../../../task-manager/reconcile-tick');
    vi.mocked(listTasks).mockResolvedValueOnce([
      {
        taskId: 'task-redaction',
        workspaceId: 'default',
        rootTaskId: 'task-redaction',
        class: 'bash-job',
        title: 'DATABASE_URL=postgresql://user:opaque-password@localhost/app',
        argv: [],
        launchedBy: 'su-test',
        workItemId: null,
        planSlug: null,
        parentTaskId: null,
        confined: true,
        state: 'running',
        startedAt: '2026-08-23T09:00:00.000Z',
        lastSeenAt: '2026-08-23T09:00:00.000Z',
        lastMemoryBytes: null,
        peakMemoryBytes: null,
        cpuUsec: null,
        pidsCurrent: 1,
        scopeUnit: 'pc-task-redaction.scope',
        memoryMaxBytes: null,
        deadlineAt: null,
        exitCode: null,
        exitReason: null,
        logPath: null,
        detail: {},
      },
    ]);
    vi.mocked(reconcileTick).mockResolvedValueOnce({
      summary: { unaccounted: 1 },
      result: {
        unaccounted: [
          {
            cgroupPath: '/user.slice/papercusp.slice/pc-orphan-redaction.scope',
            scopeUnit: 'pc-orphan-redaction.scope',
            pids: [11],
            sampleCmdline:
              `python3 - http://127.0.0.1:9071 ${LOCAL_SUPERUSER_BEARER} ` +
              'AWS_ACCESS_KEY_ID=opaque-aws-access-key',
          },
        ],
        verifierScope: [],
        foreign: [],
      },
      scan: { processes: 1, foreignTruncated: false },
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
        runId: 'processes-list-redaction-test',
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
      live: { unaccountedGroups: Array<{ sample: string }> };
      tasks: Array<{ title: string }>;
    };
    expect(structured.live.unaccountedGroups[0]!.sample).toBe(
      'python3 - http://127.0.0.1:9071 [redacted] AWS_ACCESS_KEY_ID=[redacted]',
    );
    expect(structured.tasks[0]!.title).toBe('DATABASE_URL=[redacted]');
    expect(JSON.stringify(structured)).not.toContain('opaque-');
    expect(JSON.stringify(structured)).not.toContain(LOCAL_SUPERUSER_BEARER);
  });

  it('omits unrelated global groups from a filtered live task read', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    const { reconcileTick } = await import('../../../task-manager/reconcile-tick');
    vi.mocked(listTasks).mockResolvedValueOnce([]);
    vi.mocked(reconcileTick).mockResolvedValueOnce({
      summary: { unaccounted: 38, foreign: 38, verifier: 1 },
      result: {
        unaccounted: [
          {
            cgroupPath: '/user.slice/papercusp.slice/pc-orphan123.scope',
            scopeUnit: 'pc-orphan123.scope',
            pids: [11, 12],
            sampleCmdline: 'node unrelated orphan process',
          },
        ],
        verifierScope: [
          {
            cgroupPath: '/user.slice/papercusp.slice/papercup-tauri-verify.scope',
            scopeUnit: 'papercup-tauri-verify.scope',
            pids: [21],
            sampleCmdline: 'npm run tauri dev',
          },
        ],
        foreign: [
          {
            cgroupPath: '/user.slice/foreign.slice/foreign.scope',
            pids: [31],
            sampleCmdline: 'node unrelated foreign process',
          },
        ],
      },
      scan: { processes: 3, foreignTruncated: false },
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
      { live: true, launchedBy: 'su-self', limit: 2000 },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-filtered-live-test',
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
      expect.objectContaining({ launchedBy: 'su-self' }),
    );
    const structured = dispatched.result?.structuredContent as {
      live: Record<string, unknown>;
    };
    expect(structured.live).toMatchObject({
      unaccounted: 38,
      diagnosticsOmitted: 'global process groups omitted because a task selector is active',
    });
    expect(structured.live).not.toHaveProperty('unaccountedGroups');
    expect(structured.live).not.toHaveProperty('foreignGroups');
    expect(structured.live).not.toHaveProperty('verifierGroups');
  });
});
