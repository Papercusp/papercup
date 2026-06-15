/**
 * P-032 competitor-arm pilot COMPOSITION smoke — the bounded, PG-free proof that the arm is one-command-ready:
 * drain (fake driver) → grade (fake grader) → per-task emit (fake) → fleet-run + coord-trace emit (fake). The
 * real frameworks + live PG seams are bound only at the owner-gated run; this proves the wiring is correct.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runCompetitorArmPilot, liveCompetitorEmitPorts, type CompetitorPilotDeps } from './competitor-pilot';
import { setCompetitorDriver, clearCompetitorDrivers, type CompetitorBacklogDriver } from './competitor-runner';
import { fleetRunIdFor, type FleetRunInput } from './reproducibility/fleet';
import type { HiveBacklogResult } from './hive-backlog';
import type { CoordEvent } from '@papercusp/bench-metrics';
import type { ArmAttempt, BenchTask, GradeResult, OfficialGrader } from './types';

function task(instanceId: string): BenchTask {
  return { benchmark: 'swe-bench-pro', instanceId, problemStatement: `fix ${instanceId}`, repo: 'astropy/astropy', baseCommit: 'abc123', graderMeta: {} };
}

function attempt(arm: string, instanceId: string): ArmAttempt {
  return {
    arm, blueprintId: arm, instanceId, seed: 'seed-0',
    diff: `--- a/${instanceId}\n+++ b/${instanceId}\n@@ -1 +1 @@\n-x\n+y\n`,
    tokensIn: 100, tokensOut: 50, costUsd: 0.01, turns: 4, wallClockMs: 1000, trajectoryRef: `t-${instanceId}`, stopReason: 'done',
  };
}

function fakeDriver(id: 'openhands-async'): CompetitorBacklogDriver {
  return {
    async run(r): Promise<HiveBacklogResult> {
      const coordEvents: CoordEvent[] = [
        { ts: 0, kind: 'spawn', agent: 'planner' },
        { ts: 10, kind: 'handoff', agent: 'planner', taskId: r.backlog[0]?.instanceId },
        { ts: 20, kind: 'complete', agent: 'worker', taskId: r.backlog[0]?.instanceId },
      ];
      return {
        arm: id, suite: r.suite, runId: r.runId, seed: r.seed,
        startedAtMs: 100, finishedAtMs: 1300, peakConcurrentBees: 2,
        taskResults: r.backlog.map((t, i) => ({
          attempt: attempt(id, t.instanceId), beeId: `${id}-${i}`,
          placedAtMs: 100, startedAtMs: 110, finishedAtMs: 1100, disposition: 'spawn' as const,
        })),
        coordEvents,
      };
    },
  };
}

const grader: OfficialGrader = {
  family: 'swe-bench-pro', modality: 'diff',
  async grade(subs): Promise<GradeResult[]> {
    return subs.map((s) => ({ instanceId: s.instanceId, prefix: s.prefix, resolved: true, rawGraderOutput: {}, graderFamily: 'swe-bench-pro', graderVersion: 'v1' }));
  },
};

const baseInput = {
  competitorId: 'openhands-async' as const,
  backlog: [task('a'), task('b')],
  backlogId: 'backlog-1',
  runId: 'run-1',
  suite: 'swe-bench-pro' as const,
  seed: 0,
  preregHash: 'hash-1',
  modelId: 'claude-opus-4-8[1m]',
  harnessVersion: 'openhands@x+sha',
  budget: {},
};

afterEach(() => clearCompetitorDrivers());

describe('runCompetitorArmPilot — one-command competitor arm (P-032)', () => {
  it('bound driver → drains, grades, emits per-task rows + the fleet run + the MAST trace', async () => {
    setCompetitorDriver('openhands-async', fakeDriver('openhands-async'));
    const fleetEmits: FleetRunInput[] = [];
    let rowEmits = 0;
    const deps: CompetitorPilotDeps = {
      grader,
      emit: async (input) => { rowEmits += 1; return { rolloutId: `ro-${rowEmits}`, runId: input.runId }; },
      emitFleet: async (input) => { fleetEmits.push(input); return { fleetRunId: 'fr', runId: input.summary.runId }; },
    };

    const res = await runCompetitorArmPilot(baseInput, deps);

    // deterministic fleetRunId, matching emitFleetRun's own derivation
    expect(res.fleetRunId).toBe(fleetRunIdFor('run-1', 'swe-bench-pro', 'backlog-1', 'openhands-async', 0));
    // per-task rows
    expect(res.rows).toHaveLength(2);
    expect(rowEmits).toBe(2);
    // fleet projection
    expect(res.fleet).not.toBeNull();
    expect(res.fleet?.arm).toBe('openhands-async');
    expect(res.fleet?.tasks).toBe(2);
    expect(res.fleet?.resolved).toBe(2);
    expect(res.fleet?.wallClockMs).toBe(1200);
    // fleet run + trace emitted
    expect(fleetEmits).toHaveLength(1);
    expect(fleetEmits[0].summary).toBe(res.fleet);
    expect(fleetEmits[0].preregHash).toBe('hash-1');
    expect(fleetEmits[0].backlogId).toBe('backlog-1');
    expect((fleetEmits[0].coordEvents ?? []).length).toBeGreaterThan(0);
    expect(res.emitted).toEqual({ fleetRunId: 'fr', runId: 'run-1' });
  });

  it('UNBOUND driver → infra-error: no fleet, nothing emitted, never scored', async () => {
    const fleetEmits: FleetRunInput[] = [];
    const deps: CompetitorPilotDeps = {
      grader,
      emit: async (input) => ({ rolloutId: 'ro', runId: input.runId }),
      emitFleet: async (input) => { fleetEmits.push(input); return { fleetRunId: 'fr', runId: input.summary.runId }; },
    };
    const res = await runCompetitorArmPilot(baseInput, deps);
    expect(res.raw.runError).toMatch(/not bound/);
    expect(res.fleet).toBeNull();
    expect(res.emitted).toBeNull();
    expect(res.rows).toEqual([]);
    expect(fleetEmits).toHaveLength(0);
  });

  it('liveCompetitorEmitPorts exposes the real emit + emitFleet seams for the gated run', () => {
    const ports = liveCompetitorEmitPorts();
    expect(typeof ports.emit).toBe('function');
    expect(typeof ports.emitFleet).toBe('function');
  });
});
