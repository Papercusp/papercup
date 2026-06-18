/**
 * P-002/P-003/P-005 (worker-chunk-loop-operator-hosted-2026-06-14) — the coding
 * worker chunk-loop as a DETERMINISTIC blueprint, end-to-end through the program
 * runner.
 *
 * Proves: the built-in `worker` blueprint loads + validates as a GATELESS
 * deterministic pipeline; `worker:chunk-loop` is a registered known op; a full
 * `runProgramCore` run reaches a clean `done` for EACH `ChunkLoopOutcome` variant
 * with the outcome faithfully mapped into the bound result (outcome-shape parity
 * with the subprocess path); and `payload.featureId` reaches the op.
 *
 * The loop EXECUTION (multi-chunk all-pass / replan / escalate; crash-recovery
 * resume) is the SHIPPED `runChunkLoopCore`, covered by the orchestrator package's
 * `worker-chunk-loop.test.ts` + `.recovery.test.ts` (the op calls
 * `runWorkerChunkLoop` → `runChunkLoopCore` verbatim). Here we inject a fake
 * `runLoop` so the op's mapping + program integration are unit-testable without
 * agents / PG / a repo (the real ctx-construction runner is dark-launch-validated,
 * D-005).
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import type { ChunkLoopOutcome } from '@papercusp/orchestrator';
import '../coord-ops/index.js';
import './index.js';
import { coordOpNames } from '../coord-ops/registry.js';
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner.js';
import { makeFakeCaps, makeCtx } from '../coord-ops/test-support.js';
import { setWorkerChunkLoopOpDeps } from './ops/worker-chunk-loop.js';

afterEach(() => setWorkerChunkLoopOpDeps(null));

/** Run the worker program with an injected loop outcome (or loop fn) + payload. */
async function runWorkerProgram(
  runLoop: (featureId: string) => Promise<ChunkLoopOutcome>,
  payload: Record<string, unknown> = { featureId: 'F-X' },
) {
  setWorkerChunkLoopOpDeps({ runLoop: (fid) => runLoop(fid) });
  const { blueprint } = loadBuiltinBlueprint('worker');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  return runProgramCore({ blueprint, payload, ctx, runOp: inlineRunOp });
}

test('the worker blueprint loads + validates as a gateless deterministic pipeline', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('worker');
  assert.equal(validation.ok, true, `validation errors: ${JSON.stringify(validation.errors)}`);
  assert.equal(blueprint.spine.steps?.length, 1);
  assert.equal(blueprint.spine.steps?.[0]?.op, 'worker:chunk-loop');
  assert.equal(blueprint.spine.steps?.[0]?.bind, 'chunkLoop');
  // No gate ⇒ a deterministic pipeline (not a decision program).
  assert.ok(!blueprint.spine.gate || blueprint.spine.gate.length === 0);
  // Coding hot-path shape: operates on a feature, needs a repo.
  assert.equal(blueprint.workItem.kind, 'feature');
  assert.equal(blueprint.knobs?.requiresRepo, true);
});

test('worker:chunk-loop is a registered known op (validator knownOps)', () => {
  assert.ok(coordOpNames().has('worker:chunk-loop'));
});

test('completed outcome → program done + chunksCommitted bound into scope', async () => {
  const out = await runWorkerProgram(async () => ({ kind: 'completed', chunksCommitted: 3 }));
  assert.equal(out.outcome, 'done');
  assert.equal(out.resolved, true);
  const r = out.scope?.chunkLoop as { outcome: string; chunksCommitted?: number };
  assert.equal(r.outcome, 'completed');
  assert.equal(r.chunksCommitted, 3);
});

test('escalated outcome → faithful chunk id / reason / strikes mapping (program still completes)', async () => {
  const out = await runWorkerProgram(async () => ({
    kind: 'escalated',
    chunk: { id: 'F-X-2', files: ['a.ts'], description: 'add foo' },
    reason: 'typecheck failed 3x',
    strikes: 3,
  }));
  assert.equal(out.outcome, 'done');
  const r = out.scope?.chunkLoop as {
    outcome: string;
    escalatedChunkId?: string;
    reason?: string;
    strikes?: number;
  };
  assert.equal(r.outcome, 'escalated');
  assert.equal(r.escalatedChunkId, 'F-X-2');
  assert.equal(r.reason, 'typecheck failed 3x');
  assert.equal(r.strikes, 3);
});

test('planning_failed outcome → error mapped (a work failure is not a program error)', async () => {
  const out = await runWorkerProgram(async () => ({ kind: 'planning_failed', error: 'unparseable plan' }));
  assert.equal(out.outcome, 'done');
  const r = out.scope?.chunkLoop as { outcome: string; error?: string };
  assert.equal(r.outcome, 'planning_failed');
  assert.equal(r.error, 'unparseable plan');
});

test('aborted outcome → reason mapped (e.g. cross-process lock busy)', async () => {
  const out = await runWorkerProgram(async () => ({ kind: 'aborted', reason: 'lock busy for F-X-1 (held by su-abc)' }));
  assert.equal(out.outcome, 'done');
  const r = out.scope?.chunkLoop as { outcome: string; reason?: string };
  assert.equal(r.outcome, 'aborted');
  assert.equal(r.reason, 'lock busy for F-X-1 (held by su-abc)');
});

test('the op threads payload.featureId to the loop', async () => {
  let seen: string | undefined;
  await runWorkerProgram(
    async (fid) => {
      seen = fid;
      return { kind: 'completed', chunksCommitted: 1 };
    },
    { featureId: 'F-AUTH-007' },
  );
  assert.equal(seen, 'F-AUTH-007');
});

test('a missing featureId rejects at the op arg schema (fail loud, not silent no-op)', async () => {
  setWorkerChunkLoopOpDeps({ runLoop: async () => ({ kind: 'completed', chunksCommitted: 0 }) });
  const { blueprint } = loadBuiltinBlueprint('worker');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  // payload has no featureId → "{{ payload.featureId }}" interpolates to undefined
  // → the op's required featureId arg rejects.
  await assert.rejects(() => runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp }));
});
