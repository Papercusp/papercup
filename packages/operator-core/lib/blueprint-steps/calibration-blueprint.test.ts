/**
 * calibration as a DETERMINISTIC blueprint (deterministic-blueprints-migration-2026-06-13,
 * ratified reclassified loop). Pure-SQL bet-resolution sweep, flag + governor gated. Proves
 * the built-in loads + validates as a gateless deterministic pipeline, `calibration:resolve`
 * is a registered known op, and the same flag + governor gates carry through (dark stays dark).
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import '../coord-ops/index.js';
import './index.js';
import { coordOpNames } from '../coord-ops/registry.js';
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner.js';
import { makeFakeCaps, makeCtx } from '../coord-ops/test-support.js';
import { setCalibrationResolveDeps } from './ops/calibration-resolve.js';

afterEach(() => setCalibrationResolveDeps(null));

const run = async () => {
  const { blueprint } = loadBuiltinBlueprint('calibration');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  return runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
};

test('the calibration blueprint loads + validates as a gateless deterministic pipeline', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('calibration');
  assert.equal(validation.ok, true, `validation errors: ${JSON.stringify(validation.errors)}`);
  assert.equal(blueprint.spine.steps?.length, 1);
  assert.equal(blueprint.spine.steps?.[0]?.op, 'calibration:resolve');
  assert.ok(!blueprint.spine.gate || blueprint.spine.gate.length === 0);
});

test('calibration:resolve is a registered known op', () => {
  assert.ok(coordOpNames().has('calibration:resolve'));
});

test('flag OFF → the deterministic step no-ops (dark stays dark)', async () => {
  setCalibrationResolveDeps({ flag: async () => false });
  const out = await run();
  assert.equal(out.outcome, 'done');
  const r = out.scope?.sweep as { ran: boolean; skipReason?: string } | undefined;
  assert.equal(r?.ran, false);
  assert.equal(r?.skipReason, 'flag-off');
});

test('governor refusal → the deterministic step no-ops (D-004)', async () => {
  setCalibrationResolveDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }),
  });
  const out = await run();
  assert.equal(out.outcome, 'done');
  const r = out.scope?.sweep as { ran: boolean; skipReason?: string; governorReason?: string } | undefined;
  assert.equal(r?.ran, false);
  assert.equal(r?.skipReason, 'governor-refused');
  assert.equal(r?.governorReason, 'unbudgeted');
});
