/**
 * P-028 competitor-orchestrator runner + registry tests. Pure (fake driver/grader/emit; no PG, no network,
 * no real OpenHands/CrewAI/LangGraph). Verifies: the registry contract, the deferred-driver infra-error
 * contract (never throws, never scores an unbound arm as a fail), the MAST trace pass-through, the
 * backlog-throughput record, and grade+emit through the SHARED adapter.
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
  summarizeBacklog,
  type CompetitorOrchestratorDriver,
  type CompetitorBacklogRun,
  type CompetitorCoordinationTrace,
} from './competitor-runner';
import type { ArmAttempt, BenchTask, GenerationPorts, GradeResult, OfficialGrader } from './types';
import type { EmitRollout, EmitRolloutInput, BatchContext } from './adapter';

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

// The competitor driver receives ports but our fakes don't touch the filesystem.
const fakePorts: GenerationPorts = {
  clone: async () => ({ dir: '/tmp/x', repo: 'astropy/astropy', baseCommit: 'abc123', cleanup: async () => {} }),
  extractDiff: async () => '',
  instantiate: async () => ({ worktreePath: '/tmp/x', telemetry: { tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0, wallClockMs: 0, trajectoryRef: '', stopReason: 'done' } }),
};

function completedAttempt(arm: string, instanceId: string, seed: string): ArmAttempt {
  return {
    arm,
    blueprintId: arm,
    instanceId,
    seed,
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

/** A fake competitor driver: produces a completed attempt per task + a small MAST trace. */
function fakeDriver(id: CompetitorArmId): CompetitorOrchestratorDriver {
  return {
    async runBacklog(req): Promise<CompetitorBacklogRun> {
      const seed = `seed-${0}`;
      const attempts = req.tasks.map((t) => completedAttempt(id, t.instanceId, seed));
      const trace: CompetitorCoordinationTrace = {
        competitorId: id,
        agents: 2,
        events: [
          { ts: 0, kind: 'spawn', agent: 'planner' },
          { ts: 10, kind: 'delegate', agent: 'planner', taskId: req.tasks[0]?.instanceId, detail: 'to worker' },
          { ts: 20, kind: 'edit', agent: 'worker', taskId: req.tasks[0]?.instanceId },
          { ts: 30, kind: 'complete', agent: 'worker', taskId: req.tasks[0]?.instanceId },
        ],
        mastSignals: { 'inter-agent-misalignment': 1 },
      };
      return {
        competitorId: id,
        attempts,
        trace,
        fleet: summarizeBacklog(attempts, { mode: id, concurrency: 2, backlogDrainMs: 1200, startedAtMs: 100, endedAtMs: 1300 }),
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

function fakeEmit(): { emit: EmitRollout; rows: EmitRolloutInput[] } {
  const rows: EmitRolloutInput[] = [];
  const emit: EmitRollout = async (input) => {
    rows.push(input);
    return { rollout_id: `ro-${rows.length}`, run_id: input.run_id };
  };
  return { emit, rows };
}

const ctx: BatchContext & { seedIndex: number } = {
  runId: 'run-1',
  preregHash: 'hash-1',
  suite: 'swe-bench-pro',
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
    expect(getCompetitor('crewai')?.project).toBe('CrewAI');
  });
});

/* --------------------------- deferred-driver contract --------------------- */

describe('runCompetitorBacklog — deferred-driver infra-error contract', () => {
  it('UNBOUND driver → one infra-error attempt per task, empty trace, zero fleet — never throws', async () => {
    const tasks = [task('a'), task('b')];
    const run = await runCompetitorBacklog({ competitorId: 'openhands-async', tasks, budget: {} }, fakePorts);
    expect(run.attempts).toHaveLength(2);
    for (const a of run.attempts) {
      expect(a.stopReason).toBe('error');
      expect(a.arm).toBe('openhands-async');
      expect(a.generationError).toMatch(/not bound/);
    }
    expect(run.trace.events).toEqual([]);
    expect(run.fleet.tasksAttempted).toBe(2);
    expect(run.fleet.totalCostUsd).toBe(0);
  });

  it('unknown competitor id → infra-error attempts', async () => {
    const run = await runCompetitorBacklog({ competitorId: 'nope' as CompetitorArmId, tasks: [task('a')], budget: {} }, fakePorts);
    expect(run.attempts[0].stopReason).toBe('error');
    expect(run.attempts[0].generationError).toMatch(/unknown competitor/);
  });

  it('a throwing driver is caught → infra-error attempts, never throws', async () => {
    setCompetitorDriver('crewai', {
      async runBacklog() {
        throw new Error('boom');
      },
    });
    const run = await runCompetitorBacklog({ competitorId: 'crewai', tasks: [task('a')], budget: {} }, fakePorts);
    expect(run.attempts[0].stopReason).toBe('error');
    expect(run.attempts[0].generationError).toMatch(/drain failed: boom/);
  });

  it('a bound driver returns its attempts + MAST trace + throughput record', async () => {
    setCompetitorDriver('langgraph', fakeDriver('langgraph'));
    const run = await runCompetitorBacklog({ competitorId: 'langgraph', tasks: [task('a'), task('b')], budget: {} }, fakePorts);
    expect(run.attempts.map((a) => a.stopReason)).toEqual(['done', 'done']);
    expect(run.trace.competitorId).toBe('langgraph');
    expect(run.trace.events.length).toBeGreaterThan(0);
    expect(run.trace.mastSignals?.['inter-agent-misalignment']).toBe(1);
    expect(run.fleet.mode).toBe('langgraph');
    expect(run.fleet.concurrency).toBe(2);
    expect(run.fleet.backlogDrainMs).toBe(1200);
  });
});

/* ----------------------------- summarizeBacklog --------------------------- */

describe('summarizeBacklog — backlog-throughput record', () => {
  it('sums tokens/cost; defaults backlogDrainMs to Σ wall-clock when not measured', () => {
    const attempts = [completedAttempt('crewai', 'a', 's'), completedAttempt('crewai', 'b', 's')];
    const fleet = summarizeBacklog(attempts, { mode: 'crewai' });
    expect(fleet.totalTokensIn).toBe(200);
    expect(fleet.totalCostUsd).toBeCloseTo(0.02);
    expect(fleet.sumTaskWallClockMs).toBe(2000);
    expect(fleet.backlogDrainMs).toBe(2000); // default = Σ when no measured parallel window
    expect(fleet.concurrency).toBe(1);
  });

  it('flags capped when any attempt hit the budget', () => {
    const a = completedAttempt('crewai', 'a', 's');
    const capped = { ...completedAttempt('crewai', 'b', 's'), stopReason: 'budget-exhausted' as const };
    expect(summarizeBacklog([a, capped], { mode: 'crewai' }).capped).toBe(true);
  });
});

/* --------------------------- drain → grade → emit ------------------------- */

describe('runAndGradeCompetitorBacklog — wires the SHARED adapter', () => {
  it('grades + emits one row per task through gradeAndEmitBatch; returns trace + fleet', async () => {
    setCompetitorDriver('openhands-async', fakeDriver('openhands-async'));
    const { emit, rows } = fakeEmit();
    const res = await runAndGradeCompetitorBacklog(
      { competitorId: 'openhands-async', tasks: [task('a'), task('b')], budget: {} },
      fakePorts,
      fakeGrader,
      emit,
      ctx,
    );
    expect(res.rows).toHaveLength(2);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.arm === 'openhands-async')).toBe(true);
    expect(rows.every((r) => r.suite === 'swe-bench-pro')).toBe(true);
    expect(rows.every((r) => r.grading.resolved === true)).toBe(true);
    expect(res.trace.competitorId).toBe('openhands-async');
    expect(res.fleet.mode).toBe('openhands-async');
  });

  it('an infra-failed (unbound) drain emits skipped/null rows — never scored as a task failure', async () => {
    const { emit, rows } = fakeEmit();
    const res = await runAndGradeCompetitorBacklog(
      { competitorId: 'roma', tasks: [task('a')], budget: {} },
      fakePorts,
      fakeGrader,
      emit,
      ctx,
    );
    expect(res.rows).toHaveLength(1);
    expect(rows[0].grading.status).toBe('skipped');
    expect(rows[0].grading.resolved).toBeNull();
    expect(rows[0].generation.status).toBe('error');
  });
});
