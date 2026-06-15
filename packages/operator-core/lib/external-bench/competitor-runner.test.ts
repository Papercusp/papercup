/**
 * P-028 competitor-orchestrator runner + registry tests. Pure (fake driver/grader/emit; no PG, no network,
 * no real OpenHands/CrewAI/LangGraph). Verifies: the registry/feasibility contract, the deferred-driver
 * infra-error contract (never throws, never scores an unbound arm as a fail), that competitors emit the
 * CANONICAL HiveBacklogResult (so they're structurally identical to the hive arm), grade+emit through the
 * SHARED adapter, the FleetRunSummary projection, and MAST coordEvents pass-through.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  COMPETITOR_ORCHESTRATORS,
  COMPETITOR_ARM_IDS,
  CORE_COMPETITOR_ARM_IDS,
  getCompetitor,
  isCompetitorArmId,
  type CompetitorArmId,
} from './competitor-registry';
import {
  runCompetitorBacklog,
  runAndGradeCompetitorBacklog,
  setCompetitorDriver,
  clearCompetitorDrivers,
  type CompetitorBacklogDriver,
} from './competitor-runner';
import type { HiveBacklogResult, HiveBacklogRunRequest } from './hive-backlog';
import type { CoordEvent } from '@papercusp/bench-metrics';
import type { ArmAttempt, BenchTask, GradeResult, OfficialGrader } from './types';
import type { EmitRollout, EmitFromAttemptInput, BatchContext } from './adapter';

/* --------------------------------- fakes ---------------------------------- */

function task(instanceId: string): BenchTask {
  return {
    benchmark: 'swe-bench-pro',
    instanceId,
    problemStatement: `fix ${instanceId}`,
    repo: 'astropy/astropy',
    baseCommit: 'abc123',
    graderMeta: { FAIL_TO_PASS: ['t1'] },
  };
}

function completedAttempt(arm: string, instanceId: string): ArmAttempt {
  return {
    arm,
    blueprintId: arm,
    instanceId,
    seed: 'seed-0',
    diff: `--- a/${instanceId}\n+++ b/${instanceId}\n@@ -1 +1 @@\n-x\n+y\n`,
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.01,
    turns: 4,
    wallClockMs: 1000,
    trajectoryRef: `traj-${instanceId}`,
    stopReason: 'done',
  };
}

function req(arm: CompetitorArmId, ids: string[]): HiveBacklogRunRequest {
  return { arm, suite: 'swe-bench-pro', runId: 'run-1', seed: 0, backlog: ids.map(task), budget: {} };
}

/** A fake competitor driver: emits the CANONICAL HiveBacklogResult (one task result per task + a MAST trace). */
function fakeDriver(id: CompetitorArmId): CompetitorBacklogDriver {
  return {
    async run(r): Promise<HiveBacklogResult> {
      const taskResults = r.backlog.map((t, i) => ({
        attempt: completedAttempt(id, t.instanceId),
        beeId: `${id}-agent-${i}`,
        placedAtMs: 100 + i,
        startedAtMs: 110 + i,
        finishedAtMs: 1100 + i,
        disposition: 'spawn' as const,
      }));
      const coordEvents: CoordEvent[] = [
        { ts: 0, kind: 'spawn', agent: 'planner' },
        { ts: 10, kind: 'handoff', agent: 'planner', taskId: r.backlog[0]?.instanceId, detail: 'to worker' },
        { ts: 20, kind: 'edit', agent: 'worker', taskId: r.backlog[0]?.instanceId },
        { ts: 30, kind: 'complete', agent: 'worker', taskId: r.backlog[0]?.instanceId },
      ];
      return {
        arm: id,
        suite: r.suite,
        runId: r.runId,
        seed: r.seed,
        startedAtMs: 100,
        finishedAtMs: 1300,
        peakConcurrentBees: 2,
        taskResults,
        coordEvents,
      };
    },
  };
}

const fakeGrader: OfficialGrader = {
  family: 'swe-bench-pro',
  modality: 'diff',
  async grade(submissions): Promise<GradeResult[]> {
    return submissions.map((s) => ({
      instanceId: s.instanceId,
      prefix: s.prefix,
      resolved: true,
      rawGraderOutput: { ok: true },
      graderFamily: 'swe-bench-pro',
      graderVersion: 'v1',
    }));
  },
};

function fakeEmit(): { emit: EmitRollout; rows: EmitFromAttemptInput[] } {
  const rows: EmitFromAttemptInput[] = [];
  const emit: EmitRollout = async (input) => {
    rows.push(input);
    return { rolloutId: `ro-${rows.length}`, runId: input.runId };
  };
  return { emit, rows };
}

const ctx: BatchContext & { seedIndex: number } = {
  runId: 'run-1',
  preregHash: 'hash-1',
  modelId: 'claude-opus-4-8[1m]',
  harnessVersion: 'openhands@x+sha',
  seedIndex: 0,
};

afterEach(() => clearCompetitorDrivers());

