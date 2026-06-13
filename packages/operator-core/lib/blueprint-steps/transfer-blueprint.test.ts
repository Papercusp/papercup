/**
 * P-121 (deterministic-blueprints-migration-2026-06-13) — the transfer harness as a
 * DETERMINISTIC blueprint. Proves the built-in loads + validates as a gateless
 * deterministic pipeline, `transfer:distill` is a registered known op, and the op
 * runs the SAME flag + governor gates as the bespoke routine (D-004 — dark stays
 * dark; governor refusal skips). (D-009: transfer's student-transfer test is a
 * governed replay llmCall, not a fleet spawn — a single deterministic step.)
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import '../coord-ops/index.js';
import './index.js';
import { coordOpNames } from '../coord-ops/registry.js';
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner.js';
import { makeFakeCaps, makeCtx } from '../coord-ops/test-support.js';
import { setTransferDistillDeps } from './ops/transfer-distill.js';

afterEach(() => setTransferDistillDeps(null));

const run = async () => {
  const { blueprint } = loadBuiltinBlueprint('transfer');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  return runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
};

test('the transfer blueprint loads + validates as a gateless deterministic pipeline', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('transfer');
  assert.equal(validation.ok, true, `validation errors: ${JSON.stringify(validation.errors)}`);
  assert.equal(blueprint.spine.steps?.length, 1);
  assert.equal(blueprint.spine.steps?.[0]?.op, 'transfer:distill');
  assert.ok(!blueprint.spine.gate || blueprint.spine.gate.length === 0);
});

test('transfer:distill is a registered known op', () => {
  assert.ok(coordOpNames().has('transfer:distill'));
});

test('flag OFF → the deterministic step no-ops (dark stays dark)', async () => {
  setTransferDistillDeps({ flag: async () => false });
  const out = await run();
  assert.equal(out.outcome, 'done');
  const r = out.scope?.transfer as { ran: boolean; skipReason?: string } | undefined;
  assert.equal(r?.ran, false);
  assert.equal(r?.skipReason, 'flag-off');
});

test('governor refusal → the deterministic step no-ops (D-004)', async () => {
  setTransferDistillDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }),
  });
  const out = await run();
  assert.equal(out.outcome, 'done');
  const r = out.scope?.transfer as { ran: boolean; skipReason?: string; governorReason?: string } | undefined;
  assert.equal(r?.ran, false);
  assert.equal(r?.skipReason, 'governor-refused');
  assert.equal(r?.governorReason, 'unbudgeted');
});
