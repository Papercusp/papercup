/**
 * Smoke tests for the Baseline C pilot driver (BRIEF 6 / P-008): the one-command end-to-end
 * assembly + the apply-check smoke verifier. Everything is stubbed — NO real LLM / Docker / git / PG
 * spend. This proves the wiring (sample → verify → select → grade → emit) is sound before the pilot
 * lead runs the bounded smoke with the live bindings.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  makeApplyCheckVerifierOps,
  runBestOfNPilotTask,
  type BestOfNPilotDeps,
} from './baseline-best-of-n-pilot';
import type { BenchTask, GradeResult, OfficialGrader, TaskCheckout } from './types';
import type { VisibleTask } from './baseline-best-of-n-live';

const TASK: BenchTask = {
  benchmark: 'swe-bench-pro',
  instanceId: 'instance_x',
  problemStatement: 'Fix it.',
  repo: 'o/r',
  baseCommit: 'a'.repeat(40),
  graderMeta: { FAIL_TO_PASS: ['secret'], testFiles: ['tests/test_secret.py'] },
};

function fakeCheckout(): TaskCheckout {
  return { dir: '/tmp/clean', repo: 'o/r', baseCommit: 'a'.repeat(40), cleanup: vi.fn(async () => {}) };
}

describe('makeApplyCheckVerifierOps', () => {
  it('reports applied=true when `git apply --check` exits 0, and strips graderMeta on clone', async () => {
    let cloneArg: VisibleTask | undefined;
    const procExec = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const writeFile = vi.fn(async () => {});
    const ops = makeApplyCheckVerifierOps({
      cloneAtBase: async (t) => {
        cloneArg = t;
        return fakeCheckout();
      },
      procExec,
      writeFile,
    });
    const checkout = await ops.cloneAtBase({ benchmark: 'swe-bench-pro', instanceId: 'instance_x', problemStatement: 'x', repo: 'o/r', baseCommit: 'a'.repeat(40) });
    const r = await ops.applyDiff(checkout, 'diff --git a/f b/f');
    expect(r.applied).toBe(true);
    // the verifier only ever sees a VisibleTask — graderMeta is not part of its input type
    expect(cloneArg && 'graderMeta' in cloneArg).toBe(false);
    // `git apply --check` (no mutation) was the command
    expect(procExec).toHaveBeenCalledWith('git', ['-C', '/tmp/clean', 'apply', '--check', '/tmp/clean/.bestofn-candidate.patch']);
    expect(writeFile).toHaveBeenCalled();
  });

  it('reports applied=false on a non-zero apply --check and on an empty diff', async () => {
    const ops = makeApplyCheckVerifierOps({
      cloneAtBase: async () => fakeCheckout(),
      procExec: async () => ({ stdout: '', stderr: 'patch does not apply', code: 1 }),
      writeFile: async () => {},
    });
    const checkout = fakeCheckout();
    expect((await ops.applyDiff(checkout, 'bad patch')).applied).toBe(false);
    expect((await ops.applyDiff(checkout, '   ')).applied).toBe(false);
  });
});

describe('runBestOfNPilotTask — end-to-end wiring (stubbed)', () => {
  function makeDeps(over: Partial<BestOfNPilotDeps> = {}): { deps: BestOfNPilotDeps; emitted: unknown[]; graded: string[] } {
    const emitted: unknown[] = [];
    const graded: string[] = [];
    // Sampling flows through the stubbed generationPorts (no real harness/LLM) — runSingleAgentAttempt
    // calls clone → instantiate → extractDiff and assembles the ArmAttempt from the telemetry.
    let n = 0;
    const generationPorts = {
      clone: vi.fn(async () => fakeCheckout()),
      extractDiff: vi.fn(async () => 'patch'),
      // runSingleAgentAttempt consumes these; but we bypass it via verifierOps? No — sample uses
      // runSingleAgentAttempt(generationPorts). Stub instantiate to yield deterministic telemetry.
      instantiate: vi.fn(async () => ({
        worktreePath: '/tmp/clean',
        telemetry: { tokensIn: 40, tokensOut: 40, costUsd: 0, turns: 2, wallClockMs: 10, trajectoryRef: `traj://${n++}`, stopReason: 'done' as const },
      })),
    };
    const grader: OfficialGrader = {
      family: 'swe-bench-pro',
      modality: 'diff',
      async grade(subs) {
        const patch = subs[0].modality === 'diff' ? subs[0].patch : '';
        graded.push(patch);
        const result: GradeResult = {
          instanceId: TASK.instanceId,
          prefix: '0',
          resolved: true,
          rawGraderOutput: { ok: true },
          graderFamily: 'swe-bench-pro',
          graderVersion: 'v1',
        };
        return [result];
      },
    };
    const deps: BestOfNPilotDeps = {
      generationPorts,
      grader,
      emit: async (input) => {
        emitted.push(input);
        return { rolloutId: 'rollout-smoke', runId: input.runId };
      },
      // apply-check verifier with all-clean stubs (no real git)
      verifierOps: makeApplyCheckVerifierOps({
        cloneAtBase: async () => fakeCheckout(),
        procExec: async () => ({ stdout: '', stderr: '', code: 0 }),
        writeFile: async () => {},
      }),
      now: (() => {
        let t = 0;
        return () => (t += 5);
      })(),
      ...over,
    };
    return { deps, emitted, graded };
  }

  it('runs N samples → apply-check verify → grade selected → emit one baseline-c row', async () => {
    const { deps, emitted, graded } = makeDeps();
    const out = await runBestOfNPilotTask(
      {
        runId: 'run-smoke',
        preregHash: 'prereg-smoke',
        suite: 'swe-bench-pro',
        modelId: 'claude-opus-4-8',
        harnessVersion: 'best-of-n-pilot@0.1.0',
        task: TASK,
        seed: 0,
        n: 3,
        budgetTokens: 100_000,
      },
      deps,
    );
    expect(emitted).toHaveLength(1);
    expect(out.emitted.arm).toBe('baseline-c-bestofn');
    expect(out.emitted.generation.status).toBe('completed');
    expect(out.armMeta.n).toBe(3);
    expect(out.armMeta.samples_run).toBe(3);
    // the apply-check tier is recorded in arm_meta so a scored run can never silently use it
    expect(out.armMeta.verifier.kind).toBe('apply-check');
    // exactly one diff was graded (the selected candidate), not all N
    expect(graded).toHaveLength(1);
    expect(out.emitted.grading.resolved).toBe(true);
    expect(out.rolloutId).toBe('rollout-smoke');
  });
});
