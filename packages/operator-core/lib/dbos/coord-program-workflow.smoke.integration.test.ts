/**
 * Boot-path smoke: the coord-program durable workflow + the spawn-runner + the
 * prod caps must IMPORT cleanly (they load at DBOS boot via bootstrap.ts). This
 * catches a missing export / bad import before a restart would fail the launch.
 * It does NOT launch DBOS — only asserts the module-level registration + exports
 * resolve (DBOS.registerWorkflow / new WorkflowQueue at import are launch-safe,
 * same as orchestrator-workflow.ts).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

test('coord-program-workflow imports + exports the durable surface', async () => {
  const mod = await import('./coord-program-workflow.js');
  assert.equal(typeof mod.startCoordProgram, 'function');
  assert.equal(typeof mod.startCoordProgramForEvent, 'function');
  assert.equal(typeof mod.setCoordProgramBlueprintResolver, 'function');
  assert.ok(mod.coordProgramWorkflow, 'workflow registered');
  assert.ok(mod.coordProgramQueue, 'queue constructed');
});

test('coord-spawn-runner imports + exposes the wiring fn', async () => {
  const mod = await import('./coord-spawn-runner.js');
  assert.equal(typeof mod.wireCoordSpawnRunner, 'function');
});

test('prod-caps imports + builds a ctx (no PG touched at build time)', async () => {
  const { buildCoordOpCtx, setCoordSpawnRunner } = await import('../coord-ops/prod-caps.js');
  assert.equal(typeof setCoordSpawnRunner, 'function');
  const ctx = buildCoordOpCtx({ identity: { ownerId: 'o' }, depth: 0 });
  assert.equal(ctx.depth, 0);
  assert.equal(typeof ctx.caps.openThread, 'function');
  assert.equal(typeof ctx.caps.runProgram, 'function');
});
