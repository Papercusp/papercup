/**
 * run-topology-pipeline — END-TO-END integration: runTopology (the driver) → TaskRunResult rows →
 * buildCapabilityAttribution + buildFairnessAudit (the @papercusp/bench-metrics reporting layer).
 *
 * This is the seam that bench-metrics' own unit tests (which use HAND-CRAFTED rows) cannot cover: it
 * proves the C1 same-denominator fairness GUARANTEE holds on the driver's REAL output. A less-efficient
 * arm that the shared iso-budget forces to SKIP tasks emits NO rows for them; the reporting layer counts
 * those as `false` over the union — so the weaker arm is penalised, never flattered by exclusion (the
 * exact 2026-06-17 over-claim the standard exists to prevent). It also confirms the C4 `coordCalls`
 * evidence + the C3 cost/budget fields survive the driver→report round-trip. (benchmark-coordination-
 * topologies.)
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import { buildCapabilityAttribution, buildFairnessAudit } from '@papercusp/bench-metrics';
import { resolveCoordinationSpec, type CloneGradeSeam } from './coordination-topology';
import { runTopology, type AgentRunOutput, type RunAgentInput, type TopologyRowMeta } from './run-topology';
import type { BenchTask } from './types';

const ROW_META: TopologyRowMeta = {
  suite: 'swe-bench-pro', modelId: 'claude-opus-4-8[1m]', harnessVersion: 'test@sha',
  preregHash: 'p', rolloutId: 'r', graderFamily: 'swe-bench-pro', graderVersion: 'img@v1', priceTableVersion: 'price-table-v1',
};

const backlog = (n: number): BenchTask[] =>
  Array.from({ length: n }, (_, i) => ({ benchmark: 'swe-bench-pro', instanceId: `instance_o__o-${i}`, problemStatement: 'x', graderMeta: {} }));

const clock = (): (() => number) => { let t = 1_000_000; return () => (t += 1); };

interface H { cid: number; taskId: string; solved: boolean }

/** An arm's (seam, runAgent): `solvedFor(i)` decides resolved, `callsPer` drives iso-budget consumption,
 *  `coord` is the coordCalls each agent reports. The runAgent mutates handle.solved; grade reads it. */
function arm(opts: { solvedFor: (i: number) => boolean; callsPer: number; coord: number }) {
  let cid = 0;
  const seam: CloneGradeSeam<H> = {
    modality: 'diff',
    async clone(t) { return { cid: cid++, taskId: t.instanceId, solved: false }; },
    async grade(_t, h) { return { resolved: h.solved, score: null, graderStatus: h.solved ? 'passed' : 'failed' }; },
    async teardown() { /* no-op */ },
  };
  const runAgent = async (input: RunAgentInput<H>): Promise<AgentRunOutput> => {
    const i = Number(input.task.instanceId.split('-').pop());
    input.handle.solved = opts.solvedFor(i);
    return {
      submission: 'diff', status: 'completed', modelCalls: opts.callsPer,
      tokensIn: 100, tokensOut: 50, costUsd: 0.01 * opts.callsPer, turns: opts.callsPer, coordCalls: opts.coord,
    };
  };
  return { seam, runAgent };
}

/** Two arms over the SAME 6 tasks under the SAME iso-budget (maxModelCalls:12):
 *   - su-independent (control): 4 calls/task → finishes only 3 of 6 (budget exhausts), solves 2 of those; no coordination.
 *   - dist-broadcast (capability): 2 calls/task → finishes all 6, solves 5; coordinates (coordCalls:3/task). */
async function runBothArms() {
  const tasks = backlog(6);
  const budget = { maxModelCalls: 12 };
  const controlSpec = resolveCoordinationSpec({ id: 'su-independent', kind: 'harness', spine: {} });
  const distSpec = resolveCoordinationSpec(loadBuiltinBlueprint('dist-broadcast').blueprint);

  const ctl = arm({ solvedFor: (i) => i < 2, callsPer: 4, coord: 0 });
  const ctlRun = await runTopology<H>({ spec: controlSpec, backlog: tasks, seam: ctl.seam, budget, rowMeta: ROW_META, runId: 'pilot', seed: 1, now: clock(), runAgent: ctl.runAgent, cap: 1 });

  const dist = arm({ solvedFor: (i) => i < 5, callsPer: 2, coord: 3 });
  const distRun = await runTopology<H>({ spec: distSpec, backlog: tasks, seam: dist.seam, budget, rowMeta: ROW_META, runId: 'pilot', seed: 1, now: clock(), runAgent: dist.runAgent, cap: 1 });

  return { ctlRun, distRun, allRows: [...ctlRun.rows, ...distRun.rows] };
}

