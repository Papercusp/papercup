/**
 * coordination-topology — the declarative→runtime bridge (resolveCoordinationSpec) maps each topology
 * BLUEPRINT to its CoordinationSpec. Pins that the shipped distributed blueprints + the central hive
 * resolve to the right topology config (benchmark-coordination-topologies).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import { resolveCoordinationSpec } from './coordination-topology';

test('resolveCoordinationSpec — distributed blueprints map to the right topology spec', () => {
  const bb = resolveCoordinationSpec(loadBuiltinBlueprint('dist-broadcast').blueprint);
  assert.equal(bb.arm, 'dist-broadcast');
  assert.equal(bb.claimModel, 'self-claim-fifo');
  assert.equal(bb.broadcast, 'topic');
  assert.equal(bb.review, 'none');
  assert.equal(bb.central, false, 'flat-distributed = no central Queen');

  const pr = resolveCoordinationSpec(loadBuiltinBlueprint('dist-peer-review').blueprint);
  assert.equal(pr.review, 'peer');

  const blk = resolveCoordinationSpec(loadBuiltinBlueprint('dist-blackboard').blueprint);
  assert.equal(blk.sharedState, 'blackboard');
  assert.deepEqual(blk.disciplineForbid, ['coord:send'], 'blackboard enforces no direct messaging');

  const hud = resolveCoordinationSpec(loadBuiltinBlueprint('dist-repo-huddle').blueprint);
  assert.equal(hud.team, 'per-repo');
  assert.equal(hud.claimModel, 'self-claim-priority');
  assert.equal(hud.review, 'peer');
});

test('resolveCoordinationSpec — per-task arms carry the aggregate field (ensemble vs pair)', () => {
  const ens = resolveCoordinationSpec(loadBuiltinBlueprint('ensemble-solve').blueprint);
  assert.equal(ens.team, 'per-task');
  assert.equal(ens.aggregate, 'judge-best', 'ensemble = N independent solvers → judge picks best');

  const pair = resolveCoordinationSpec(loadBuiltinBlueprint('pair').blueprint);
  assert.equal(pair.team, 'per-task');
  assert.equal(pair.aggregate, 'none', 'pair coordinates DURING, no after-the-fact aggregation');
  assert.equal(pair.review, 'peer');
});

test('resolveCoordinationSpec — the hive blueprint is the CENTRAL pole', () => {
  const hive = resolveCoordinationSpec(loadBuiltinBlueprint('hive').blueprint);
  assert.equal(hive.central, true, 'kind:hive ⇒ central Queen');
  assert.equal(hive.claimModel, 'decider-dispatch', 'central = decider-dispatch, not self-claim');
});

test('resolveCoordinationSpec — defaults (no coordination section) = central-pipeline behavior', () => {
  const spec = resolveCoordinationSpec({ id: 'x', kind: 'harness', spine: {} });
  assert.equal(spec.claimModel, 'decider-dispatch');
  assert.equal(spec.broadcast, 'none');
  assert.equal(spec.review, 'none');
  assert.equal(spec.sharedState, 'both');
  assert.equal(spec.team, 'per-backlog');
  assert.equal(spec.aggregate, 'none');
  assert.deepEqual(spec.disciplineForbid, []);
  assert.equal(spec.central, false);
});
