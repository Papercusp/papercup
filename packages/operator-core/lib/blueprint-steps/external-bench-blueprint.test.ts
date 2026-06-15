/**
 * external-bench as a PROGRAM-MODE deterministic blueprint (impartial-benchmark-suite
 * -2026-06-15, P-019 / BRIEF 2). Proves the built-in loads + validates as a gateless
 * deterministic pipeline, `external-bench:run` is a registered known op, the owner-budget
 * gate carries through (NOT a flag/governor loop), and — the BRIEF 2↔3 seam — the op
 * REFUSES until the adapter (P-005) is bound, then RUNS the (faked) pass through to a
 * clean `done`, echoing the run config + the runId pointer.
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import '../coord-ops/index.js';
import './index.js';
import { coordOpNames } from '../coord-ops/registry.js';
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner.js';
import { makeFakeCaps, makeCtx } from '../coord-ops/test-support.js';
import { setExternalBenchRunDeps } from './ops/external-bench-run.js';
import type { ExternalBenchRunOutcome } from '../external-bench/run-loop.js';

afterEach(() => setExternalBenchRunDeps(null));

const run = async (payload: Record<string, unknown>) => {
  const { blueprint } = loadBuiltinBlueprint('external-bench');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'xbench' });
  return runProgramCore({ blueprint, payload, ctx, runOp: inlineRunOp });
};

test('the external-bench blueprint loads + validates as a gateless deterministic pipeline', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('external-bench');
  assert.equal(validation.ok, true, `validation errors: ${JSON.stringify(validation.errors)}`);
  assert.equal(blueprint.spine.steps?.length, 1);
  assert.equal(blueprint.spine.steps?.[0]?.op, 'external-bench:run');
  assert.ok(!blueprint.spine.gate || blueprint.spine.gate.length === 0);
  // The impartial runner is an EVALUATION harness that owns no repo (per-task repos are
  // cloned by the op), unlike iq-battery/hive-eval.
  assert.equal(blueprint.workItem.kind, 'external-bench-run');
  assert.equal(blueprint.knobs.harnessKind, 'eval');
  assert.equal(blueprint.knobs.requiresRepo, false);
});

test('external-bench:run is a registered known op', () => {
  assert.ok(coordOpNames().has('external-bench:run'));
});

test('no budgetUsd → the step REFUSES (iso-budget / unattended-spend guard), pipeline still done', async () => {
  let ran = 0;
  setExternalBenchRunDeps({
    runner: async () => {
      ran += 1;
      return { action: 'ran' };
    },
  });
  const out = await run({ benchmark: 'swe-bench-pro', taskIds: ['instance_x'] }); // no budgetUsd
  assert.equal(out.outcome, 'done');
  const r = out.scope?.run as ExternalBenchRunOutcome | undefined;
  assert.equal(r?.action, 'refused');
  assert.equal(ran, 0); // the budget gate fires BEFORE the adapter — never spent
});

test('budget set but adapter NOT bound → the default REFUSES until P-005 binds it (the BRIEF 2↔3 seam)', async () => {
  // No deps injected → run-loop.ts's defaultRunner (refuses-until-bound) is used.
  const out = await run({ benchmark: 'swe-bench-pro', taskIds: ['instance_x'], budgetUsd: 25 });
  assert.equal(out.outcome, 'done');
  const r = out.scope?.run as ExternalBenchRunOutcome | undefined;
  assert.equal(r?.action, 'refused');
  assert.match(r?.reason ?? '', /adapter not yet bound/i);
});

test('budget set + a bound adapter → the pass RUNS (reaches done), echoing the run config + runId', async () => {
  let seen: unknown = null;
  setExternalBenchRunDeps({
    runner: async (input) => {
      seen = input;
      return {
        action: 'ran',
        runId: 'rollout-abc123',
        benchmark: input.benchmark,
        arm: input.arm,
        seed: input.seed,
        tasksGraded: input.taskIds?.length ?? 0,
        resolvedCount: 1,
        capUsd: input.budgetUsd,
      };
    },
  });
  const out = await run({
    benchmark: 'swe-bench-pro',
    taskIds: ['instance_astropy__astropy-12345'],
    arm: 'papercusp',
    seed: 2,
    budgetUsd: 25,
  });
  assert.equal(out.outcome, 'done');
  const r = out.scope?.run as ExternalBenchRunOutcome | undefined;
  assert.equal(r?.action, 'ran');
  assert.equal(r?.runId, 'rollout-abc123');
  assert.equal(r?.benchmark, 'swe-bench-pro');
  assert.equal(r?.arm, 'papercusp');
  assert.equal(r?.seed, 2);
  assert.equal(r?.tasksGraded, 1);
  // The whole-placeholder interpolation type-preserves: the op saw an ARRAY of ids and a
  // NUMBER seed, not their stringified forms.
  assert.deepEqual((seen as { taskIds?: unknown }).taskIds, ['instance_astropy__astropy-12345']);
  assert.equal((seen as { seed?: unknown }).seed, 2);
});
