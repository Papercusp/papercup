/**
 * memory-precision as a DETERMINISTIC blueprint (relight-self-learning-edges
 * -2026-06-14 P-033). Proves the built-in loads + validates as a gateless
 * deterministic pipeline, `memory-precision:bench` is a registered known op, and
 * the flag gate carries through a full `runProgramCore` run: flag OFF SKIPS (clean
 * `done`, no bench), flag ON RUNS the (faked) bench → records a row → done.
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import '../coord-ops/index.js';
import './index.js';
import { coordOpNames } from '../coord-ops/registry.js';
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner.js';
import { makeFakeCaps, makeCtx } from '../coord-ops/test-support.js';
import { setMemoryPrecisionBenchDeps } from './ops/memory-precision-bench.js';
import type { MemoryPrecisionMetrics } from '../memory/bench/precision-read.js';

afterEach(() => setMemoryPrecisionBenchDeps(null));

const FAKE_METRICS: MemoryPrecisionMetrics = {
  backend: 'hybrid',
  corpusVersion: 'v1',
  goldVersion: 'v1',
  corpusN: 114,
  goldN: 150,
  floorCosine: 0.45,
  floorLex: 0.4,
  fpAt5: 0.17,
  rAt10: 0.82,
  pAt5: 0.9,
  mrr: 0.7,
  medianTopScore: 0.61,
  latencyP50Ms: 12,
  byClass: {},
  costUsd: null,
  notes: null,
};

const run = async () => {
  const { blueprint } = loadBuiltinBlueprint('memory-precision');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  return runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
};

test('the memory-precision blueprint loads + validates as a gateless deterministic pipeline', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('memory-precision');
  assert.equal(validation.ok, true, `validation errors: ${JSON.stringify(validation.errors)}`);
  assert.equal(blueprint.spine.steps?.length, 1);
  assert.equal(blueprint.spine.steps?.[0]?.op, 'memory-precision:bench');
  assert.ok(!blueprint.spine.gate || blueprint.spine.gate.length === 0);
});

test('the schedule trigger is a workspace singleton that seeds ACTIVE (always-on monitoring)', () => {
  const sched = loadBuiltinBlueprint('memory-precision').blueprint.triggers?.schedule?.[0] as
    | { singleton?: boolean; singletonActive?: boolean; action?: string }
    | undefined;
  assert.equal(sched?.singleton, true);
  assert.equal(sched?.singletonActive, true);
  assert.equal(sched?.action, 'system:blueprint-run');
});

test('memory-precision:bench is a registered known op', () => {
  assert.ok(coordOpNames().has('memory-precision:bench'));
});

test('flag OFF → the step SKIPS (flag-off), pipeline still done, no bench/record', async () => {
  let benched = 0;
  let recorded = 0;
  setMemoryPrecisionBenchDeps({
    flag: async () => false,
    runBench: async () => {
      benched += 1;
      return FAKE_METRICS;
    },
    record: async () => {
      recorded += 1;
      return 1;
    },
  });
  const out = await run();
  assert.equal(out.outcome, 'done');
  const r = out.scope?.bench as { ran: boolean; skipReason?: string } | undefined;
  assert.equal(r?.ran, false);
  assert.equal(r?.skipReason, 'flag-off');
  assert.equal(benched, 0);
  assert.equal(recorded, 0);
});

test('flag ON → the bench RUNS, records a row, reaches done', async () => {
  let benched = 0;
  let recorded = 0;
  let invalidated = 0;
  setMemoryPrecisionBenchDeps({
    flag: async () => true,
    runBench: async () => {
      benched += 1;
      return FAKE_METRICS;
    },
    record: async () => {
      recorded += 1;
      return 42;
    },
    invalidate: () => {
      invalidated += 1;
    },
  });
  const out = await run();
  assert.equal(out.outcome, 'done');
  const r = out.scope?.bench as { ran: boolean; rowId?: number; fpAt5?: number } | undefined;
  assert.equal(r?.ran, true);
  assert.equal(r?.rowId, 42);
  assert.equal(r?.fpAt5, 0.17);
  assert.equal(benched, 1);
  assert.equal(recorded, 1);
  assert.equal(invalidated, 1);
});
