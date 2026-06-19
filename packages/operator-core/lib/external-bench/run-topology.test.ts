/**
 * run-topology — the coordination-topology RUN DRIVER. Tests the full chain real blueprint →
 * resolveCoordinationSpec → runTopology with a FAKE seam + a FAKE runAgent (no fleet/PG/docker), so the
 * orchestration logic (per-topology fan-out, iso-budget gating, TaskRunResult emission, C1 same-
 * denominator) is unit-verified. (benchmark-coordination-topologies.)
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import { resolveCoordinationSpec } from './coordination-topology';
import type { CloneGradeSeam } from './coordination-topology';
import { runTopology, type AgentRunOutput, type RunAgentInput, type TopologyRowMeta } from './run-topology';
import type { BenchTask } from './types';

const ROW_META: TopologyRowMeta = {
  suite: 'swe-bench-pro',
  modelId: 'claude-opus-4-8[1m]',
  harnessVersion: 'test@sha',
  preregHash: 'prereg-abc',
  rolloutId: 'rollout-1',
  graderFamily: 'swe-bench-pro',
  graderVersion: 'image@v1',
  priceTableVersion: 'price-table-v1',
};

function task(id: string): BenchTask {
  return { benchmark: 'swe-bench-pro', instanceId: id, problemStatement: `solve ${id}`, graderMeta: {} };
}

/** A clock that advances 1ms per read (so wallClockMs is positive + deterministic). */
function fakeClock(): () => number {
  let t = 1_000;
  return () => (t += 1);
}

interface FakeHandle { cid: number; taskId: string }

/** A fake seam recording clone/grade/teardown calls; `failClonesFor` throws on those instanceIds. */
function fakeSeam(opts: { failClonesFor?: Set<string> } = {}) {
  const cloned: FakeHandle[] = [];
  const graded: FakeHandle[] = [];
  const tornDown: FakeHandle[] = [];
  let cid = 0;
  const seam: CloneGradeSeam<FakeHandle> = {
    modality: 'diff',
    async clone(t) {
      if (opts.failClonesFor?.has(t.instanceId)) throw new Error('docker build failed');
      const h = { cid: cid++, taskId: t.instanceId };
      cloned.push(h);
      return h;
    },
    async grade(_t, h) {
      graded.push(h);
      return { resolved: true, score: null, graderStatus: 'passed' };
    },
    async teardown(h) {
      tornDown.push(h);
    },
  };
  return { seam, cloned, graded, tornDown };
}

/** A fake runAgent: 1 model-call per attempt, completed, submission tagged by role; judge picks index 1. */
function fakeAgent(overrides: Partial<AgentRunOutput> = {}) {
  const calls: RunAgentInput<FakeHandle>[] = [];
  const run = async (input: RunAgentInput<FakeHandle>): Promise<AgentRunOutput> => {
    calls.push(input);
    const base: AgentRunOutput = {
      submission: `${input.role}:${input.task.instanceId}`,
      status: 'completed',
      modelCalls: 1,
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.01,
      turns: 3,
      coordCalls: 2, // C4 evidence: each agent made 2 coordination tool calls (the topology WAS exercised)
    };
    if (input.role === 'judge') return { ...base, pickIndex: 1, ...overrides };
    return { ...base, ...overrides };
  };
  return { run, calls };
}

