import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  LIFECYCLE_IDLE_QUIET_MS,
  LIFECYCLE_JUDGE_INTERVAL_MS,
  LIFECYCLE_LAUNCHER_ENDED_GRACE_MS,
  evaluateLifecycleCandidates,
  lifecycleCandidateConditionKey,
  lifecycleJudgeIntervalKey,
  runLifecycleJudgementSweep,
  type LifecycleJudgementDeps,
  type ProcessLifecycleProbe,
  type ProcessLifecycleVerdict,
} from './lifecycle-judgement';
import type { TaskRow } from './types';

const NOW = Date.parse('2026-09-24T06:00:00.000Z');

function row(over: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: 'task-a',
    workspaceId: 'ws-1',
    harnessSlug: 'papercusp',
    parentTaskId: null,
    rootTaskId: 'task-a',
    class: 'sidecar',
    title: 'background sidecar',
    argv: ['node', 'sidecar.js'],
    cwd: '/repo',
    launchedBy: 'su-launcher',
    workItemId: null,
    planSlug: null,
    fleetSlug: null,
    sessionId: null,
    scopeUnit: 'pc-taska.scope',
    cgroupPath: '/sys/fs/cgroup/pc-taska.scope',
    pid: 42,
    processIdentity: '42:1',
    confined: true,
    state: 'running',
    exitCode: null,
    exitReason: null,
    terminalProvenance: null,
    startedAt: new Date(NOW - 12 * 60 * 60_000).toISOString(),
    endedAt: null,
    lastSeenAt: new Date(NOW).toISOString(),
    deadlineAt: null,
    logPath: '/logs/task-a.log',
    lastMemoryBytes: 1024,
    peakMemoryBytes: 2048,
    cpuUsec: 100,
    pidsCurrent: 2,
    pidsEventsMax: 0,
    detail: {},
    ...over,
  };
}

function evaluate(input: {
  rows: TaskRow[];
  nowMs?: number;
  residue?: string[];
  launchers?: Array<[string, string | null]>;
  verdicts?: Array<[string, ProcessLifecycleVerdict]>;
  logMtimeMs?: number | null;
}) {
  return evaluateLifecycleCandidates({
    rows: input.rows,
    confirmedResidueTaskIds: new Set(input.residue ?? []),
    launcherStates: new Map(input.launchers ?? []),
    latestVerdicts: new Map(input.verdicts ?? []),
    statLogMtimeMs: () => input.logMtimeMs ?? null,
    nowMs: input.nowMs ?? NOW,
  });
}

