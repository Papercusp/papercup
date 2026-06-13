/**
 * P-120 (deterministic-blueprints-migration-2026-06-13) — the neologism miner as
 * a DETERMINISTIC blueprint, end-to-end through the program runner.
 *
 * Proves the deterministic step kind (P-010): the built-in blueprint loads +
 * validates as a GATELESS deterministic pipeline; `neologism:mine` is a
 * registered known op; a full `runProgramCore` run reaches a clean `done`; and
 * the op runs the SAME flag + governor gates as the bespoke routine (D-004 —
 * dark stays dark when the flag is off).
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import '../coord-ops/index.js';
import './index.js';
import { coordOpNames } from '../coord-ops/registry.js';
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner.js';
import { makeFakeCaps, makeCtx } from '../coord-ops/test-support.js';
import { setNeologismMineDeps } from './ops/neologism-mine.js';
import type { NeologismTickDeps } from '../neologism/scan.js';

afterEach(() => setNeologismMineDeps(null));

/** Tick deps that never touch PG/fs — a clean empty mine. */
function fakeTickDeps(): NeologismTickDeps {
  return {
    readRows: async () => [],
    readInsights: async () => [],
    readNamespaces: async () => [],
    capture: async () => ({ created: false, possibleDuplicates: [], reason: 'stub' }) as never,
    log: () => {},
  };
}

test('the neologism blueprint loads + validates as a gateless deterministic pipeline', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('neologism');
  assert.equal(validation.ok, true, `validation errors: ${JSON.stringify(validation.errors)}`);
  assert.equal(blueprint.spine.steps?.length, 1);
  assert.equal(blueprint.spine.steps?.[0]?.op, 'neologism:mine');
  // No gate ⇒ a deterministic pipeline (not a decision program).
  assert.ok(!blueprint.spine.gate || blueprint.spine.gate.length === 0);
});

test('neologism:mine is a registered known op (validator knownOps)', () => {
  assert.ok(coordOpNames().has('neologism:mine'));
});

test('running the blueprint program fires the gated miner and reaches a clean done', async () => {
  setNeologismMineDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: true, remainingUsd: 0 }),
    tickDeps: fakeTickDeps(),
  });
  const { blueprint } = loadBuiltinBlueprint('neologism');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  const out = await runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
  assert.equal(out.outcome, 'done');
  assert.equal(out.resolved, true);
  // The deterministic step ran and bound its typed result into the scope.
  const mine = out.scope?.mine as { ran: boolean; scannedRows?: number } | undefined;
  assert.equal(mine?.ran, true);
  assert.equal(mine?.scannedRows, 0);
});

test('flag OFF → the deterministic step no-ops (dark stays dark) but the pipeline still completes', async () => {
  setNeologismMineDeps({ flag: async () => false });
  const { blueprint } = loadBuiltinBlueprint('neologism');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  const out = await runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
  assert.equal(out.outcome, 'done');
  const mine = out.scope?.mine as { ran: boolean; skipReason?: string } | undefined;
  assert.equal(mine?.ran, false);
  assert.equal(mine?.skipReason, 'flag-off');
});

test('governor refusal → the deterministic step no-ops (D-004 unattended-refusal)', async () => {
  setNeologismMineDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }),
  });
  const { blueprint } = loadBuiltinBlueprint('neologism');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  const out = await runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
  assert.equal(out.outcome, 'done');
  const mine = out.scope?.mine as { ran: boolean; skipReason?: string; governorReason?: string } | undefined;
  assert.equal(mine?.ran, false);
  assert.equal(mine?.skipReason, 'governor-refused');
  assert.equal(mine?.governorReason, 'unbudgeted');
});

test('payload fire-bars + window reach the miner via declared op args', async () => {
  let seenWindow: number | undefined;
  const tickDeps = fakeTickDeps();
  tickDeps.readRows = async (_ws, windowDays) => {
    seenWindow = windowDays;
    return [];
  };
  setNeologismMineDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: true, remainingUsd: 0 }),
    tickDeps,
  });
  const { blueprint } = loadBuiltinBlueprint('neologism');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  const out = await runProgramCore({ blueprint, payload: { windowDays: 14 }, ctx, runOp: inlineRunOp });
  assert.equal(out.outcome, 'done');
  assert.equal(seenWindow, 14);
});