test('distributed arm (dist-broadcast) — one worker per task, rows carry seam grade + summed usage', async () => {
  const spec = resolveCoordinationSpec(loadBuiltinBlueprint('dist-broadcast').blueprint);
  const { seam, cloned, graded, tornDown } = fakeSeam();
  const { run, calls } = fakeAgent();
  const backlog = [task('instance_a__a-1'), task('instance_b__b-2'), task('instance_c__c-3')];

  const res = await runTopology<FakeHandle>({
    spec, backlog, seam, budget: { maxModelCalls: 100 }, rowMeta: ROW_META,
    runId: 'r1', seed: 1, now: fakeClock(), runAgent: run, cap: 2,
  });

  assert.equal(res.rows.length, 3, 'one row per task');
  assert.equal(res.skippedTaskIds.length, 0, 'budget ample → nothing skipped');
  assert.equal(res.modelCallsSpent, 3, 'one worker call per task');
  assert.equal(cloned.length, 3);
  assert.equal(graded.length, 3);
  assert.equal(tornDown.length, 3, 'every clone torn down');
  assert.ok(calls.every((c) => c.role === 'worker'), 'distributed = plain workers');
  for (const r of res.rows) {
    assert.equal(r.arm, 'dist-broadcast');
    assert.equal(r.resolved, true);
    assert.equal(r.generationStatus, 'completed');
    assert.equal(r.modality, 'diff');
    assert.equal(r.tokensTotal, 150);
    assert.equal(r.turns, 3);
    assert.equal(r.suite, 'swe-bench-pro');
    assert.equal(r.modelId, 'claude-opus-4-8[1m]');
    assert.ok(r.wallClockMs > 0);
    assert.equal(typeof r.createdAt, 'string');
    assert.equal(r.armMeta?.coordCalls, 2, 'C4 evidence: the worker actually coordinated');
  }
  // the worker directive (self-claim + broadcast to topic) was injected.
  assert.match(calls[0].directive, /DISTRIBUTED team/);
  assert.match(calls[0].topic, /^bench:dist-broadcast:/);
});

test('iso-budget is a hard ceiling — over-budget tasks get NO row (C1: counted false at report)', async () => {
  const spec = resolveCoordinationSpec(loadBuiltinBlueprint('dist-broadcast').blueprint);
  const { seam } = fakeSeam();
  const { run } = fakeAgent();
  const backlog = [1, 2, 3, 4, 5].map((n) => task(`instance_x__x-${n}`));

  // cap:1 → deterministic: unit0 runs (calls→1), unit1 runs (1<2) (calls→2), units 2-4 see exhausted.
  const res = await runTopology<FakeHandle>({
    spec, backlog, seam, budget: { maxModelCalls: 2 }, rowMeta: ROW_META,
    runId: 'r2', seed: 1, now: fakeClock(), runAgent: run, cap: 1,
  });

  assert.equal(res.rows.length, 2, 'only 2 tasks fit the 2-call budget');
  assert.equal(res.skippedTaskIds.length, 3, 'remaining 3 skipped → no row emitted');
  assert.equal(res.budgetExhausted, true);
  assert.equal(res.modelCallsSpent, 2);
  // CRITICAL fairness: skipped tasks are NOT emitted as rows (buildCapabilityAttribution counts a
  // task with no row as false under same-denominator — the un-flattered C1 treatment).
  const emittedIds = new Set(res.rows.map((r) => r.taskId));
  for (const id of res.skippedTaskIds) assert.ok(!emittedIds.has(id));
});

test('ensemble (ensemble-solve) — N solvers + judge; judge pick is the graded environment', async () => {
  const spec = resolveCoordinationSpec(loadBuiltinBlueprint('ensemble-solve').blueprint);
  assert.equal(spec.aggregate, 'judge-best');
  const { seam, cloned, graded, tornDown } = fakeSeam();
  const { run, calls } = fakeAgent();
  const backlog = [task('instance_e__e-1')];

  const res = await runTopology<FakeHandle>({
    spec, backlog, seam, budget: { maxModelCalls: 100 }, rowMeta: ROW_META,
    runId: 'r3', seed: 1, now: fakeClock(), runAgent: run, cap: 1, ensembleSize: 3,
  });

  assert.equal(res.rows.length, 1, 'ensemble = one ROW per task (the judged result)');
  assert.equal(cloned.length, 3, 'one independent clone per solver');
  assert.equal(tornDown.length, 3, 'all solver clones torn down');
  const solverCalls = calls.filter((c) => c.role === 'solver');
  const judgeCalls = calls.filter((c) => c.role === 'judge');
  assert.equal(solverCalls.length, 3);
  assert.equal(judgeCalls.length, 1);
  assert.equal(res.modelCallsSpent, 4, '3 solvers + 1 judge');
  // The judge picked index 1 → the SECOND solver's clone (cid 1) is what got graded.
  assert.equal(graded.length, 1);
  assert.equal(graded[0].cid, 1, 'graded the judge-picked solver environment');
  const row = res.rows[0];
  assert.equal(row.resolved, true);
  // coordCalls summed across 3 solvers + 1 judge (4 agents × 2 = 8) — C4 evidence the ensemble ran.
  assert.deepEqual(row.armMeta, { ensembleSize: 3, solvers: 3, candidates: 3, pickIndex: 1, coordCalls: 8 });
});

