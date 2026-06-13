/**
 * P-121 (deterministic-blueprints-migration-2026-06-13) — Scout's autonomous-ideation
 * cadence as a DETERMINISTIC blueprint. Proves the built-in loads + validates as a
 * gateless deterministic pipeline, `scout:cycle` is a registered known op, and a full
 * `runProgramCore` run drives the self-gated tick to a clean `done`.
 *
 * Scout is NOT flag+governor-gated (D-009) — its gate is STRUCTURAL (cadence → fire-gate
 * → claim → budget, inside runScoutTick). Here a fake deps-builder makes the cadence
 * gate WITHHOLD cheaply (too-soon), so the cycle no-ops and the pipeline still completes
 * — the program-mode mechanism is the thing under test (the cycle's own behavior is
 * covered by scheduler.test.ts + scout-cycle-action.test.ts).
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import '../coord-ops/index.js';
import './index.js';
import { coordOpNames } from '../coord-ops/registry.js';
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner.js';
import { makeFakeCaps, makeCtx } from '../coord-ops/test-support.js';
import { setScoutCycleDeps } from './ops/scout-cycle.js';
import type { ScoutTickDepsBuilder } from '../scout/run.js';

const NOW = Date.parse('2026-06-13T12:00:00Z');

/** A deps-builder whose cadence gate withholds (idle 0 + ran 1 min ago vs a 1h floor). */
const withholdBuilder: ScoutTickDepsBuilder = (depsCtx, runCycle) => ({
  readCadenceState: async () => ({ idleRatio: 0, frictionSignals: 0, lastRunAtMs: NOW - 60_000, nowMs: NOW }),
  runCycle: async ({ budget, cycleId }) =>
    runCycle({ harnessSlug: depsCtx.installSlug, workspaceId: depsCtx.workspaceId, budget, cycleId }),
  persistRouted: async () => {},
  recordFire: async () => {},
  refreshOutcomes: async () => {},
  newCycleId: () => 'cyc-test',
});

afterEach(() => setScoutCycleDeps(null));

test('the scout blueprint loads + validates as a gateless deterministic pipeline', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('scout');
  assert.equal(validation.ok, true, `validation errors: ${JSON.stringify(validation.errors)}`);
  assert.equal(blueprint.spine.steps?.length, 1);
  assert.equal(blueprint.spine.steps?.[0]?.op, 'scout:cycle');
  assert.ok(!blueprint.spine.gate || blueprint.spine.gate.length === 0);
});

test('scout:cycle is a registered known op', () => {
  assert.ok(coordOpNames().has('scout:cycle'));
});

test('running the blueprint program drives the self-gated tick to a clean done (cadence withhold)', async () => {
  let cycleRan = 0;
  setScoutCycleDeps({
    runCycle: async () => {
      cycleRan += 1;
      return { provenance: [] };
    },
    buildDeps: withholdBuilder,
    // no recordGovernor ⇒ hermetic (no governor IO)
  });
  const { blueprint } = loadBuiltinBlueprint('scout');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  const out = await runProgramCore({
    blueprint,
    payload: { cadence: { minIntervalSec: 3600 } },
    ctx,
    runOp: inlineRunOp,
  });
  assert.equal(out.outcome, 'done');
  assert.equal(out.resolved, true);
  const r = out.scope?.cycle as { fired: boolean } | undefined;
  assert.equal(r?.fired, false); // cadence withheld → no cycle
  assert.equal(cycleRan, 0); // the (expensive) cycle never ran
});
