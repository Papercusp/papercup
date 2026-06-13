/**
 * P-122 (deterministic-blueprints-migration-2026-06-13) — the red-queen
 * vaccination cadence as a DETERMINISTIC blueprint, end-to-end through the
 * program runner. Proves: the built-in blueprint loads + validates as a gateless
 * deterministic pipeline; `red-queen:drill` is a registered known op; a full
 * `runProgramCore` run reaches a clean `done` and the SANDBOX drill cycle runs
 * (expire sweep observed) behind the SAME flag + governor gates (D-004 — dark
 * stays dark; governor refusal skips).
 */
import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import '../coord-ops/index.js';
import './index.js';
import { coordOpNames } from '../coord-ops/registry.js';
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner.js';
import { makeFakeCaps, makeCtx } from '../coord-ops/test-support.js';
import { setRedQueenDrillDeps } from './ops/red-queen-drill.js';
import type { DrillCycleDeps } from '../red-queen/sandbox.js';
import type { Sql } from 'postgres';

afterEach(() => setRedQueenDrillDeps(null));

/** Fake drill-cycle deps that never touch PG — an idle (skipped) cycle. */
function fakeCycleDeps(): { deps: DrillCycleDeps; expireStale: ReturnType<typeof vi.fn> } {
  const expireStale = vi.fn(async () => 0);
  const deps = {
    sql: (() => Promise.resolve([])) as unknown as Sql,
    liveWorkspaceId: 'ws-1',
    runTick: vi.fn(async () => ({ status: 'skipped' })),
    getIssue: vi.fn(async () => null),
    readItems: vi.fn(async () => []),
    applyTriage: vi.fn(async () => ({ ok: false, id: 'x' })),
    resolve: vi.fn(async () => ({ ok: false, id: 'x' })),
    store: {
      insert: vi.fn(async () => ({ drillId: 'd', plantedAt: 'x' })),
      detected: vi.fn(async () => {}),
      triaged: vi.fn(async () => {}),
      resolved: vi.fn(async () => {}),
      failed: vi.fn(async () => {}),
      expireStale,
      readOutcomes: vi.fn(async () => []),
    },
    now: () => 0,
    log: () => {},
  } as unknown as DrillCycleDeps;
  return { deps, expireStale };
}

test('the red-queen blueprint loads + validates as a gateless deterministic pipeline', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('red-queen');
  assert.equal(validation.ok, true, `validation errors: ${JSON.stringify(validation.errors)}`);
  assert.equal(blueprint.spine.steps?.length, 1);
  assert.equal(blueprint.spine.steps?.[0]?.op, 'red-queen:drill');
  assert.ok(!blueprint.spine.gate || blueprint.spine.gate.length === 0);
});

test('red-queen:drill is a registered known op', () => {
  assert.ok(coordOpNames().has('red-queen:drill'));
});

test('running the blueprint program runs the gated drill cycle and reaches done', async () => {
  const { deps, expireStale } = fakeCycleDeps();
  setRedQueenDrillDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: true, remainingUsd: 0 }),
    cycleDeps: deps,
  });
  const { blueprint } = loadBuiltinBlueprint('red-queen');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  const out = await runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
  assert.equal(out.outcome, 'done');
  assert.equal(out.resolved, true);
  assert.ok(expireStale.mock.calls.length > 0); // the drill cycle ran (expire sweep)
  const r = out.scope?.drill as { ran: boolean } | undefined;
  assert.equal(r?.ran, true);
});

test('flag OFF → the deterministic step no-ops (dark stays dark)', async () => {
  const { deps, expireStale } = fakeCycleDeps();
  setRedQueenDrillDeps({ flag: async () => false, cycleDeps: deps });
  const { blueprint } = loadBuiltinBlueprint('red-queen');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  const out = await runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
  assert.equal(out.outcome, 'done');
  assert.equal(expireStale.mock.calls.length, 0); // no drill ran
  const r = out.scope?.drill as { ran: boolean; skipReason?: string } | undefined;
  assert.equal(r?.ran, false);
  assert.equal(r?.skipReason, 'flag-off');
});

test('governor refusal → the deterministic step no-ops (D-004)', async () => {
  const { deps, expireStale } = fakeCycleDeps();
  setRedQueenDrillDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }),
    cycleDeps: deps,
  });
  const { blueprint } = loadBuiltinBlueprint('red-queen');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  const out = await runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
  assert.equal(out.outcome, 'done');
  assert.equal(expireStale.mock.calls.length, 0);
  const r = out.scope?.drill as { ran: boolean; skipReason?: string } | undefined;
  assert.equal(r?.skipReason, 'governor-refused');
});