describe('evaluateLifecycleCandidates', () => {
  it('requires the launcher-ended condition to persist for 15 minutes across restart-safe probes', () => {
    const first = evaluate({
      rows: [row({ logPath: null })],
      launchers: [['su-launcher', 'ended']],
    });
    expect(first.candidates).toEqual([]);
    expect(first.probeUpdates).toHaveLength(1);
    expect(first.probeUpdates[0].probe.launcherEndedSinceMs).toBe(NOW);

    const second = evaluate({
      rows: [
        row({
          logPath: null,
          detail: { processLifecycleProbe: first.probeUpdates[0].probe },
        }),
      ],
      nowMs: NOW + LIFECYCLE_LAUNCHER_ENDED_GRACE_MS + 1,
      launchers: [['su-launcher', 'ended']],
    });
    expect(second.candidates).toHaveLength(1);
    expect(second.candidates[0].kinds).toContain('launcher-ended');
  });

  it('uses a readable old log immediately, but a no-log task gets a first-observation baseline', () => {
    const logIdle = evaluate({
      rows: [row()],
      launchers: [['su-launcher', 'live']],
      logMtimeMs: NOW - LIFECYCLE_IDLE_QUIET_MS - 1,
    });
    expect(logIdle.candidates[0].kinds).toEqual(['old-and-idle']);

    const firstNoLog = evaluate({
      rows: [row({ taskId: 'no-log', rootTaskId: 'no-log', logPath: null })],
      launchers: [['su-launcher', 'live']],
    });
    expect(firstNoLog.candidates).toEqual([]);
    expect(firstNoLog.probeUpdates[0].probe.lastActivityAtMs).toBe(NOW);

    const quietProbe: ProcessLifecycleProbe = firstNoLog.probeUpdates[0].probe;
    const later = evaluate({
      rows: [
        row({
          taskId: 'no-log',
          rootTaskId: 'no-log',
          logPath: null,
          detail: { processLifecycleProbe: quietProbe },
        }),
      ],
      nowMs: NOW + LIFECYCLE_IDLE_QUIET_MS + 1,
      launchers: [['su-launcher', 'live']],
    });
    expect(later.candidates[0].kinds).toContain('old-and-idle');
  });

  it('treats CPU movement as activity and does not infer idleness from missing measurements', () => {
    const probe: ProcessLifecycleProbe = {
      version: 1,
      launcherEndedSinceMs: null,
      logPath: null,
      logMtimeMs: null,
      cpuUsec: 100,
      lastActivityAtMs: NOW - LIFECYCLE_IDLE_QUIET_MS - 1,
    };
    const active = evaluate({
      rows: [row({ logPath: null, cpuUsec: 101, detail: { processLifecycleProbe: probe } })],
      launchers: [['su-launcher', 'live']],
    });
    expect(active.candidates).toEqual([]);
    expect(active.probeUpdates[0].probe.lastActivityAtMs).toBe(NOW);

    const unmeasured = evaluate({
      rows: [row({ logPath: null, cpuUsec: null, detail: { processLifecycleProbe: probe } })],
      launchers: [['su-launcher', 'live']],
    });
    expect(unmeasured.candidates).toEqual([]);
  });

  it('selects only confirmed unaccounted/terminal residue and honors the terminal grace', () => {
    const unaccounted = row({ taskId: 'unaccounted', rootTaskId: 'unaccounted', state: 'unaccounted' });
    const terminal = row({
      taskId: 'terminal',
      rootTaskId: 'terminal',
      state: 'exited',
      endedAt: new Date(NOW - 16 * 60_000).toISOString(),
    });
    const youngTerminal = row({
      taskId: 'young-terminal',
      rootTaskId: 'young-terminal',
      state: 'exited',
      endedAt: new Date(NOW - 2 * 60_000).toISOString(),
    });
    const result = evaluate({
      rows: [unaccounted, terminal, youngTerminal],
      residue: ['unaccounted', 'terminal', 'young-terminal'],
    });
    expect(result.candidates.map((candidate) => [candidate.taskId, candidate.kinds])).toEqual([
      ['unaccounted', ['unaccounted-residue']],
      ['terminal', ['terminal-residue']],
    ]);
  });

  it('excludes agent sessions and human-terminal auto-reap exemptions', () => {
    const result = evaluate({
      rows: [
        row({ taskId: 'agent', rootTaskId: 'agent', class: 'agent-session', state: 'unaccounted' }),
        row({ taskId: 'human', rootTaskId: 'human', state: 'unaccounted', detail: { autoReapExempt: true } }),
      ],
      residue: ['agent', 'human'],
    });
    expect(result.candidates).toEqual([]);
  });

  it('suppresses a keep verdict only until its explicit recheck date', () => {
    const candidate = row({ taskId: 'kept', rootTaskId: 'kept', state: 'unaccounted' });
    const keep: ProcessLifecycleVerdict = {
      taskId: 'kept',
      decision: 'keep',
      reason: 'serves a live tenant',
      keepCount: 2,
      recheckAt: new Date(NOW + 60_000).toISOString(),
    };
    const suppressed = evaluate({ rows: [candidate], residue: ['kept'], verdicts: [['kept', keep]] });
    expect(suppressed.candidates).toEqual([]);
    expect(suppressed.suppressedByKeep).toEqual(['kept']);

    const due = evaluate({
      rows: [candidate],
      residue: ['kept'],
      verdicts: [['kept', keep]],
      nowMs: NOW + 60_001,
    });
    expect(due.candidates).toHaveLength(1);
    expect(due.candidates[0].previousVerdict).toEqual(keep);
  });
});

function depsForRunner(over: Partial<LifecycleJudgementDeps> = {}): LifecycleJudgementDeps {
  return {
    loadRows: async () => [],
    resolveLauncherStates: async () => new Map(),
    statLogMtimeMs: () => null,
    readLatestVerdicts: async () => new Map(),
    persistProbes: async (updates) => updates.length,
    upsertCandidate: async (_key, candidate) => ({ id: `WI-${candidate.taskId}` }),
    listOpenCandidateItems: async () => [],
    spawnJudge: async () => ({ ok: true, spawnId: 'spawn-1' }),
    ...over,
  };
}