test('C1 end-to-end — iso-budget skips emit no row → buildCapabilityAttribution counts them false over the union', async () => {
  const { ctlRun, distRun, allRows } = await runBothArms();

  // Driver behavior: the less-efficient control skipped 3 tasks (no rows); the capability finished all 6.
  assert.equal(ctlRun.rows.length, 3, 'control finished only 3 of 6 within the iso-budget');
  assert.equal(ctlRun.skippedTaskIds.length, 3, 'the other 3 were skipped → NO row emitted');
  assert.equal(ctlRun.budgetExhausted, true);
  assert.equal(distRun.rows.length, 6, 'capability finished all 6');
  assert.equal(distRun.skippedTaskIds.length, 0);

  const attr = buildCapabilityAttribution(allRows, { control: 'su-independent', capabilityArms: ['dist-broadcast'], sameDenominator: true });
  const d = attr.capabilities[0];
  assert.equal(d.tasksCompared, 6, 'the union N = 6 — the skipped tasks ARE in the denominator');
  assert.ok(Math.abs(d.controlValue - 2 / 6) < 1e-9, `control scored 2/6 (1 fail + 3 skipped all count false): got ${d.controlValue}`);
  assert.ok(Math.abs(d.capabilityValue - 5 / 6) < 1e-9, `capability scored 5/6: got ${d.capabilityValue}`);
  assert.ok(d.valueDelta > 0.4, 'the capability lift is real BECAUSE the skipped tasks are penalised, not excluded');
});

test('C1 contrast — exclude-infra (sameDenominator:false) would FLATTER the weaker arm (why the default matters)', async () => {
  const { allRows } = await runBothArms();
  const fair = buildCapabilityAttribution(allRows, { control: 'su-independent', capabilityArms: ['dist-broadcast'], sameDenominator: true });
  const excl = buildCapabilityAttribution(allRows, { control: 'su-independent', capabilityArms: ['dist-broadcast'], sameDenominator: false });

  // exclude-infra scores the control over ONLY its 3 attempted (2/3 ≈ 0.67) — artificially higher than the
  // fair 2/6 ≈ 0.33. This is exactly the 2026-06-17 flatter-the-weaker-arm trap; the default guards against it.
  assert.ok(excl.capabilities[0].controlValue > fair.capabilities[0].controlValue + 0.2,
    `exclude-infra flatters the control (${excl.capabilities[0].controlValue} vs fair ${fair.capabilities[0].controlValue})`);
});

test('buildFairnessAudit runs on the driver output — coverage asymmetry + C4 coordination are visible', async () => {
  const { distRun, allRows } = await runBothArms();
  const audit = buildFairnessAudit(allRows, { referenceArm: 'mini-swe' });

  assert.equal(audit.unionTasks, 6, 'the run-wide task universe is the full backlog');
  const ctlSum = audit.perArm.find((a) => a.arm === 'su-independent')!;
  const distSum = audit.perArm.find((a) => a.arm === 'dist-broadcast')!;
  assert.equal(ctlSum.nonCompletedTasks, 3, 'the 3 budget-skipped tasks surface as non-completed (the C1/C6 penalty)');
  assert.equal(distSum.nonCompletedTasks, 0);
  // the C1 criterion is auto-filled and not a FAIL (both arms scored over the same union denominator).
  assert.notEqual(audit.criteria.find((c) => c.id === 'C1')!.status, 'FAIL');
  // C4 evidence survives the round-trip: the coordination arm's rows carry coordCalls > 0.
  assert.ok(distRun.rows.every((r) => (r.armMeta?.coordCalls as number) > 0), 'dist-broadcast coordinated (coordCalls > 0)');
});
