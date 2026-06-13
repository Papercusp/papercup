/**
 * P-121 (deterministic-blueprints-migration-2026-06-13) — the prompt-ablation cycle
 * as a DETERMINISTIC blueprint. Proves the built-in loads + validates as a gateless
 * deterministic pipeline, `prompt:ablation` is a registered known op, and the op
 * runs the SAME flag + governor gates as the bespoke routine (D-004 — dark stays
 * dark; governor refusal skips). (D-009: the baseline-vs-ablated arms are governed
 * replay llmCalls, not fleet spawns — a single deterministic step; never mutates a
 * live prompt.)
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import '../coord-ops/index.js';
import './index.js';
import { coordOpNames } from '../coord-ops/registry.js';
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner.js';
import { makeFakeCaps, makeCtx } from '../coord-ops/test-support.js';
import { setPromptAblationOpDeps } from './ops/prompt-ablation.js';

afterEach(() => setPromptAblationOpDeps(null));

const run = async () => {
  const { blueprint } = loadBuiltinBlueprint('prompt-ablation');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  return runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
};

test('the prompt-ablation blueprint loads + validates as a gateless deterministic pipeline', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('prompt-ablation');
  assert.equal(validation.ok, true, `validation errors: ${JSON.stringify(validation.errors)}`);
  assert.equal(blueprint.spine.steps?.length, 1);
  assert.equal(blueprint.spine.steps?.[0]?.op, 'prompt:ablation');
  assert.ok(!blueprint.spine.gate || blueprint.spine.gate.length === 0);
});

test('prompt:ablation is a registered known op', () => {
  assert.ok(coordOpNames().has('prompt:ablation'));
});

test('flag OFF → the deterministic step no-ops (dark stays dark)', async () => {
  setPromptAblationOpDeps({ flag: async () => false });
  const out = await run();
  assert.equal(out.outcome, 'done');
  const r = out.scope?.ablation as { ran: boolean; skipReason?: string } | undefined;
  assert.equal(r?.ran, false);
  assert.equal(r?.skipReason, 'flag-off');
});

test('governor refusal → the deterministic step no-ops (D-004)', async () => {
  setPromptAblationOpDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }),
  });
  const out = await run();
  assert.equal(out.outcome, 'done');
  const r = out.scope?.ablation as { ran: boolean; skipReason?: string; governorReason?: string } | undefined;
  assert.equal(r?.ran, false);
  assert.equal(r?.skipReason, 'governor-refused');
  assert.equal(r?.governorReason, 'unbudgeted');
});