test('pair (pair) — driver + navigator on one clone, usage summed, one graded attempt', async () => {
  const spec = resolveCoordinationSpec(loadBuiltinBlueprint('pair').blueprint);
  assert.equal(spec.team, 'per-task');
  assert.equal(spec.aggregate, 'none');
  const { seam, cloned, graded } = fakeSeam();
  const { run, calls } = fakeAgent();
  const backlog = [task('instance_p__p-1')];

  const res = await runTopology<FakeHandle>({
    spec, backlog, seam, budget: { maxModelCalls: 100 }, rowMeta: ROW_META,
    runId: 'r4', seed: 1, now: fakeClock(), runAgent: run, cap: 1,
  });

  assert.equal(res.rows.length, 1);
  assert.equal(cloned.length, 1, 'pair collaborates on ONE clone');
  assert.equal(graded.length, 1);
  assert.deepEqual(calls.map((c) => c.role), ['driver', 'navigator']);
  assert.equal(res.modelCallsSpent, 2, 'driver + navigator');
  assert.equal(res.rows[0].tokensTotal, 300, 'usage summed across both agents');
  assert.deepEqual(res.rows[0].armMeta, { pair: true, coordCalls: 4 });
  // the navigator was handed the driver's submission to review.
  assert.deepEqual(calls[1].candidates, [{ index: 0, submission: 'driver:instance_p__p-1' }]);
});

test('clone failure → an infra-error row (resolved null, generationStatus error), teardown never throws', async () => {
  const spec = resolveCoordinationSpec(loadBuiltinBlueprint('dist-broadcast').blueprint);
  const { seam, tornDown } = fakeSeam({ failClonesFor: new Set(['instance_f__f-1']) });
  const { run } = fakeAgent();
  const backlog = [task('instance_ok__ok-1'), task('instance_f__f-1')];

  const res = await runTopology<FakeHandle>({
    spec, backlog, seam, budget: { maxModelCalls: 100 }, rowMeta: ROW_META,
    runId: 'r5', seed: 1, now: fakeClock(), runAgent: run, cap: 1,
  });

  assert.equal(res.rows.length, 2, 'both tasks attempted (clone-fail still emits a row)');
  const failed = res.rows.find((r) => r.taskId === 'instance_f__f-1')!;
  assert.equal(failed.resolved, null, 'null ≠ false — infra failure excluded from accuracy');
  assert.equal(failed.generationStatus, 'error');
  assert.match(failed.generationError ?? '', /clone/);
  const ok = res.rows.find((r) => r.taskId === 'instance_ok__ok-1')!;
  assert.equal(ok.resolved, true);
  assert.equal(tornDown.length, 1, 'only the successful clone is torn down (the failed one has no handle)');
});

test('C4 evidence — a coordination arm whose agents never coordinated reports coordCalls:0 (audit can flag)', async () => {
  // The trap: a "dist-broadcast" delta is meaningless if the agents never actually broadcast. The driver
  // surfaces armMeta.coordCalls so buildFairnessAudit can mark such an arm C4 NEEDS-EVIDENCE.
  const spec = resolveCoordinationSpec(loadBuiltinBlueprint('dist-broadcast').blueprint);
  const { seam } = fakeSeam();
  const { run } = fakeAgent({ coordCalls: 0 }); // agents ran but made ZERO coordination calls
  const backlog = [task('instance_z__z-1'), task('instance_z__z-2')];

  const res = await runTopology<FakeHandle>({
    spec, backlog, seam, budget: { maxModelCalls: 100 }, rowMeta: ROW_META,
    runId: 'r7', seed: 1, now: fakeClock(), runAgent: run, cap: 2,
  });

  assert.ok(res.rows.every((r) => r.armMeta?.coordCalls === 0), 'a non-coordinating run is visible as coordCalls:0');
});

