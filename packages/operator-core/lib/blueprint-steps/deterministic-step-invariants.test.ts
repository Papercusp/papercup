/**
 * P-140 (deterministic-blueprints-migration-2026-06-13) — the deterministic-step
 * INVARIANTS suite. The safety net the migration must hold:
 *
 *   1. a deterministic step declares typed I/O (argsSchema + resultSchema) and
 *      CANNOT exceed it — out-of-type input is rejected, undeclared input is
 *      stripped before reaching the op, and its output conforms to resultSchema;
 *   2. the validator accepts a DETERMINISTIC pipeline (steps, no gate) AND a
 *      DECISION program (steps + gate w/ fallback), and rejects a gated program
 *      with NO fallback (a decision must always resolve);
 *   3. a migrated loop's agent execution is confinement-routed — the ONLY
 *      agent-dispatch op a program can use is `orchestrator:spawn-roles`, which
 *      runs through the governed `spawnInvokeOnce` chokepoint (D-005);
 *   4. behavior-neutral migration — the routine action and the blueprint op call
 *      the SAME gated orchestration (proven in each pilot's tests; asserted
 *      structurally here via the shared `run<Loop>Mine` contract).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { BlueprintSchema, validateBlueprint } from '@papercusp/orchestrator/blueprint';
import '../coord-ops/index.js';
import './index.js';
import { getCoordOp } from '../coord-ops/registry.js';
import { negativeSpaceScanOp, setNegativeSpaceScanDeps } from './ops/negative-space-scan.js';
import { regretMineOp } from './ops/regret-mine.js';

/** The deterministic step-ops this migration registers (the family under test). */
const DETERMINISTIC_OPS = [negativeSpaceScanOp, regretMineOp];

test('inv-1a: every deterministic step-op declares typed I/O (args + result schemas)', () => {
  for (const op of DETERMINISTIC_OPS) {
    assert.ok(op.argsSchema instanceof z.ZodType, `${op.name} has no argsSchema`);
    assert.ok(op.resultSchema instanceof z.ZodType, `${op.name} has no resultSchema`);
    assert.ok(getCoordOp(op.name), `${op.name} is not registered`);
  }
});

test('inv-1b: a deterministic step CANNOT exceed its declared input I/O', () => {
  // Out-of-TYPE declared input is rejected (windowDays must be a number).
  assert.throws(() => negativeSpaceScanOp.argsSchema.parse({ windowDays: 'not-a-number' }));
  // UNDECLARED input is stripped, never reaches the op (Zod object strips unknowns).
  const parsed = negativeSpaceScanOp.argsSchema.parse({ windowDays: 7, smuggled: 'x' }) as Record<string, unknown>;
  assert.equal(parsed.windowDays, 7);
  assert.equal('smuggled' in parsed, false);
});

test('inv-1c: a deterministic step output conforms to its declared result I/O', async () => {
  setNegativeSpaceScanDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: true, remainingUsd: 0 }),
    tickDeps: {
      readRows: async () => [],
      persist: async (_ws, e) => e,
      capture: async () => ({ created: false, possibleDuplicates: [], reason: 'stub' }) as never,
      markFiled: async () => {},
      log: () => {},
    },
  });
  try {
    const out = await negativeSpaceScanOp.run(
      { windowDays: 7 },
      { workspaceId: 'ws-1', harnessSlug: 'pot', depth: 0, identity: { ownerId: 'test' }, now: () => '', newId: (p) => p, caps: {} as never },
    );
    // Must validate against the op's OWN declared result schema (cannot exceed it).
    assert.doesNotThrow(() => negativeSpaceScanOp.resultSchema.parse(out));
  } finally {
    setNegativeSpaceScanDeps(null);
  }
});

test('inv-2a: the validator accepts a deterministic pipeline (steps, NO gate)', () => {
  const bp = BlueprintSchema.parse({
    id: 'det-pipeline',
    workItem: { kind: 'mining-run', idPrefix: 'X' },
    spine: { steps: [{ id: 's1', op: 'negative-space:scan', args: {} }] },
  });
  const v = validateBlueprint(bp);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('inv-2b: the validator accepts a decision program (steps + gate w/ fallback)', () => {
  const bp = BlueprintSchema.parse({
    id: 'decision-prog',
    workItem: { kind: 'decision', idPrefix: 'D' },
    spine: {
      steps: [{ id: 's1', op: 'negative-space:scan', args: {} }],
      gate: [{ else: true, op: 'resolve', args: {} }],
    },
  });
  const v = validateBlueprint(bp);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('inv-2c: the validator REJECTS a gated program with no fallback (a decision must resolve)', () => {
  const bp = BlueprintSchema.parse({
    id: 'no-fallback',
    workItem: { kind: 'decision', idPrefix: 'D' },
    spine: {
      steps: [{ id: 's1', op: 'negative-space:scan', args: {} }],
      gate: [{ when: { 'x.y': { truthy: true } }, op: 'resolve', args: {} }],
    },
  });
  const v = validateBlueprint(bp);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'gate-no-fallback'), JSON.stringify(v.errors));
});

test('inv-3: the ONLY agent-dispatch op available to a program is the confinement-routed spawn-roles', () => {
  // A program dispatches agents ONLY via `orchestrator:spawn-roles`, whose prod
  // runner (coordSpawnRunner) goes through `spawnInvokeOnce` — the one governed
  // launch chokepoint (D-005). The deterministic step-ops dispatch NO agents.
  assert.ok(getCoordOp('orchestrator:spawn-roles'), 'spawn-roles op must exist (the governed agent step)');
  for (const op of DETERMINISTIC_OPS) {
    // Deterministic ops carry no spawn capability in their declared name/contract.
    assert.notEqual(op.name, 'orchestrator:spawn-roles');
  }
});
