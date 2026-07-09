/**
 * hive-eval as a DETERMINISTIC blueprint (hive-run-evaluation-2026-06-13 HE-07, P-050) — the
 * SIBLING of the iq-battery blueprint. Proves the built-in loads + validates as a gateless
 * deterministic pipeline, `pot-eval:gen` is a registered known op, and the owner-budget gate
 * carries through (NOT a flag/governor loop): a full `runProgramCore` run REFUSES with no budget,
 * RUNS the (faked) generation with one, and SKIPS when the generation already exists.
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import '../coord-ops/index.js';
import './index.js';
import { coordOpNames } from '../coord-ops/registry.js';
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner.js';
import { makeFakeCaps, makeCtx } from '../coord-ops/test-support.js';
import { setHiveEvalGenDeps } from './ops/hive-eval-gen.js';

afterEach(() => setHiveEvalGenDeps(null));

const run = async (payload: Record<string, unknown>) => {
  const { blueprint } = loadBuiltinBlueprint('pot-eval');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  return runProgramCore({ blueprint, payload, ctx, runOp: inlineRunOp });
};

test('the hive-eval blueprint loads + validates as a gateless deterministic pipeline', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('pot-eval');
  assert.equal(validation.ok, true, `validation errors: ${JSON.stringify(validation.errors)}`);
  assert.equal(blueprint.spine.steps?.length, 1);
  assert.equal(blueprint.spine.steps?.[0]?.op, 'pot-eval:gen');
  assert.ok(!blueprint.spine.gate || blueprint.spine.gate.length === 0);
});

test('pot-eval:gen is a registered known op', () => {
  assert.ok(coordOpNames().has('pot-eval:gen'));
});

test('no budgetUsd → the step REFUSES (unattended-spend guard), pipeline still done', async () => {
  let battery = 0;
  setHiveEvalGenDeps({
    currentCodeSha: () => 'abc123',
    generationExists: async () => false,
    runBattery: async () => {
      battery += 1;
    },
  });
  const out = await run({}); // no budgetUsd
  assert.equal(out.outcome, 'done');
  const r = out.scope?.gen as { action: string } | undefined;
  assert.equal(r?.action, 'refused');
  assert.equal(battery, 0); // never spent
});

test('budget set + new SHA → the generation RUNS (reaches done)', async () => {
  let battery = 0;
  setHiveEvalGenDeps({
    currentCodeSha: () => 'sha-new',
    generationExists: async () => false,
    runBattery: async () => {
      battery += 1;
    },
  });
  const out = await run({ budgetUsd: 40 });
  assert.equal(out.outcome, 'done');
  const r = out.scope?.gen as { action: string; codeSha?: string; capUsd?: number } | undefined;
  assert.equal(r?.action, 'ran');
  assert.equal(r?.codeSha, 'sha-new');
  assert.equal(r?.capUsd, 40);
  assert.equal(battery, 1);
});

test('generation already measured at this SHA → SKIP (the replay/double-spend guard)', async () => {
  let battery = 0;
  setHiveEvalGenDeps({
    currentCodeSha: () => 'sha-seen',
    generationExists: async () => true, // already measured
    runBattery: async () => {
      battery += 1;
    },
  });
  const out = await run({ budgetUsd: 40 });
  assert.equal(out.outcome, 'done');
  const r = out.scope?.gen as { action: string } | undefined;
  assert.equal(r?.action, 'skipped');
  assert.equal(battery, 0); // dedupe guard → no second paid run
});