describe('runLifecycleJudgementSweep', () => {
  it('files one condition-keyed item per task and hands every open item to one interval-idempotent judge', async () => {
    const candidate = row({ taskId: 'residue-a', rootTaskId: 'residue-a', state: 'unaccounted' });
    const upsert = vi.fn(async (_key: string, c: { taskId: string }) => ({ id: `WI-${c.taskId}` }));
    const actualLaunches = new Set<string>();
    const spawn = vi.fn(async (input: Parameters<LifecycleJudgementDeps['spawnJudge']>[0]) => {
      const deduped = actualLaunches.has(input.idempotencyKey);
      actualLaunches.add(input.idempotencyKey);
      return { ok: true, spawnId: 'spawn-1', deduped };
    });
    const deps = depsForRunner({
      loadRows: async () => [candidate],
      upsertCandidate: upsert as LifecycleJudgementDeps['upsertCandidate'],
      listOpenCandidateItems: async () => [
        { id: 'WI-residue-a', taskId: 'residue-a', harnessSlug: 'papercusp' },
        { id: 'WI-left-open', taskId: 'older-task', harnessSlug: 'other-harness' },
      ],
      spawnJudge: spawn as LifecycleJudgementDeps['spawnJudge'],
    });

    const input = {
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      confirmedResidueTaskIds: ['residue-a'],
      nowMs: NOW,
    };
    const first = await runLifecycleJudgementSweep(input, deps);
    const replay = await runLifecycleJudgementSweep(input, deps);

    expect(upsert).toHaveBeenCalledWith(
      lifecycleCandidateConditionKey('residue-a'),
      expect.objectContaining({ taskId: 'residue-a' }),
      'papercusp',
    );
    expect(first.openItems).toEqual(['WI-residue-a', 'WI-left-open']);
    expect(first.judge.idempotencyKey).toBe(lifecycleJudgeIntervalKey('ws-1', NOW));
    expect(replay.judge.idempotencyKey).toBe(first.judge.idempotencyKey);
    expect(actualLaunches.size).toBe(1);
    expect(spawn.mock.calls[0][0].brief).toContain('WI-left-open | taskId=older-task');
    expect(spawn.mock.calls[0][0].brief).toContain('reapTerminalResidue:true');
  });

  it('changes the launch key only when the one-hour interval changes', () => {
    const current = lifecycleJudgeIntervalKey('ws-1', NOW);
    expect(lifecycleJudgeIntervalKey('ws-1', NOW + LIFECYCLE_JUDGE_INTERVAL_MS - 1)).toBe(current);
    expect(lifecycleJudgeIntervalKey('ws-1', NOW + LIFECYCLE_JUDGE_INTERVAL_MS)).not.toBe(current);
  });

  it('launches for an earlier open candidate even when this sweep finds no current candidate', async () => {
    const spawn = vi.fn(async () => ({ ok: true, spawnId: 'spawn-existing' }));
    const result = await runLifecycleJudgementSweep(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', nowMs: NOW },
      depsForRunner({
        listOpenCandidateItems: async () => [{ id: 'WI-existing', taskId: 'existing-task', harnessSlug: 'papercusp' }],
        spawnJudge: spawn,
      }),
    );
    expect(result.candidates).toBe(0);
    expect(result.judge.attempted).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('task-reconcile production wiring', () => {
  const lifecycleSource = readFileSync(new URL('./lifecycle-judgement.ts', import.meta.url), 'utf8');
  const actionSource = readFileSync(new URL('../harness/routines/task-reconcile-action.ts', import.meta.url), 'utf8');

  it('keeps the lifecycle sweep on the existing task-reconcile routine', () => {
    expect(actionSource).toContain("registerSystemAction('task-reconcile'");
    expect(actionSource).toContain('runLifecycleJudgementSweep({');
    expect(actionSource).toContain('confirmedResidueTaskIds');
    expect(actionSource).toContain('intervalMs: LIFECYCLE_SWEEP_INTERVAL_MS');
  });

  it('launches one headless quick-tier su through the durable interval idempotency seam', () => {
    expect(lifecycleSource).toContain("role: 'su'");
    expect(lifecycleSource).toContain("tier: 'quick'");
    expect(lifecycleSource).toContain("accountOverride: 'auto'");
    expect(lifecycleSource).toContain('idempotencyKey,');
    expect(lifecycleSource).toContain("spawnCaller: 'task-manager/lifecycle-judgement'");
  });
});