test('central pole (hive) resolves to plain workers with an empty coordination directive', async () => {
  const spec = resolveCoordinationSpec(loadBuiltinBlueprint('coding').blueprint);
  assert.equal(spec.central, true);
  const { seam } = fakeSeam();
  const { run, calls } = fakeAgent();
  const backlog = [task('instance_h__h-1'), task('instance_h__h-2')];

  const res = await runTopology<FakeHandle>({
    spec, backlog, seam, budget: { maxModelCalls: 100 }, rowMeta: ROW_META,
    runId: 'r6', seed: 1, now: fakeClock(), runAgent: run, cap: 2,
  });

  assert.equal(res.rows.length, 2);
  assert.ok(calls.every((c) => c.role === 'worker'));
  assert.equal(calls[0].directive, '', 'central arm: the Queen coordinates; the worker directive is empty');
});

test('hierarchical (hier-lead-worker) — a lead coordination pass runs first, then workers; lead charged to budget', async () => {
  const spec = resolveCoordinationSpec(loadBuiltinBlueprint('hier-lead-worker').blueprint);
  assert.equal(spec.coordinator, 'elected-lead');
  const { seam, cloned, tornDown } = fakeSeam();
  const { run, calls } = fakeAgent();
  const backlog = [task('instance_h__h-1'), task('instance_h__h-2'), task('instance_h__h-3')];

  const res = await runTopology<FakeHandle>({
    spec, backlog, seam, budget: { maxModelCalls: 100 }, rowMeta: ROW_META,
    runId: 'rh', seed: 1, now: fakeClock(), runAgent: run, cap: 2,
  });

  assert.equal(calls.filter((c) => c.role === 'lead').length, 1, 'exactly one lead coordination pass');
  assert.equal(calls.filter((c) => c.role === 'worker').length, 3, 'one worker per task');
  assert.equal(res.rows.length, 3);
  assert.equal(res.modelCallsSpent, 4, '1 lead + 3 workers — the lead overhead is charged to the iso-budget');
  const lead = calls.find((c) => c.role === 'lead')!;
  assert.equal(lead.candidates?.length, 3, 'the lead sees all 3 team tasks');
  assert.match(lead.directive, /LEAD/);
  // C4 evidence: every team row carries the lead's coordination count.
  assert.ok(res.rows.every((r) => r.armMeta?.leadCoordCalls === 2), 'leadCoordCalls attached to the team rows');
  assert.equal(cloned.length, 4, 'lead clone + 3 worker clones');
  assert.equal(tornDown.length, 4, 'all clones (incl. the lead pass) torn down');
});

test('hierarchical — the lead overhead consumes iso-budget, so fewer worker tasks fit (C3 fair cost)', async () => {
  const spec = resolveCoordinationSpec(loadBuiltinBlueprint('hier-lead-worker').blueprint);
  const { seam } = fakeSeam();
  const { run } = fakeAgent();
  const backlog = [1, 2, 3, 4].map((n) => task(`instance_h__h-${n}`));

  // budget 3 calls: 1 lead + 2 workers fit; the other 2 tasks are budget-skipped (no row → counted false).
  const res = await runTopology<FakeHandle>({
    spec, backlog, seam, budget: { maxModelCalls: 3 }, rowMeta: ROW_META,
    runId: 'rh2', seed: 1, now: fakeClock(), runAgent: run, cap: 1,
  });

  assert.equal(res.modelCallsSpent, 3, '1 lead + 2 workers = the iso-budget');
  assert.equal(res.rows.length, 2, 'only 2 worker tasks fit AFTER the lead coordination overhead');
  assert.equal(res.skippedTaskIds.length, 2, 'the coordination cost is paid in fewer completed tasks (C3)');
  assert.equal(res.budgetExhausted, true);
});
