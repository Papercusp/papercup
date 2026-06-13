/**
 * P-120 (deterministic-blueprints-migration-2026-06-13) — the Fleet EKG as a
 * DETERMINISTIC blueprint, end-to-end through the program runner.
 *
 * Proves the deterministic step kind (P-010): the built-in blueprint loads +
 * validates as a GATELESS deterministic pipeline; `fleet-ekg:scan` is a
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
import { setFleetEkgScanDeps } from './ops/fleet-ekg-scan.js';
import type { FleetEkgTickDeps } from '../fleet-ekg/scan.js';

afterEach(() => setFleetEkgScanDeps(null));

const FIXED_NOW_MS = 1_750_000_000_000;

/** Tick deps that never touch PG — a clean empty scan. */
function fakeTickDeps(): FleetEkgTickDeps {
  return {
    readSessions: async () => [],
    persistVectors: async () => {},
    readCohort: async () => [],
    readLedger: async () => [],
    persistShifts: async () => [],
    alarm: async () => {},
    markNotified: async () => {},
    nowMs: () => FIXED_NOW_MS,
    log: () => {},
  };
}

test('the fleet-ekg blueprint loads + validates as a gateless deterministic pipeline', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('fleet-ekg');
  assert.equal(validation.ok, true, `validation errors: ${JSON.stringify(validation.errors)}`);
  assert.equal(blueprint.spine.steps?.length, 1);
  assert.equal(blueprint.spine.steps?.[0]?.op, 'fleet-ekg:scan');
  // No gate ⇒ a deterministic pipeline (not a decision program).
  assert.ok(!blueprint.spine.gate || blueprint.spine.gate.length === 0);
});

test('fleet-ekg:scan is a registered known op (validator knownOps)', () => {
  assert.ok(coordOpNames().has('fleet-ekg:scan'));
});

test('running the blueprint program fires the gated scan and reaches a clean done', async () => {
  setFleetEkgScanDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: true, remainingUsd: 0 }),
    tickDeps: fakeTickDeps(),
  });
  const { blueprint } = loadBuiltinBlueprint('fleet-ekg');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  const out = await runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
  assert.equal(out.outcome, 'done');
  assert.equal(out.resolved, true);
  // The deterministic step ran and bound its typed result into the scope.
  const scan = out.scope?.scan as { ran: boolean; embedded?: number } | undefined;
  assert.equal(scan?.ran, true);
  assert.equal(scan?.embedded, 0);
});

test('flag OFF → the deterministic step no-ops (dark stays dark) but the pipeline still completes', async () => {
  setFleetEkgScanDeps({ flag: async () => false });
  const { blueprint } = loadBuiltinBlueprint('fleet-ekg');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  const out = await runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
  assert.equal(out.outcome, 'done');
  const scan = out.scope?.scan as { ran: boolean; skipReason?: string } | undefined;
  assert.equal(scan?.ran, false);
  assert.equal(scan?.skipReason, 'flag-off');
});

test('governor refusal → the deterministic step no-ops (D-004 unattended-refusal)', async () => {
  setFleetEkgScanDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }),
  });
  const { blueprint } = loadBuiltinBlueprint('fleet-ekg');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  const out = await runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
  assert.equal(out.outcome, 'done');
  const scan = out.scope?.scan as { ran: boolean; skipReason?: string; governorReason?: string } | undefined;
  assert.equal(scan?.ran, false);
  assert.equal(scan?.skipReason, 'governor-refused');
  assert.equal(scan?.governorReason, 'unbudgeted');
});

test('payload windows reach the scan via declared op args', async () => {
  let seenSinceMs: number | undefined;
  const tickDeps = fakeTickDeps();
  tickDeps.readSessions = async (_ws, sinceMs) => {
    seenSinceMs = sinceMs;
    return [];
  };
  setFleetEkgScanDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: true, remainingUsd: 0 }),
    tickDeps,
  });
  const { blueprint } = loadBuiltinBlueprint('fleet-ekg');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  const out = await runProgramCore({ blueprint, payload: { embedDays: 10 }, ctx, runOp: inlineRunOp });
  assert.equal(out.outcome, 'done');
  // embedDays:10 → readSessions called sinceMs = now - 10d.
  assert.equal(FIXED_NOW_MS - (seenSinceMs ?? 0), 10 * 86_400_000);
});