/* ------------------------------- registry --------------------------------- */

describe('competitor registry (P-028)', () => {
  it('declares the three core competitors + ROMA optional', () => {
    expect(CORE_COMPETITOR_ARM_IDS).toEqual(['openhands-async', 'crewai', 'langgraph']);
    expect(COMPETITOR_ARM_IDS).toContain('roma');
    expect(COMPETITOR_ORCHESTRATORS.find((c) => c.id === 'roma')?.tier).toBe('optional');
  });

  it('every competitor has the feasibility fields + a diff modality (M1 backbone)', () => {
    for (const c of COMPETITOR_ORCHESTRATORS) {
      expect(c.title && c.project && c.license && c.topology && c.invocation && c.integrationNote).toBeTruthy();
      expect(['low', 'medium', 'high']).toContain(c.integrationCost);
      expect(c.modality).toBe('diff');
    }
  });

  it('isCompetitorArmId / getCompetitor', () => {
    expect(isCompetitorArmId('openhands-async')).toBe(true);
    expect(isCompetitorArmId('papercusp')).toBe(false);
    expect(isCompetitorArmId('hive')).toBe(false);
    expect(getCompetitor('crewai')?.project).toBe('CrewAI');
  });
});

/* --------------------------- deferred-driver contract --------------------- */

describe('runCompetitorBacklog — canonical record + deferred-driver infra-error contract', () => {
  it('UNBOUND driver → infra-error result (runError, empty taskResults/coordEvents) — never throws', async () => {
    const r = await runCompetitorBacklog(req('openhands-async', ['a', 'b']));
    expect(r.arm).toBe('openhands-async');
    expect(r.taskResults).toEqual([]);
    expect(r.coordEvents).toEqual([]);
    expect(r.runError).toMatch(/not bound/);
  });

  it('a non-competitor arm (e.g. hive) is rejected as not-a-competitor', async () => {
    const r = await runCompetitorBacklog({ ...req('openhands-async', ['a']), arm: 'hive' as CompetitorArmId });
    expect(r.runError).toMatch(/not a registered competitor/);
  });

  it('a throwing driver is caught → runError, never throws', async () => {
    setCompetitorDriver('crewai', {
      async run() {
        throw new Error('boom');
      },
    });
    const r = await runCompetitorBacklog(req('crewai', ['a']));
    expect(r.runError).toMatch(/drain failed: boom/);
    expect(r.taskResults).toEqual([]);
  });

  it('a bound driver returns the canonical HiveBacklogResult + MAST coordEvents', async () => {
    setCompetitorDriver('langgraph', fakeDriver('langgraph'));
    const r = await runCompetitorBacklog(req('langgraph', ['a', 'b']));
    expect(r.runError).toBeUndefined();
    expect(r.arm).toBe('langgraph');
    expect(r.taskResults).toHaveLength(2);
    expect(r.taskResults.every((t) => t.attempt.stopReason === 'done')).toBe(true);
    expect(r.coordEvents.length).toBeGreaterThan(0);
    expect(r.peakConcurrentBees).toBe(2);
  });
});

/* --------------------------- drain → grade → emit ------------------------- */

describe('runAndGradeCompetitorBacklog — shared adapter + FleetRunSummary projection', () => {
  it('grades + emits one row per task; projects the canonical FleetRunSummary; passes the MAST trace', async () => {
    setCompetitorDriver('openhands-async', fakeDriver('openhands-async'));
    const { emit, rows } = fakeEmit();
    const res = await runAndGradeCompetitorBacklog(req('openhands-async', ['a', 'b']), fakeGrader, emit, ctx);

    expect(res.rows).toHaveLength(2);
    expect(rows).toHaveLength(2);
    // competitor arm rides as text at rest; EmitFromAttemptInput.arm is typed ArmId (L1), hence the cast.
    expect(rows.every((r) => (r.arm as string) === 'openhands-async')).toBe(true);
    expect(rows.every((r) => r.task.benchmark === 'swe-bench-pro')).toBe(true);
    expect(rows.every((r) => r.grade.resolved === true)).toBe(true);

    expect(res.fleet).not.toBeNull();
    expect(res.fleet?.arm).toBe('openhands-async');
    expect(res.fleet?.tasks).toBe(2);
    expect(res.fleet?.resolved).toBe(2);
    expect(res.fleet?.tasksZeroHumanGate).toBe(2);
    expect(res.fleet?.wallClockMs).toBe(1200); // 1300 − 100 (PARALLEL drain window, not Σ)

    expect(res.coordEvents.length).toBeGreaterThan(0);
  });

  it('a whole-run infra failure (unbound) → no rows, fleet null — never scored as task failures', async () => {
    const { emit, rows } = fakeEmit();
    const res = await runAndGradeCompetitorBacklog(req('roma', ['a']), fakeGrader, emit, ctx);
    expect(res.rows).toEqual([]);
    expect(rows).toEqual([]);
    expect(res.fleet).toBeNull();
    expect(res.coordEvents).toEqual([]);
  });
});
